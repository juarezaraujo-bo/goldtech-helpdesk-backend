require('dotenv').config();
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const root = path.resolve(__dirname, '..');
const dbPath = path.resolve(root, process.env.DB_PATH || 'helpdesk.sqlite');
const db = new sqlite3.Database(dbPath);
const exec = sql => new Promise((resolve, reject) => db.exec(sql, error => error ? reject(error) : resolve()));
const get = (sql, params=[]) => new Promise((resolve, reject) => db.get(sql, params, (error,row) => error ? reject(error) : resolve(row)));
const all = (sql, params=[]) => new Promise((resolve, reject) => db.all(sql, params, (error,rows) => error ? reject(error) : resolve(rows)));
const run = (sql, params=[]) => new Promise((resolve, reject) => db.run(sql, params, function(error){ error ? reject(error) : resolve(this); }));
const close = () => new Promise((resolve,reject) => db.close(error => error ? reject(error) : resolve()));
async function expectConstraint(name, action) {
  try { await action(); } catch (error) {
    if (error.code && error.code.startsWith('SQLITE_CONSTRAINT')) return {name,passed:true};
    throw error;
  }
  throw new Error('Expected constraint failure: ' + name);
}
async function verify() {
  await exec('PRAGMA foreign_keys=ON;');
  const required=['schema_migrations','company_contacts','company_units','company_departments','technical_visits','technical_visit_departments','visit_validation_requests','visit_documents','visit_document_deliveries','visit_audit_events'];
  const tables=await all("SELECT name FROM sqlite_master WHERE type='table'");
  const missing=required.filter(name => !tables.some(row => row.name===name));
  if(missing.length) throw new Error('Missing tables: '+missing.join(','));
  const migration=await get('SELECT id,applied_at FROM schema_migrations WHERE id=?',['001_create_visits_schema']);
  if(!migration) throw new Error('Migration record missing');
  const fkIssues=await all('PRAGMA foreign_key_check');
  if(fkIssues.length) throw new Error('Foreign key issues: '+JSON.stringify(fkIssues));
  const company=await get('SELECT id FROM companies ORDER BY id LIMIT 1');
  const user=await get('SELECT id FROM users ORDER BY id LIMIT 1');
  if(!company||!user) throw new Error('Legacy company/user required');
  await exec('BEGIN;');
  const tests=[];
  try {
    tests.push(await expectConstraint('invalid contact_type',()=>run("INSERT INTO company_contacts(company_id,contact_type,name,email,job_title) VALUES(?,'invalid','T','a@t.test','T')",[company.id])));
    await run("INSERT INTO company_contacts(company_id,contact_type,name,email,job_title) VALUES(?,'primary_manager','G1','g1@t.test','G')",[company.id]);
    tests.push(await expectConstraint('duplicate active primary_manager',()=>run("INSERT INTO company_contacts(company_id,contact_type,name,email,job_title) VALUES(?,'primary_manager','G2','g2@t.test','G')",[company.id])));
    await run("UPDATE company_contacts SET active=0 WHERE company_id=? AND contact_type='primary_manager'",[company.id]);
    await run("INSERT INTO company_contacts(company_id,contact_type,name,email,job_title) VALUES(?,'primary_manager','G2','g2@t.test','G')",[company.id]);
    tests.push({name:'inactive contact allows active replacement',passed:true});
    await run("INSERT INTO company_contacts(company_id,contact_type,name,email,job_title) VALUES(?,'substitute','S1','s1@t.test','S')",[company.id]);
    tests.push(await expectConstraint('duplicate active substitute',()=>run("INSERT INTO company_contacts(company_id,contact_type,name,email,job_title) VALUES(?,'substitute','S2','s2@t.test','S')",[company.id])));
    tests.push(await expectConstraint('invalid visit_type',()=>run("INSERT INTO technical_visits(visit_number,company_id,technician_user_id,visit_type,created_by_user_id) VALUES('TEST-TYPE',?,?,'invalid',?)",[company.id,user.id,user.id])));
    tests.push(await expectConstraint('invalid visit status',()=>run("INSERT INTO technical_visits(visit_number,company_id,technician_user_id,visit_type,status,created_by_user_id) VALUES('TEST-STATUS',?,?,'preventive','invalid',?)",[company.id,user.id,user.id])));
    const unit=await run("INSERT INTO company_units(company_id,name) VALUES(?,'Unit Test')",[company.id]);
    const department=await run("INSERT INTO company_departments(company_id,unit_id,name) VALUES(?,?,'Dept Test')",[company.id,unit.lastID]);
    const visit=await run("INSERT INTO technical_visits(visit_number,company_id,unit_id,technician_user_id,visit_type,created_by_user_id) VALUES('TEST-VALID',?,?,?,'preventive',?)",[company.id,unit.lastID,user.id,user.id]);
    tests.push(await expectConstraint('invalid demand_status',()=>run("INSERT INTO technical_visit_departments(visit_id,department_id,department_name_snapshot,demand_status) VALUES(?,?,'Dept Test','invalid')",[visit.lastID,department.lastID])));
    tests.push(await expectConstraint('missing foreign key',()=>run("INSERT INTO company_contacts(company_id,contact_type,name,email,job_title) VALUES(999999999,'primary_manager','X','x@t.test','X')")));
  } finally { await exec('ROLLBACK;'); }
  const indexes=await all("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  console.log(JSON.stringify({database:dbPath,foreignKeysEnabled:(await get('PRAGMA foreign_keys')).foreign_keys===1,migration,tables:required,indexes:indexes.map(row=>row.name),integrityTests:tests},null,2));
}
verify().then(close).catch(async error=>{console.error('Verification failed:',error.message);await exec('ROLLBACK;').catch(()=>{});await close().catch(()=>{});process.exitCode=1;});
