const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const migration = require('../migrations/001_create_visits_schema');
const contactScopeMigration = require('../migrations/002_scope_company_contacts_by_department');
const registerRoutes = require('../routes/visit-catalogs');
let db, server, baseUrl, tempDir;
const exec = sql => new Promise((resolve,reject)=>db.exec(sql,error=>error?reject(error):resolve()));
const get = (sql,params=[]) => new Promise((resolve,reject)=>db.get(sql,params,(error,row)=>error?reject(error):resolve(row)));
async function request(method,url,body) {
  const response=await fetch(baseUrl+url,{method,headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});
  return {status:response.status,body:await response.json()};
}
test.before(async()=>{
  tempDir=fs.mkdtempSync(path.join(os.tmpdir(),'goldtech-visits-'));
  db=new sqlite3.Database(path.join(tempDir,'test.sqlite'));
  await exec('PRAGMA foreign_keys=ON; CREATE TABLE companies(id INTEGER PRIMARY KEY,name TEXT NOT NULL); CREATE TABLE users(id INTEGER PRIMARY KEY); CREATE TABLE tickets(id INTEGER PRIMARY KEY); INSERT INTO companies VALUES(1,\'A\'),(2,\'B\'); INSERT INTO users VALUES(1); '+migration.up+contactScopeMigration.up+'INSERT INTO company_departments(id,company_id,name) VALUES(1,1,\'Responsáveis A\'),(2,1,\'Responsáveis B\'),(3,2,\'Responsáveis A\');');
  const app=express();app.use(express.json());registerRoutes(app,db);
  await new Promise(resolve=>{server=app.listen(0,'127.0.0.1',resolve)});
  baseUrl='http://127.0.0.1:'+server.address().port;
});
test.after(async()=>{
  await new Promise(resolve=>server.close(resolve));
  await new Promise((resolve,reject)=>db.close(error=>error?reject(error):resolve()));
  fs.rmSync(tempDir,{recursive:true,force:true});
});

test('empresa pode existir sem contatos e responsáveis ficam vinculados ao setor',async()=>{
  assert.deepEqual((await request('GET','/api/visits/managers?companyId=1&departmentId=1')).body,[]);
  const invalid=await request('POST','/api/visits/managers',{company_id:1,department_id:1,contact_type:'primary_manager',name:'Gestor',email:'invalido',job_title:'Diretor'});
  assert.equal(invalid.status,400);
  const first=await request('POST','/api/visits/managers',{company_id:1,department_id:1,contact_type:'primary_manager',name:'Maria',email:'maria@example.com',job_title:'Diretora'});
  assert.equal(first.status,201);
  const duplicate=await request('POST','/api/visits/managers',{company_id:1,department_id:1,contact_type:'primary_manager',name:'Outro',email:'outro@example.com',job_title:'Diretor'});
  assert.equal(duplicate.status,409);
  const otherDepartment=await request('POST','/api/visits/managers',{company_id:1,department_id:2,contact_type:'primary_manager',name:'Carlos',email:'carlos@example.com',job_title:'Gerente'});
  assert.equal(otherDepartment.status,201);
  const substitute=await request('POST','/api/visits/managers',{company_id:1,department_id:1,contact_type:'substitute',name:'Ana',email:'ana@example.com',job_title:'Coordenação'});
  assert.equal(substitute.status,201);
  assert.equal((await request('POST','/api/visits/managers',{company_id:1,department_id:1,contact_type:'substitute',name:'Sub2',email:'sub2@example.com',job_title:'Coordenação'})).status,409);
  assert.equal((await request('POST','/api/visits/managers',{company_id:1,department_id:3,contact_type:'primary_manager',name:'Inválido',email:'invalid@example.com',job_title:'Gerente'})).status,400);
  assert.equal((await request('PUT','/api/visits/managers/'+substitute.body.id,{company_id:2})).status,400);
  const list=await request('GET','/api/visits/managers?companyId=1&departmentId=1');
  assert.equal(list.status,200);assert.equal(list.body.length,2);
});

test('CRUD de unidades mantém vínculo com empresa e usa inativação',async()=>{
  const created=await request('POST','/api/visits/units',{company_id:1,name:'Matriz',address:'Rua A'});
  assert.equal(created.status,201);
  const updated=await request('PUT','/api/visits/units/'+created.body.id,{name:'Matriz Centro',active:0});
  assert.equal(updated.status,200);assert.equal(updated.body.active,0);
  assert.equal((await request('PUT','/api/visits/units/'+created.body.id,{company_id:2})).status,400);
  const list=await request('GET','/api/visits/units?companyId=1');
  assert.equal(list.status,200);assert.equal(list.body.length,1);
});

test('CRUD de setores aceita unidade opcional e rejeita unidade de outra empresa',async()=>{
  const unitA=(await request('POST','/api/visits/units',{company_id:1,name:'Filial A'})).body;
  const unitB=(await request('POST','/api/visits/units',{company_id:2,name:'Filial B'})).body;
  const withoutUnit=await request('POST','/api/visits/departments',{company_id:1,name:'Financeiro',operational_contact_name:'Contato local',operational_contact_email:'local@example.com'});
  assert.equal(withoutUnit.status,201);assert.equal(withoutUnit.body.unit_id,null);
  const withUnit=await request('POST','/api/visits/departments',{company_id:1,unit_id:unitA.id,name:'TI'});
  assert.equal(withUnit.status,201);
  assert.equal((await request('POST','/api/visits/departments',{company_id:1,unit_id:unitB.id,name:'Inválido'})).status,400);
  assert.equal((await request('PUT','/api/visits/departments/'+withUnit.body.id,{unit_id:unitB.id})).status,400);
  const updated=await request('PUT','/api/visits/departments/'+withoutUnit.body.id,{active:0});
  assert.equal(updated.status,200);assert.equal(updated.body.active,0);
  assert.equal((await request('GET','/api/visits/departments?companyId=1')).body.length,4);
  assert.equal((await get('SELECT COUNT(*) AS count FROM company_contacts WHERE email=?',['local@example.com'])).count,0);
});

test('migration preserva contatos legados sem inventar vínculo de setor',async()=>{
  const legacy=new sqlite3.Database(':memory:');
  const legacyExec=sql=>new Promise((resolve,reject)=>legacy.exec(sql,error=>error?reject(error):resolve()));
  const legacyGet=(sql,params=[])=>new Promise((resolve,reject)=>legacy.get(sql,params,(error,row)=>error?reject(error):resolve(row)));
  await legacyExec("PRAGMA foreign_keys=ON;CREATE TABLE companies(id INTEGER PRIMARY KEY,name TEXT);CREATE TABLE users(id INTEGER PRIMARY KEY);CREATE TABLE tickets(id INTEGER PRIMARY KEY);INSERT INTO companies VALUES(1,'Legado');"+migration.up+"INSERT INTO company_departments(id,company_id,name) VALUES(1,1,'TI');INSERT INTO company_contacts(id,company_id,contact_type,name,email,job_title) VALUES(1,1,'primary_manager','Gestor legado','legado@example.com','Diretor');"+contactScopeMigration.up);
  const contact=await legacyGet('SELECT id,company_id,department_id FROM company_contacts WHERE id=1');
  assert.deepEqual(contact,{id:1,company_id:1,department_id:null});
  assert.ok(await legacyGet("SELECT name FROM sqlite_master WHERE type='index' AND name='uq_company_contacts_active_department_type'"));
  await new Promise((resolve,reject)=>legacy.close(error=>error?reject(error):resolve()));
});
