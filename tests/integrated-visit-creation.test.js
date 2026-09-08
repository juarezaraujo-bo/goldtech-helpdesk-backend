const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const baseMigration = require('../migrations/001_create_visits_schema');
const contactMigration = require('../migrations/002_scope_company_contacts_by_department');
const architectureMigration = require('../migrations/003_add_service_orders_and_ticket_visit_documents');
const { createIntegratedVisit } = require('../services/integrated-visit-creation');

const openDatabase = () => new sqlite3.Database(':memory:');
const exec = (db, sql) => new Promise((resolve, reject) => db.exec(sql, error => error ? reject(error) : resolve()));
const get = (db, sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row)));
const all = (db, sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows)));
const close = db => new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));

async function fixture() {
  const db = openDatabase();
  await exec(db, `
    PRAGMA foreign_keys=ON;
    CREATE TABLE companies(id INTEGER PRIMARY KEY,name TEXT NOT NULL);
    CREATE TABLE users(id INTEGER PRIMARY KEY,company_id INTEGER,name TEXT NOT NULL,role TEXT NOT NULL,active INTEGER NOT NULL);
    CREATE TABLE tickets(
      id INTEGER PRIMARY KEY AUTOINCREMENT,company_id INTEGER NOT NULL,opened_by_user_id INTEGER NOT NULL,
      assigned_technician_id INTEGER,ticket_number TEXT UNIQUE NOT NULL,title TEXT NOT NULL,description TEXT,
      category TEXT,priority TEXT,status TEXT,sla_deadline DATETIME,is_auto_assigned INTEGER DEFAULT 0,
      origin TEXT DEFAULT 'web',created_at DATETIME DEFAULT CURRENT_TIMESTAMP,updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      closed_at DATETIME,FOREIGN KEY(company_id) REFERENCES companies(id),FOREIGN KEY(opened_by_user_id) REFERENCES users(id),
      FOREIGN KEY(assigned_technician_id) REFERENCES users(id)
    );
    INSERT INTO companies VALUES(1,'Cliente A'),(2,'Cliente B');
    INSERT INTO users VALUES(1,NULL,'Administrador','admin_goldtech',1),(2,NULL,'Técnico','tecnico',1);
    ${baseMigration.up}
    ${contactMigration.up}
    ${architectureMigration.up}
    INSERT INTO company_units(id,company_id,name) VALUES(1,1,'Matriz');
    INSERT INTO company_departments(id,company_id,unit_id,name) VALUES(1,1,1,'TI'),(2,1,1,'Financeiro'),(3,2,NULL,'Outro');
  `);
  return db;
}

test('criação manual grava chamado, O.S., visita e setores na mesma empresa', async () => {
  const db = await fixture();
  try {
    const result = await createIntegratedVisit(db, {
      mode: 'manual_visit', company_id: 1, created_by_user_id: 1,
      ticket: { title: 'Atendimento presencial', priority: 'High', assigned_technician_id: 2 },
      service_order: { description: 'Atendimento local' },
      visit: { unit_id: 1, technician_user_id: 2, visit_type: 'ticket', department_ids: [1, 2] }
    });
    const row = await get(db, `
      SELECT t.company_id AS ticket_company,so.ticket_id AS order_ticket,v.company_id AS visit_company,
             v.ticket_id AS visit_ticket,v.service_order_id,v.technician_user_id
      FROM tickets t JOIN service_orders so ON so.ticket_id=t.id JOIN technical_visits v ON v.service_order_id=so.id
      WHERE t.id=?
    `, [result.ticket.id]);
    assert.equal(row.ticket_company, 1);
    assert.equal(row.visit_company, 1);
    assert.equal(row.order_ticket, result.ticket.id);
    assert.equal(row.visit_ticket, result.ticket.id);
    assert.equal(row.service_order_id, result.service_order.id);
    assert.equal(row.technician_user_id, 2);
    assert.equal((await get(db, 'SELECT COUNT(*) AS count FROM technical_visit_departments WHERE visit_id=?', [result.visit.id])).count, 2);
  } finally { await close(db); }
});

test('automação de chamado cria visita draft sem técnico, unidade ou setores', async () => {
  const db = await fixture();
  try {
    const result = await createIntegratedVisit(db, {
      mode: 'ticket_automation', company_id: 1, created_by_user_id: 1,
      ticket: { title: 'Chamado do cliente', description: 'Necessita atendimento presencial' },
      visit: {}
    });
    const visit = await get(db, 'SELECT * FROM technical_visits WHERE id=?', [result.visit.id]);
    const order = await get(db, 'SELECT * FROM service_orders WHERE id=?', [result.service_order.id]);
    assert.equal(visit.status, 'draft');
    assert.equal(visit.technician_user_id, null);
    assert.equal(visit.unit_id, null);
    assert.equal(order.assigned_technician_id, null);
    assert.equal((await get(db, 'SELECT COUNT(*) AS count FROM technical_visit_departments WHERE visit_id=?', [result.visit.id])).count, 0);
  } finally { await close(db); }
});

test('falha ao criar visita desfaz chamado e O.S. integralmente', async () => {
  const db = await fixture();
  try {
    await exec(db, "CREATE TRIGGER fail_integrated_visit BEFORE INSERT ON technical_visits BEGIN SELECT RAISE(ABORT,'forced visit failure'); END;");
    await assert.rejects(createIntegratedVisit(db, {
      mode: 'ticket_automation', company_id: 1, created_by_user_id: 1,
      ticket: { title: 'Deve sofrer rollback' }, visit: {}
    }), /forced visit failure/);
    assert.equal((await get(db, 'SELECT COUNT(*) AS count FROM tickets')).count, 0);
    assert.equal((await get(db, 'SELECT COUNT(*) AS count FROM service_orders')).count, 0);
    assert.equal((await get(db, 'SELECT COUNT(*) AS count FROM technical_visits')).count, 0);
  } finally { await close(db); }
});

test('vínculos ticket_id e service_order_id permanecem consistentes e números não colidem', async () => {
  const db = await fixture();
  try {
    const first = await createIntegratedVisit(db, { mode: 'ticket_automation', company_id: 1, created_by_user_id: 1, ticket: { title: 'Primeiro' }, visit: {} });
    const second = await createIntegratedVisit(db, { mode: 'ticket_automation', company_id: 1, created_by_user_id: 1, ticket: { title: 'Segundo' }, visit: {} });
    assert.notEqual(first.ticket.ticket_number, second.ticket.ticket_number);
    assert.notEqual(first.service_order.order_number, second.service_order.order_number);
    const rows = await all(db, `
      SELECT v.ticket_id,v.service_order_id,so.ticket_id AS order_ticket_id
      FROM technical_visits v JOIN service_orders so ON so.id=v.service_order_id ORDER BY v.id
    `);
    assert.equal(rows.length, 2);
    assert.ok(rows.every(row => row.ticket_id === row.order_ticket_id));
    assert.deepEqual(await all(db, 'PRAGMA foreign_key_check'), []);
  } finally { await close(db); }
});
