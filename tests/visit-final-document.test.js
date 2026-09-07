const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const sqlite3 = require('sqlite3');
const migration = require('../migrations/001_create_visits_schema');
const contactScopeMigration = require('../migrations/002_scope_company_contacts_by_department');

async function fixture(t, blockedStorage = false, registerManual = true, externalCallback, finishManually = true) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'visit-final-auto-'));
  const db = new sqlite3.Database(':memory:');
  const exec = sql => new Promise((resolve, reject) => db.exec(sql, error => error ? reject(error) : resolve()));
  const get = (sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row)));
  await exec("PRAGMA foreign_keys=ON; CREATE TABLE companies(id INTEGER PRIMARY KEY,name TEXT); CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT,role TEXT,active INTEGER); CREATE TABLE tickets(id INTEGER PRIMARY KEY); INSERT INTO companies VALUES(1,'Cliente teste'); INSERT INTO users VALUES(1,'Técnico teste','tecnico',1);" + migration.up + contactScopeMigration.up + "INSERT INTO company_departments(id,company_id,name) VALUES(1,1,'TI'),(2,1,'Administrativo'); INSERT INTO company_contacts(company_id,department_id,contact_type,name,email,job_title) VALUES(1,1,'primary_manager','Gestor','gestor@example.test','Diretor'),(1,2,'primary_manager','Maria','gestor@example.test','Diretora'),(1,2,'substitute','João','sub@example.test','Supervisor');");
  const storageRoot = path.join(directory, 'documents');
  if (blockedStorage) fs.writeFileSync(storageRoot, 'not a directory');
  const state = { messages: [], failManager: false };
  const mailer = { sendMail: async mail => {
    if (mail.attachments && state.failManager && mail.to === 'gestor@example.test') {
      const error = new Error('SENSITIVE-TOKEN-SECRET'); error.status = 503; throw error;
    }
    state.messages.push(mail);
  } };
  const app = express(); app.use(express.json());
  require('../routes/visits')(app, db, { mailer, storageRoot, archiveEmail: 'arquivo@example.test', frontendUrl: 'http://frontend.test' });
  if (registerManual) require('../routes/visit-documents')(app, db, { mailer, storageRoot, archiveEmail: 'arquivo@example.test' });
  require('../routes/visit-validations')(app, db, { mailer, storageRoot, archiveEmail: 'arquivo@example.test', frontendUrl: 'http://frontend.test', finalizeVisit: externalCallback });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => db.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const request = async (url, method = 'GET', body) => {
    const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  const visit = (await request('/api/visits', 'POST', { company_id: 1, technician_id: 1, department_ids: [1, 2] })).body;
  await request('/api/visits/' + visit.id + '/start', 'POST');
  const tokens = [];
  for (const [index, item] of visit.departments.entries()) {
    const url = '/api/visits/' + visit.id + '/departments/' + item.id;
    await request(url, 'PUT', { demand_status: 'sem_demanda' });
    await request(url + '/complete', 'POST');
    const sent = await request(url + '/request-validation', 'POST', { contact_type: index ? 'substitute' : 'primary_manager' });
    assert.equal(sent.body.validation_url, undefined);
    assert.equal(sent.body.token, undefined);
  }
  await request('/api/visits/' + visit.id + '/finish', 'POST');
  for (const message of state.messages.filter(mail => !mail.attachments)) tokens.push(new URL(message.text.match(/https?:\/\/\S+/)[0]).pathname.split('/').pop());
  return { ...state, state, request, visit, get, storageRoot, confirm: index => request('/api/visits/public/validate/' + tokens[index], 'POST', { accepted: true, name: index ? 'João' : 'Gestor' }) };
}

test('finalização fecha a visita antes das validações e o PDF mantém término e duração', async t => {
  const PDFDocument = require('pdfkit');
  const { formatDate, duration } = require('../services/visit-pdf');
  const rendered = [];
  const originalText = PDFDocument.prototype.text;
  t.mock.method(PDFDocument.prototype, 'text', function(value, ...args) {
    rendered.push(String(value));
    return originalText.call(this, value, ...args);
  });
  const f = await fixture(t, false, false, undefined, false);
  const before = await f.get('SELECT * FROM technical_visits WHERE id=?', [f.visit.id]);
  assert.equal(before.status, 'awaiting_validation');
  assert.ok(before.started_at);
  assert.ok(before.finished_at);
  await f.confirm(0);
  assert.equal((await f.get('SELECT finished_at FROM technical_visits WHERE id=?', [f.visit.id])).finished_at, before.finished_at);
  assert.equal((await f.get('SELECT COUNT(*) AS n FROM visit_documents')).n, 0);
  const result = await f.confirm(1);
  assert.equal(result.status, 200);
  assert.equal(result.body.visit_validated, true);
  const after = await f.get('SELECT * FROM technical_visits WHERE id=?', [f.visit.id]);
  assert.equal(after.status, 'validated');
  assert.equal(after.started_at, before.started_at);
  assert.equal(after.finished_at, before.finished_at);
  assert.ok(rendered.includes(formatDate(after.started_at)));
  assert.ok(rendered.includes(formatDate(after.finished_at)));
  assert.ok(rendered.includes(duration(after.started_at, after.finished_at)));
  assert.ok(rendered.includes('João'));
  assert.ok(!rendered.includes('Não disponível'));
  const document = await f.get('SELECT * FROM visit_documents');
  const bytes = fs.readFileSync(path.join(f.storageRoot, document.storage_path));
  assert.equal(bytes.subarray(0, 4).toString(), '%PDF');
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), document.sha256);
  assert.equal((await f.confirm(1)).status, 409);
  assert.equal((await f.get('SELECT finished_at FROM technical_visits WHERE id=?', [f.visit.id])).finished_at, after.finished_at);
  assert.equal((await f.get('SELECT COUNT(*) AS n FROM visit_documents')).n, 1);
});

test('última validação preserva término já registrado pelo fechamento manual', async t => {
  const f = await fixture(t);
  // A distinct historical timestamp makes an accidental overwrite observable.
  await f.get("UPDATE technical_visits SET finished_at='2026-01-02 12:34:56' WHERE id=? RETURNING id", [f.visit.id]);
  await f.confirm(0);
  assert.equal((await f.confirm(1)).status, 200);
  const after = await f.get('SELECT status,finished_at FROM technical_visits WHERE id=?', [f.visit.id]);
  assert.equal(after.status, 'validated');
  assert.equal(after.finished_at, '2026-01-02 12:34:56');
});

test('última validação dispara comprovante mesmo sem endpoint manual registrado nem callback injetado', async t => {
  const logs=[];t.mock.method(console,'info',message=>logs.push(message));
  const f = await fixture(t, false, false);
  assert.equal((await f.confirm(0)).body.visit_validated, false);
  assert.deepEqual(logs,[]);
  assert.equal((await f.get('SELECT COUNT(*) AS n FROM visit_documents')).n, 0);
  const result = await f.confirm(1);
  assert.equal(result.status, 200);
  assert.equal(result.body.visit_validated, true);
  assert.equal((await f.get('SELECT COUNT(*) AS n FROM visit_documents')).n, 1);
  assert.equal((await f.get("SELECT COUNT(*) AS n FROM visit_document_deliveries WHERE status='sent'")).n, 4);
  assert.equal(f.state.messages.filter(mail => mail.attachments).length, 3);
  assert.deepEqual(logs,['ultima validacao detectada','gerando comprovante automatico','comprovante automatico concluido']);
});

test('callback externo não substitui o serviço real no POST público', async t => {
  let called=false;
  const f=await fixture(t,false,false,async()=>{called=true});
  await f.confirm(0);
  const result=await f.confirm(1);
  assert.equal(result.status,200);
  assert.equal(called,false);
  assert.equal((await f.get('SELECT COUNT(*) AS n FROM visit_documents')).n,1);
  assert.equal((await f.get("SELECT COUNT(*) AS n FROM visit_document_deliveries WHERE status='sent'")).n,4);
  const doc=await f.get('SELECT storage_path,sha256 FROM visit_documents');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(f.storageRoot,doc.storage_path))).digest('hex'),doc.sha256);
  assert.equal((await f.get("SELECT COUNT(*) AS n FROM visit_audit_events WHERE event_type='pdf_generated'")).n,1);
  assert.equal((await f.confirm(1)).status,409);
  assert.equal(f.state.messages.filter(mail=>mail.attachments).length,3);
});

test('última validação gera PDF e envia anexo ao gestor e substituto; chamadas repetidas não duplicam', async t => {
  const f = await fixture(t);
  assert.equal((await f.confirm(0)).body.visit_validated, false);
  assert.equal((await f.get('SELECT COUNT(*) AS n FROM visit_documents')).n, 0);
  const final = await f.confirm(1);
  assert.equal(final.status, 200); assert.equal(final.body.visit_validated, true);
  const list = (await f.request('/api/visits/' + f.visit.id + '/documents')).body;
  assert.equal(list.length, 1);
  const doc = list[0], pdf = fs.readFileSync(path.join(f.storageRoot, doc.storage_path));
  assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
  assert.equal(crypto.createHash('sha256').update(pdf).digest('hex'), doc.sha256);
  const mails = f.state.messages.filter(mail => mail.attachments);
  assert.deepEqual(mails.map(mail => mail.to).sort(), ['arquivo@example.test', 'gestor@example.test', 'sub@example.test']);
  assert.ok(mails.every(mail => mail.attachments[0].path.endsWith('.pdf')));
  assert.ok(doc.deliveries.some(d => d.recipient_type === 'primary_manager' && d.status === 'sent'));
  const count = f.state.messages.length;
  await Promise.all([f.request('/api/visits/' + f.visit.id + '/documents/final', 'POST', {}), f.request('/api/visits/' + f.visit.id + '/documents/final', 'POST', {})]);
  assert.equal(f.state.messages.length, count);
  assert.equal((await f.get('SELECT COUNT(*) AS n FROM visit_documents')).n, 1);
  assert.equal((await f.get('SELECT COUNT(*) AS n FROM visit_document_deliveries')).n, 4);
  assert.equal((await f.get("SELECT COUNT(*) AS n FROM visit_audit_events WHERE event_type='pdf_generated'")).n, 1);
  assert.equal((await f.confirm(1)).status, 409);
});

test('falha Graph mantém validação e documento; nova tentativa envia somente entregas falhas', async t => {
  const logs = []; t.mock.method(console, 'error', value => logs.push(value));
  const progress=[];t.mock.method(console,'info',message=>progress.push(message));
  const f = await fixture(t); f.state.failManager = true;
  await f.confirm(0); assert.equal((await f.confirm(1)).status, 200);
  const before = (await f.request('/api/visits/' + f.visit.id + '/documents')).body[0];
  assert.ok(before.deliveries.some(d => d.recipient_type === 'primary_manager' && d.status === 'failed'));
  f.state.failManager = false;
  const retry = await f.request('/api/visits/' + f.visit.id + '/documents/final', 'POST', {});
  assert.equal(retry.status, 200); assert.equal(retry.body.generated, false);
  assert.equal(retry.body.document.sha256, before.sha256);
  assert.ok(retry.body.document.deliveries.every(d => d.status === 'sent'));
  assert.equal(f.state.messages.filter(m => m.attachments && m.to === 'gestor@example.test').length, 1);
  assert.equal(f.state.messages.filter(m => m.attachments && m.to === 'sub@example.test').length, 1);
  assert.ok(logs.length); assert.doesNotMatch(JSON.stringify(logs), /SENSITIVE|TOKEN|SECRET/);
  assert.ok(!progress.includes('comprovante automatico concluido'));
  assert.ok(logs.some(log=>log.message.includes('pendencias registradas para retry')));
  assert.ok(logs.every(log => Object.keys(log).sort().join(',') === 'message,status'));
});

test('falha de geração é registrada com segurança e não desfaz a validação consumida', async t => {
  const logs = []; t.mock.method(console, 'error', value => logs.push(value));
  const f = await fixture(t, true);
  await f.confirm(0); const final = await f.confirm(1);
  assert.equal(final.status, 200); assert.equal(final.body.visit_validated, true);
  assert.equal((await f.get('SELECT status FROM technical_visits WHERE id=?', [f.visit.id])).status, 'validated');
  assert.equal((await f.get('SELECT COUNT(*) AS n FROM visit_documents')).n, 0);
  assert.equal((await f.confirm(1)).status, 409);
  assert.ok(logs.length); assert.ok(logs.every(log => Object.keys(log).sort().join(',') === 'message,status'));
  assert.ok(!JSON.stringify(logs).includes(f.storageRoot));
});
