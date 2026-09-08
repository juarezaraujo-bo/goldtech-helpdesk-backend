const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const baseMigration = require('../migrations/001_create_visits_schema');
const contactMigration = require('../migrations/002_scope_company_contacts_by_department');
const serviceOrdersMigration = require('../migrations/003_add_service_orders_and_ticket_visit_documents');

const openDatabase = () => new sqlite3.Database(':memory:');
const exec = (db, sql) => new Promise((resolve, reject) => db.exec(sql, error => error ? reject(error) : resolve()));
const all = (db, sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows)));
const get = (db, sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row)));
const close = db => new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));

async function createLegacySchema(db) {
  await exec(db, `
    PRAGMA foreign_keys = ON;
    CREATE TABLE companies(id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE tickets(id INTEGER PRIMARY KEY);
    INSERT INTO companies VALUES(1,'Cliente legado');
    INSERT INTO users VALUES(1,'Técnico legado');
    INSERT INTO tickets VALUES(1);
    ${baseMigration.up}
    ${contactMigration.up}
    INSERT INTO technical_visits(
      id,visit_number,company_id,technician_user_id,ticket_id,visit_type,status,created_by_user_id
    ) VALUES(1,'VIS-LEGADO',1,1,NULL,'preventive','draft',1);
  `);
}

test('migration preserva visitas históricas e permite draft sem técnico', async () => {
  const db = openDatabase();
  try {
    await createLegacySchema(db);
    const before = await get(db, "SELECT name, [notnull] AS is_not_null FROM pragma_table_info('technical_visits') WHERE name='technician_user_id'");
    assert.equal(before.is_not_null, 1);

    await exec(db, `BEGIN IMMEDIATE; ${serviceOrdersMigration.up} COMMIT;`);

    const columns = await all(db, "SELECT name, [notnull] AS is_not_null FROM pragma_table_info('technical_visits')");
    assert.equal(columns.find(column => column.name === 'technician_user_id').is_not_null, 0);
    assert.equal(columns.find(column => column.name === 'service_order_id').is_not_null, 0);

    const legacy = await get(db, 'SELECT * FROM technical_visits WHERE id=1');
    assert.equal(legacy.technician_user_id, 1);
    assert.equal(legacy.ticket_id, null);
    assert.equal(legacy.service_order_id, null);

    await exec(db, "INSERT INTO technical_visits(visit_number,company_id,technician_user_id,visit_type,status,created_by_user_id) VALUES('VIS-AUTO',1,NULL,'ticket','draft',1)");
    assert.equal((await get(db, "SELECT technician_user_id FROM technical_visits WHERE visit_number='VIS-AUTO'")).technician_user_id, null);
    assert.deepEqual(await all(db, 'PRAGMA foreign_key_check'), []);
  } finally {
    await close(db);
  }
});

test('migration cria configuração, ordens de serviço e vínculo único de documentos', async () => {
  const db = openDatabase();
  try {
    await createLegacySchema(db);
    await exec(db, `BEGIN IMMEDIATE; ${serviceOrdersMigration.up} COMMIT;`);

    assert.equal((await get(db, 'SELECT auto_create_visit_from_ticket FROM companies WHERE id=1')).auto_create_visit_from_ticket, 0);
    await assert.rejects(exec(db, 'UPDATE companies SET auto_create_visit_from_ticket=2 WHERE id=1'), /CHECK constraint failed/);

    await exec(db, "INSERT INTO service_orders(order_number,ticket_id,service_mode,status,created_by_user_id) VALUES('OS-1',1,'onsite','draft',1)");
    const order = await get(db, 'SELECT * FROM service_orders WHERE order_number=\'OS-1\'');
    assert.equal(order.assigned_technician_id, null);

    await exec(db, "INSERT INTO technical_visits(visit_number,company_id,technician_user_id,ticket_id,service_order_id,visit_type,status,created_by_user_id) VALUES('VIS-OS',1,NULL,1,1,'ticket','draft',1)");
    await exec(db, "INSERT INTO visit_documents(visit_id,document_type,storage_path,sha256,generated_at,generated_by) VALUES(2,'final','document.pdf','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',CURRENT_TIMESTAMP,1)");
    await exec(db, 'INSERT INTO ticket_visit_documents(ticket_id,visit_document_id,attached_by_user_id) VALUES(1,1,NULL)');
    await assert.rejects(exec(db, 'INSERT INTO ticket_visit_documents(ticket_id,visit_document_id) VALUES(1,1)'), /UNIQUE constraint failed/);
    await assert.rejects(exec(db, "INSERT INTO service_orders(order_number,ticket_id,service_mode,status,created_by_user_id) VALUES('OS-2',1,'invalid','draft',1)"), /CHECK constraint failed/);
    assert.deepEqual(await all(db, 'PRAGMA foreign_key_check'), []);
  } finally {
    await close(db);
  }
});
