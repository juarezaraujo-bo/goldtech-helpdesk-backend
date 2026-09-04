const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const sqlite3 = require('sqlite3');
const { createApp } = require('../server');
const migration = require('../migrations/001_create_visits_schema');
const { verifyPassword } = require('../services/helpdesk-auth');

async function fixture(t, production = false, envOverrides = {}) {
  const db = new sqlite3.Database(':memory:');
  const exec = sql => new Promise((resolve, reject) => db.exec(sql, error => error ? reject(error) : resolve()));
  const get = (sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row)));
  await exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE companies(id INTEGER PRIMARY KEY,name TEXT,trade_name TEXT,cnpj TEXT,contact_name TEXT,contact_email TEXT,phone TEXT,status TEXT);
    CREATE TABLE users(id INTEGER PRIMARY KEY,company_id INTEGER,name TEXT,email TEXT,username TEXT UNIQUE,password_hash TEXT,role TEXT,active INTEGER DEFAULT 1,department TEXT,updated_at TEXT,reset_token TEXT,reset_token_expires TEXT);
    CREATE TABLE tickets(id INTEGER PRIMARY KEY,company_id INTEGER,opened_by_user_id INTEGER,ticket_number TEXT,title TEXT,description TEXT,category TEXT,priority TEXT,sla_deadline TEXT,assigned_technician_id INTEGER,status TEXT,is_auto_assigned INTEGER,created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT,closed_at TEXT);
    CREATE TABLE ticket_interactions(id INTEGER PRIMARY KEY,ticket_id INTEGER,user_id INTEGER,message TEXT,interaction_type TEXT,visible_to_client INTEGER,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE notifications(id INTEGER PRIMARY KEY,user_id INTEGER,ticket_id INTEGER,type TEXT,message TEXT,read INTEGER DEFAULT 0,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    INSERT INTO companies(id,name) VALUES(1,'Cliente'),(2,'Outra empresa');
    INSERT INTO users(id,company_id,name,email,username,password_hash,role) VALUES
      (1,1,'Admin','admin@example.test','admin','legacy-pass','admin_goldtech'),
      (2,1,'Tecnico','tech@example.test','tech','legacy-pass','tecnico'),
      (3,1,'Cliente','client@example.test','client','legacy-pass','cliente_usuario'),
      (4,1,'Gestor','manager@example.test','manager','legacy-pass','cliente_gestor'),
      (5,2,'Outro','other@example.test','other','legacy-pass','cliente_usuario');
  ` + migration.up);
  let current = Date.now();
  const env = { NODE_ENV: production ? 'production' : 'test', FRONTEND_URL: production ? 'https://helpdesk.example.test' : 'http://localhost:5173', SESSION_TTL_MS: '1000' };
  Object.assign(env, envOverrides);
  const resetEmails = [];
  const app = createApp(db, { env, now: () => current, sendResetEmail: async (email, link) => { resetEmails.push({ email, link }); } });
  const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await new Promise(resolve => db.close(resolve)); });
  const request = async (url, { method = 'GET', body, cookie, headers = {} } = {}) => {
    const response = await fetch('http://127.0.0.1:' + server.address().port + url, {
      method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
  };
  const login = async (username = 'admin', cookie) => {
    const response = await request('/api/login', { method: 'POST', body: { username, password: 'legacy-pass' }, cookie });
    assert.equal(response.status, 200);
    return { ...response, cookie: response.headers.get('set-cookie').split(';')[0] };
  };
  return { db, exec, get, request, login, resetEmails, port: server.address().port, advance: ms => { current += ms; } };
}

test('login existente cria cookie HttpOnly e sessão sem expor credenciais; rotação rejeita cookie antigo', async t => {
  const f = await fixture(t);
  const first = await f.login();
  assert.match(first.headers.get('set-cookie'), /HttpOnly/);
  assert.match(first.headers.get('set-cookie'), /SameSite=Lax/);
  assert.match(first.headers.get('set-cookie'), /Path=\//);
  assert.equal(first.body.user.password_hash, undefined);
  assert.equal((await f.get('SELECT password_hash FROM users WHERE id=1')).password_hash, 'legacy-pass');
  assert.equal((await f.request('/api/auth/me', { cookie: first.cookie })).body.user.id, 1);
  const second = await f.login('admin', first.cookie);
  assert.notEqual(first.cookie, second.cookie);
  assert.equal((await f.request('/api/visits', { cookie: first.cookie })).status, 401);
  assert.equal((await f.request('/api/visits', { cookie: second.cookie })).status, 200);
});

test('todas as rotas administrativas de visitas e usuários exigem sessão', async t => {
  const f = await fixture(t);
  for (const [method, url] of [
    ['GET','/api/visits'],['POST','/api/visits'],['GET','/api/visits/1'],['POST','/api/visits/1/start'],
    ['PUT','/api/visits/1/departments/1'],['POST','/api/visits/1/departments/1/complete'],['POST','/api/visits/1/finish'],
    ['POST','/api/visits/1/departments/1/request-validation'],['GET','/api/visits/1/documents'],['POST','/api/visits/1/documents/final'],
    ...['managers','units','departments'].flatMap(name => [['GET','/api/visits/'+name],['POST','/api/visits/'+name],['PUT','/api/visits/'+name+'/1']]),
    ['GET','/api/users'],['POST','/api/users'],['PUT','/api/users/1'],['PUT','/api/users/1/password']
  ]) assert.equal((await f.request(url, { method, body: method === 'GET' ? undefined : {} })).status, 401, method + ' ' + url);
  assert.equal((await f.request('/api/visits', { cookie: 'goldtech_session=forged', headers: { 'X-User-Id': '1', Authorization: 'Bearer admin' } })).status, 401);
});

test('perfis sem permissão recebem 403 e não podem elevar administradores', async t => {
  const f = await fixture(t);
  for (const username of ['client', 'manager']) {
    const { cookie } = await f.login(username);
    assert.equal((await f.request('/api/visits', { cookie })).status, 403);
    assert.equal((await f.request('/api/users/3', { method: 'PUT', cookie, body: { role: 'admin_goldtech' } })).status, 403);
    assert.equal((await f.request('/api/users', { method: 'POST', cookie, body: { role: 'admin_goldtech', password_hash: 'new-pass' } })).status, 403);
  }
  const { cookie } = await f.login('tech');
  assert.equal((await f.request('/api/visits', { cookie })).status, 200);
  assert.equal((await f.request('/api/users/1/password', { method: 'PUT', cookie, body: { password: 'new-pass' } })).status, 403);
});

test('admin gerencia usuários e novas senhas são hash; alteração revoga sessão anterior', async t => {
  const f = await fixture(t);
  const { cookie } = await f.login();
  const client = await f.login('client');
  const created = await f.request('/api/users', { method: 'POST', cookie, body: { name: 'Novo', username: 'novo', email: 'novo@example.test', company_id: 1, role: 'admin_goldtech', password_hash: 'new-pass' } });
  assert.equal(created.status, 201);
  const stored = (await f.get('SELECT password_hash FROM users WHERE id=?', [created.body.id])).password_hash;
  assert.match(stored, /^scrypt\$/);
  assert.ok(await verifyPassword('new-pass', stored));
  assert.equal((await f.request('/api/login', { method: 'POST', body: { username: 'novo', password: 'new-pass' } })).status, 200);
  assert.equal((await f.request('/api/users/3/password', { method: 'PUT', cookie, body: { password: 'changed-pass' } })).status, 200);
  assert.equal((await f.request('/api/auth/me', { cookie: client.cookie })).status, 401);
  assert.equal((await f.request('/api/users/3', { method: 'PUT', cookie, body: { role: 'tecnico' } })).status, 200);
});

test('gestor só gerencia perfis de cliente da própria empresa; filtro não é confiado ao browser', async t => {
  const f = await fixture(t);
  const { cookie } = await f.login('manager');
  const list = await f.request('/api/users?companyId=2', { cookie });
  assert.ok(list.body.every(user => user.company_id === 1));
  for (const id of [1,2,5]) assert.equal((await f.request('/api/users/'+id+'/password', { method: 'PUT', cookie, body: { password: 'new-pass' } })).status, 403);
  assert.equal((await f.request('/api/users/3', { method: 'PUT', cookie, body: { company_id: 2 } })).status, 403);
  assert.equal((await f.request('/api/users/3/password', { method: 'PUT', cookie, body: { password: 'new-pass' } })).status, 200);
});

test('admin percorre cadastros e operação de visita com sessão e POST sem corpo como o frontend', async t => {
  const f = await fixture(t); const { cookie } = await f.login();
  for (const contact_type of ['primary_manager', 'substitute']) {
    assert.equal((await f.request('/api/visits/managers', { method: 'POST', cookie, body: { company_id: 1, contact_type, name: 'Gestor', email: contact_type+'@example.test', job_title: 'Gestor' } })).status, 201);
  }
  const unit = await f.request('/api/visits/units', { method: 'POST', cookie, body: { company_id: 1, name: 'Matriz' } });
  assert.equal(unit.status, 201);
  const sector = await f.request('/api/visits/departments', { method: 'POST', cookie, body: { company_id: 1, unit_id: unit.body.id, name: 'TI' } });
  assert.equal(sector.status, 201);
  const created = await f.request('/api/visits', { method: 'POST', cookie, body: { company_id: 1, technician_id: 2, created_by_user_id: 5, unit_id: unit.body.id, department_ids: [sector.body.id] } });
  assert.equal(created.status, 201);
  assert.equal(created.body.created_by_user_id, 1);
  const url = '/api/visits/' + created.body.id;
  const postEmpty = async endpoint => {
    const result = await fetch('http://127.0.0.1:' + f.port + endpoint, { method: 'POST', headers: { Cookie: cookie, Origin: 'http://localhost:5173' } });
    assert.equal(result.status, 200);
  };
  await postEmpty(url + '/start');
  const item = created.body.departments[0];
  assert.equal((await f.request(url+'/departments/'+item.id, { method: 'PUT', cookie, body: { demand_status: 'sem_demanda' } })).status, 200);
  await postEmpty(url+'/departments/'+item.id+'/complete');
  await postEmpty(url+'/finish');
  assert.equal((await f.request(url, { cookie })).body.status, 'awaiting_validation');
  assert.equal((await f.request(url+'/documents', { cookie })).status, 200);
});

test('logout invalida sessão no servidor; expiração e desativação retornam 401', async t => {
  const f = await fixture(t);
  const first = await f.login();
  assert.equal((await f.request('/api/auth/logout', { method: 'POST', cookie: first.cookie, body: {} })).status, 200);
  assert.equal((await f.request('/api/auth/me', { cookie: first.cookie })).status, 401);
  assert.equal((await f.request('/api/auth/logout', { method: 'POST', cookie: first.cookie, body: {} })).status, 401);
  const second = await f.login(); f.advance(1001);
  assert.equal((await f.request('/api/visits', { cookie: second.cookie })).status, 401);
  const third = await f.login(); await f.exec('UPDATE users SET active=0 WHERE id=1');
  assert.equal((await f.request('/api/visits', { cookie: third.cookie })).status, 401);
});

test('produção usa Secure, restringe CORS e bloqueia CSRF antes de mutações', async t => {
  const f = await fixture(t, true);
  const { cookie, headers } = await f.login();
  assert.match(headers.get('set-cookie'), /__Host-goldtech_session=/);
  assert.match(headers.get('set-cookie'), /; Secure/);
  assert.doesNotMatch(headers.get('set-cookie'), /Domain=/);
  for (const origin of ['https://evil.test','http://localhost:5173','null']) {
    assert.equal((await f.request('/api/users/3/password', { method: 'PUT', cookie, headers: { Origin: origin }, body: { password: 'evil-pass' } })).status, 403);
  }
  const response = await f.request('/api/visits', { cookie, headers: { Origin: 'https://helpdesk.example.test' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://helpdesk.example.test');
  assert.equal((await f.request('/api/login', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: {} })).status, 415);
});

test('GET e POST públicos por token continuam funcionando sem cookie na aplicação real', async t => {
  const f = await fixture(t);
  const token = crypto.randomBytes(32).toString('hex');
  await f.exec(`INSERT INTO company_contacts(id,company_id,contact_type,name,email,job_title) VALUES(1,1,'primary_manager','Gestor','gestor@example.test','Diretor');
    INSERT INTO company_departments(id,company_id,name) VALUES(1,1,'TI'),(2,1,'Outro');
    INSERT INTO technical_visits(id,visit_number,company_id,technician_user_id,visit_type,status,started_at,created_by_user_id) VALUES(1,'VIS-SEC',1,2,'preventive','in_progress',CURRENT_TIMESTAMP,2);
    INSERT INTO technical_visit_departments(id,visit_id,department_id,department_name_snapshot,demand_status,completed_at,validation_status) VALUES(1,1,1,'TI','sem_demanda',CURRENT_TIMESTAMP,'pending'),(2,1,2,'Outro','sem_demanda',CURRENT_TIMESTAMP,'pending');
    INSERT INTO visit_validation_requests(visit_department_id,contact_id,contact_type_snapshot,recipient_name,recipient_email,recipient_job_title,token_hash,status,expires_at,protocol)
      VALUES(1,1,'primary_manager','Gestor','gestor@example.test','Diretor','${crypto.createHash('sha256').update(token).digest('hex')}','sent',datetime('now','+1 day'),'VAL-SEC');`);
  const url = '/api/visits/public/validate/' + token;
  assert.equal((await f.request(url)).status, 200);
  const result = await f.request(url, { method: 'POST', body: { accepted: true, name: 'Gestor' } });
  assert.equal(result.status, 200); assert.equal(result.body.protocol, 'VAL-SEC');
  assert.equal(result.body.visit_validated, false);
  assert.equal((await f.request(url)).status, 409);
});

test('recuperação exige token válido de uso único e invalida a sessão anterior', async t => {
  const f = await fixture(t); const { cookie } = await f.login();
  const token = crypto.randomBytes(32).toString('hex');
  await f.exec(`UPDATE users SET reset_token='${token}',reset_token_expires=datetime('now','+1 day') WHERE id=1`);
  const body = { token, password: 'reset-pass' };
  assert.equal((await f.request('/api/auth/reset-password', { method: 'POST', body })).status, 200);
  assert.equal((await f.request('/api/auth/reset-password', { method: 'POST', body })).status, 400);
  assert.equal((await f.request('/api/auth/me', { cookie })).status, 401);
  assert.equal((await f.request('/api/login', { method: 'POST', body: { username: 'admin', password: 'reset-pass' } })).status, 200);
});

test('erro interno não expõe SQL ou stack em rota sensível', async t => {
  const f = await fixture(t); const { cookie } = await f.login();
  await f.exec('DROP TABLE company_units');
  const result = await f.request('/api/visits/units?companyId=1', { cookie });
  assert.equal(result.status, 500);
  assert.doesNotMatch(JSON.stringify(result.body), /SQLITE|SELECT|stack|company_units/);
});

test('integração converte client_id e prioridades usando autor definido pelo servidor', async t => {
  const token = crypto.randomBytes(32).toString('hex');
  const f = await fixture(t, false, { HELPDESK_API_TOKEN: token, HELPDESK_SYSTEM_USER_ID: '2' });
  const headers = { Authorization: 'Bearer ' + token };
  for (const priority of ['critical', 'HIGH', 'medium', 'LoW', 'Critical']) {
    const result = await f.request('/api/tickets', { method: 'POST', headers,
      body: { source: 'inventory', client_id: 2, title: 'Monitor test', priority } });
    assert.equal(result.status, 201);
    const row = await f.get('SELECT company_id,opened_by_user_id,priority FROM tickets WHERE id=?', [result.body.id]);
    assert.equal(row.company_id, 2);
    assert.equal(row.opened_by_user_id, 2);
    assert.equal(row.priority, priority[0].toUpperCase() + priority.slice(1).toLowerCase());
  }
  const explicit = await f.request('/api/tickets', { method: 'POST', headers,
    body: { source: 'inventory', client_id: 2, company_id: 1, title: 'Explicit company' } });
  assert.equal(explicit.status, 201);
  assert.equal((await f.get('SELECT company_id FROM tickets WHERE id=?', [explicit.body.id])).company_id, 1);
  const forged = await f.request('/api/tickets', { method: 'POST', headers,
    body: { source: 'inventory', client_id: 2, title: 'Forged author', opened_by_user_id: 1 } });
  assert.equal(forged.status, 403);
  const missing = await f.request('/api/tickets', { method: 'POST', headers,
    body: { source: 'inventory', client_id: 999, title: 'Missing company' } });
  assert.equal(missing.status, 400);
  assert.equal((await f.get('SELECT COUNT(*) AS count FROM tickets')).count, 6);
});

test('integração falha fechada sem configuração, token válido, Bearer ou source', async t => {
  const token = crypto.randomBytes(32).toString('hex');
  const f = await fixture(t, false, { HELPDESK_API_TOKEN: token, HELPDESK_SYSTEM_USER_ID: '2' });
  const body = { source: 'inventory', client_id: 1, title: 'Monitor test' };
  for (const authorization of [undefined, token, 'Basic ' + token, 'Bearer invalid', 'Bearer ' + '0'.repeat(64), 'Bearer']) {
    const headers = authorization ? { Authorization: authorization } : {};
    assert.equal((await f.request('/api/tickets', { method: 'POST', headers, body })).status, 401);
  }
  assert.equal((await f.request('/api/tickets', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: { client_id: 1, title: 'No source' } })).status, 401);
  const unconfigured = await fixture(t);
  assert.equal((await unconfigured.request('/api/tickets', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body })).status, 401);
  assert.equal((await f.get('SELECT COUNT(*) AS count FROM tickets')).count, 0);
});

test('token de integração não autentica outras rotas ou métodos', async t => {
  const token = crypto.randomBytes(32).toString('hex');
  const f = await fixture(t, false, { HELPDESK_API_TOKEN: token, HELPDESK_SYSTEM_USER_ID: '2' });
  for (const [method, url] of [
    ['GET', '/api/tickets'], ['GET', '/api/tickets/1'], ['PUT', '/api/tickets/1'],
    ['GET', '/api/tickets/1/interactions'], ['POST', '/api/tickets/1/interactions'],
    ['GET', '/api/users'], ['POST', '/api/users'], ['GET', '/api/companies'],
    ['POST', '/api/companies'], ['GET', '/api/visits'], ['POST', '/api/visits']
  ]) {
    const result = await f.request(url, { method, headers: { Authorization: 'Bearer ' + token },
      body: method === 'GET' ? undefined : { source: 'inventory', client_id: 1 } });
    assert.equal(result.status, 401, method + ' ' + url);
  }
});

test('compatibilidade da integração não normaliza dados de sessão nem amplia empresa do cliente', async t => {
  const f = await fixture(t);
  const { cookie } = await f.login('client');
  const result = await f.request('/api/tickets', { method: 'POST', cookie,
    body: { client_id: 2, title: 'Session test', priority: 'critical' } });
  assert.equal(result.status, 201);
  const row = await f.get('SELECT company_id,opened_by_user_id,priority FROM tickets WHERE id=?', [result.body.id]);
  assert.deepEqual(row, { company_id: 1, opened_by_user_id: 3, priority: 'critical' });
});

async function ticketFixture(t) {
  const f = await fixture(t);
  await f.exec(`INSERT INTO tickets(id,company_id,opened_by_user_id,ticket_number,title,status,priority,assigned_technician_id) VALUES
    (1,1,3,'GT-1','Empresa 1','Open','Low',2),(2,2,5,'GT-2','Empresa 2','Open','Low',2);
    INSERT INTO ticket_interactions(ticket_id,user_id,message,interaction_type,visible_to_client) VALUES
    (1,2,'Public','message',1),(1,2,'Internal','internal_note',0),(1,2,'Malformed old internal','internal_note',1);
    INSERT INTO notifications(id,user_id,message) VALUES(1,3,'Client'),(2,5,'Other'),(3,1,'Admin');`);
  return f;
}

test('tickets, interações, notificações, empresas e workload exigem sessão', async t => {
  const f = await ticketFixture(t);
  for (const [method,url] of [['GET','/api/tickets'],['GET','/api/tickets/1'],['POST','/api/tickets'],['PUT','/api/tickets/1'],['GET','/api/tickets/1/interactions'],['POST','/api/tickets/1/interactions'],['GET','/api/notifications'],['PUT','/api/notifications/1/read'],['GET','/api/companies'],['GET','/api/technicians/workload']]) {
    assert.equal((await f.request(url,{method,body:method==='GET'?undefined:{}})).status,401,url);
  }
});

test('cliente não enumera chamados/empresas nem falsifica perfil pela query; workload é interno', async t => {
  const f = await ticketFixture(t);
  for (const name of ['client','manager']) {
    const { cookie } = await f.login(name);
    const list = await f.request('/api/tickets?role=admin_goldtech&userId=1&companyId=2',{cookie});
    assert.equal(list.status,200); assert.deepEqual(list.body.map(row=>row.id),[1]);
    for (const url of ['/api/tickets/2?role=admin_goldtech&companyId=2','/api/tickets/2/interactions']) assert.equal((await f.request(url,{cookie})).status,404);
    assert.equal((await f.request('/api/tickets/2/interactions',{cookie,method:'POST',body:{message:'Forged'}})).status,404);
    assert.deepEqual((await f.request('/api/companies?companyId=2',{cookie})).body.map(row=>row.id),[1]);
    assert.equal((await f.request('/api/technicians/workload',{cookie})).status,403);
    assert.equal((await f.request('/api/tickets/1',{cookie,method:'PUT',body:{assigned_technician_id:3}})).status,403);
  }
});

test('criação usa identidade da sessão e rejeita empresa, autor e técnico forjados', async t => {
  const f = await ticketFixture(t); const { cookie } = await f.login('client');
  for (const forged of [{company_id:2},{opened_by_user_id:1},{assigned_technician_id:2}]) {
    assert.equal((await f.request('/api/tickets',{cookie,method:'POST',body:{title:'Test',...forged}})).status,403);
  }
  const result = await f.request('/api/tickets?companyId=2&userId=1&profile=admin_goldtech',{cookie,method:'POST',body:{title:'Test',description:'Description',priority:'Low',companyId:2,userId:1,profile:'admin_goldtech'}});
  assert.equal(result.status,201);
  const row = await f.get('SELECT * FROM tickets WHERE id=?',[result.body.id]);
  assert.equal(row.company_id,1); assert.equal(row.opened_by_user_id,3); assert.equal(row.assigned_technician_id,2);
});

test('técnico e admin mantêm acesso operacional, autoria própria e atribuição apenas interna', async t => {
  const f = await ticketFixture(t);
  for (const [username,id] of [['tech',2],['admin',1]]) {
    const { cookie } = await f.login(username);
    assert.equal((await f.request('/api/tickets',{cookie})).body.length>=2,true);
    assert.equal((await f.request('/api/tickets/2',{cookie})).status,200);
    assert.equal((await f.request('/api/companies',{cookie})).body.length,2);
    assert.equal((await f.request('/api/technicians/workload',{cookie})).status,200);
    assert.equal((await f.request('/api/tickets/2',{cookie,method:'PUT',body:{status:'In Progress',assigned_technician_id:id}})).status,200);
    assert.equal((await f.request('/api/tickets/2',{cookie,method:'PUT',body:{assigned_technician_id:3}})).status,400);
    const created=await f.request('/api/tickets',{cookie,method:'POST',body:{company_id:2,title:'Staff test',assigned_technician_id:2}});
    assert.equal(created.status,201);
    assert.equal((await f.get('SELECT opened_by_user_id FROM tickets WHERE id=?',[created.body.id])).opened_by_user_id,id);
  }
});

test('interações isolam notas internas e rejeitam autor/visibilidade forjados', async t => {
  const f = await ticketFixture(t); const client=await f.login('client'),tech=await f.login('tech');
  assert.equal((await f.request('/api/tickets/1/interactions',{cookie:client.cookie})).body.length,1);
  assert.equal((await f.request('/api/tickets/1/interactions',{cookie:tech.cookie})).body.length,3);
  for(const body of [{user_id:2,message:'Forged'},{message:'Forged',visible_to_client:0},{message:'Forged',interaction_type:'internal_note'}]) {
    assert.equal((await f.request('/api/tickets/1/interactions',{cookie:client.cookie,method:'POST',body})).status,403);
  }
  const created=await f.request('/api/tickets/1/interactions',{cookie:client.cookie,method:'POST',body:{message:'Reply',userId:2}});
  assert.equal(created.status,201);
  const row=await f.get('SELECT * FROM ticket_interactions WHERE id=?',[created.body.id]);
  assert.equal(row.user_id,3);assert.equal(row.visible_to_client,1);assert.equal(row.interaction_type,'message');
  const note=await f.request('/api/tickets/1/interactions',{cookie:tech.cookie,method:'POST',body:{message:'Private',interaction_type:'internal_note',visible_to_client:1}});
  assert.equal(note.status,201);
  assert.equal((await f.get('SELECT visible_to_client FROM ticket_interactions WHERE id=?',[note.body.id])).visible_to_client,0);
});

test('notificações são individuais inclusive para administradores', async t => {
  const f=await ticketFixture(t);
  for(const [username,ownId] of [['client',1],['admin',3]]) {
    const {cookie}=await f.login(username);
    assert.deepEqual((await f.request('/api/notifications?userId=5',{cookie})).body.map(row=>row.id),[ownId]);
    assert.equal((await f.request('/api/notifications/2/read',{cookie,method:'PUT',body:{userId:5}})).status,404);
    assert.equal((await f.request('/api/notifications/'+ownId+'/read',{cookie,method:'PUT',body:{}})).status,200);
  }
  assert.equal((await f.get('SELECT read FROM notifications WHERE id=2')).read,0);
});

test('recuperação limita conta normalizada e IP sem enumerar contas ou confiar em X-Forwarded-For', async t => {
  const f=await fixture(t);
  const lookups=[]; const original=f.db.get.bind(f.db);
  t.mock.method(f.db,'get',function(sql,...args){if(sql.includes('LOWER(TRIM(email))'))lookups.push(args[0][0]);return original(sql,...args);});
  const safe={message:'Se o e-mail estiver cadastrado, enviaremos as instruções de recuperação.'};
  let expectedDeliveries=0;
  const send=async(email,ip='203.0.113.1')=>{
    const before=lookups.length;
    const result=await f.request('/api/auth/forgot-password',{method:'POST',body:{email},headers:{'X-Forwarded-For':ip}});
    assert.equal(result.status,200);assert.deepEqual(result.body,safe);
    // The HTTP response intentionally precedes lookup/update/delivery. Wait for
    // the observable mail completion, not unrelated parallel SQLite callbacks.
    if(lookups.length>before && email.trim().toLowerCase()==='client@example.test') {
      expectedDeliveries++;
      const deadline=Date.now()+2000;
      while(f.resetEmails.length<expectedDeliveries && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,5));
      assert.equal(f.resetEmails.length,expectedDeliveries);
    }
  };
  for(let i=0;i<6;i++)await send(i%2?' CLIENT@example.test ':'client@example.test','203.0.113.'+(i+1));
  assert.equal(lookups.length,5);assert.equal(f.resetEmails.length,5);
  for(let i=0;i<16;i++)await send('missing'+i+'@example.test','198.51.100.'+i);
  assert.equal(lookups.length,19); // 6 account attempts consumed 6 of 20 IP slots.
  assert.equal(f.resetEmails.length,5);
  await send('unknown@example.test');await send('');
  assert.equal(lookups.length,19);
  f.advance(15*60*1000+1);await send('client@example.test');
  assert.equal(f.resetEmails.length,6);
});

test('webhook fica desabilitado em produção antes de qualquer acesso ao banco', async t => {
  const f=await fixture(t,true);
  const result=await f.request('/api/whatsapp/webhook',{method:'POST',body:{phone:'000',message:'abrir chamado'}});
  assert.equal(result.status,404);
  assert.equal((await f.get('SELECT COUNT(*) AS count FROM tickets')).count,0);
});

test('erros das rotas legadas alteradas não expõem SQL nem detalhes internos', async t => {
  const f=await ticketFixture(t);const {cookie}=await f.login();
  await f.exec('DROP TABLE notifications; DROP TABLE ticket_interactions;');
  for(const url of ['/api/notifications','/api/tickets/1/interactions']) {
    const result=await f.request(url,{cookie});assert.equal(result.status,500);
    assert.deepEqual(result.body,{error:'Não foi possível processar a solicitação.'});
  }
  await f.exec('DROP TABLE tickets');
  for(const url of ['/api/tickets','/api/technicians/workload']) {
    const result=await f.request(url,{cookie});assert.equal(result.status,500);
    assert.doesNotMatch(JSON.stringify(result.body),/SQLITE|SELECT|stack|tickets/);
  }
});

test('inicialização em produção não cria seeds mesmo com ENABLE_DEV_SEED=true', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-security-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'test.sqlite');
  const script = `const db=require('./database');setTimeout(()=>db.all('SELECT username FROM users',(error,rows)=>{if(error)throw error;console.log('SEED_RESULT:'+JSON.stringify(rows));db.close()}),1400);`;
  const { stdout } = await promisify(execFile)(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..'), env: { ...process.env, NODE_ENV: 'production', ENABLE_DEV_SEED: 'true', DB_PATH: dbPath } });
  assert.match(stdout, /SEED_RESULT:\[\]/);
});
