const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { generateVisitPdf } = require('./visit-pdf');
const queues = new WeakMap();
const get = (db, sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row)));
const all = (db, sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows)));
const run = (db, sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, function(error) { error ? reject(error) : resolve(this); }));
const exec = (db, sql) => new Promise((resolve, reject) => db.exec(sql, error => error ? reject(error) : resolve()));
async function transaction(db, work) {
  await exec(db, 'BEGIN IMMEDIATE;');
  try { const value = await work(); await exec(db, 'COMMIT;'); return value; }
  catch (error) { await exec(db, 'ROLLBACK;').catch(() => {}); throw error; }
}
function reject(status, message) { const error = new Error(message); error.status = status; throw error; }
const hashFile = async file => crypto.createHash('sha256').update(await fs.promises.readFile(file)).digest('hex');

function createFinalDocumentService(db, options = {}) {
  const { mailer } = options;
  const storageRoot = path.resolve(options.storageRoot || process.env.VISIT_DOCUMENTS_PATH || path.join(__dirname, '..', 'storage', 'visits'));
  const archiveEmail = options.archiveEmail || process.env.GOLDTECH_ARCHIVE_EMAIL;

  async function generateAndDeliver(visitId, { send_validator_copy = true } = {}) {
    const visit = await get(db, 'SELECT v.*,c.name AS company_name,u.name AS unit_name,t.name AS technician_name FROM technical_visits v JOIN companies c ON c.id=v.company_id LEFT JOIN company_units u ON u.id=v.unit_id JOIN users t ON t.id=v.technician_user_id WHERE v.id=?', [visitId]);
    if (!visit) reject(404, 'Visita não encontrada.');
    if (visit.status !== 'validated') reject(409, 'O comprovante só pode ser gerado após a validação completa.');
    const departments = await all(db, "SELECT vd.*,d.name AS department_name,(SELECT vr.protocol FROM visit_validation_requests vr WHERE vr.visit_department_id=vd.id AND vr.status='validated' ORDER BY vr.validated_at DESC,vr.id DESC LIMIT 1) AS validation_protocol FROM technical_visit_departments vd JOIN company_departments d ON d.id=vd.department_id WHERE vd.visit_id=? ORDER BY vd.id", [visitId]);
    if (!departments.length || departments.some(item => item.validation_status !== 'validated')) reject(409, 'Todos os setores devem estar validados.');
    const manager = await get(db, "SELECT * FROM company_contacts WHERE company_id=? AND contact_type='primary_manager' AND active=1", [visit.company_id]);
    if (!manager) reject(409, 'Gestor principal ativo não encontrado.');
    if (!archiveEmail) reject(409, 'E-mail de arquivo da Goldtech não configurado.');

    let document = await get(db, "SELECT * FROM visit_documents WHERE visit_id=? AND document_type='final' AND version=1", [visitId]);
    const generated = !document;
    if (!document) {
      const relativePath = path.join(String(visit.visit_number).replace(/[^a-zA-Z0-9_-]/g, '_'), 'comprovante-final-v1.pdf');
      const outputPath = path.join(storageRoot, relativePath);
      await generateVisitPdf({ visit, departments, outputPath });
      const sha256 = await hashFile(outputPath);
      const id = await transaction(db, async () => {
        const result = await run(db, "INSERT INTO visit_documents(visit_id,document_type,storage_path,sha256,generated_at,generated_by,version,status) VALUES(?,'final',?,?,CURRENT_TIMESTAMP,?,1,'generated')", [visitId, relativePath, sha256, visit.technician_user_id]);
        await run(db, "INSERT INTO visit_audit_events(visit_id,actor_user_id,event_type,metadata_json) VALUES(?,?,'pdf_generated',?)", [visitId, visit.technician_user_id, JSON.stringify({ document_id: result.lastID, sha256 })]);
        return result.lastID;
      });
      document = await get(db, 'SELECT * FROM visit_documents WHERE id=?', [id]);
    }
    const outputPath = path.resolve(storageRoot, document.storage_path);
    if (!outputPath.startsWith(storageRoot + path.sep)) reject(500, 'Caminho do comprovante inválido.');
    if (await hashFile(outputPath) !== document.sha256) reject(500, 'Integridade do comprovante inválida.');

    const recipients = [{ type: 'primary_manager', name: manager.name, email: manager.email }];
    if (send_validator_copy !== false) {
      const validators = await all(db, "SELECT DISTINCT recipient_name AS name,recipient_email AS email FROM visit_validation_requests vr JOIN technical_visit_departments vd ON vd.id=vr.visit_department_id WHERE vd.visit_id=? AND vr.status='validated'", [visitId]);
      for (const validator of validators) recipients.push({ type: 'validator', ...validator });
    }
    recipients.push({ type: 'goldtech_archive', name: 'Arquivo Goldtech', email: archiveEmail });
    for (const recipient of recipients) {
      await run(db, "INSERT OR IGNORE INTO visit_document_deliveries(document_id,recipient_type,recipient_name,recipient_email,status) VALUES(?,?,?,?,'pending')", [document.id, recipient.type, recipient.name, recipient.email]);
    }
    const deliveries = await all(db, 'SELECT * FROM visit_document_deliveries WHERE document_id=? ORDER BY id', [document.id]);
    const groups = new Map();
    for (const delivery of deliveries) {
      const key = delivery.recipient_email.trim().toLowerCase();
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(delivery);
    }
    for (const group of groups.values()) {
      const pending = group.filter(item => item.status !== 'sent');
      if (!pending.length) continue;
      try {
        // One email per address, including when manager and validator are the same person.
        if (!group.some(item => item.status === 'sent')) {
          if (!mailer || typeof mailer.sendMail !== 'function') throw new Error();
          await mailer.sendMail({ to: group[0].recipient_email, subject: 'Comprovante final da visita ' + visit.visit_number, text: 'Segue o comprovante final da visita técnica ' + visit.visit_number + '.', attachments: [{ filename: path.basename(outputPath), path: outputPath }] });
        }
        await transaction(db, async () => {
          for (const delivery of pending) {
            await run(db, "UPDATE visit_document_deliveries SET status='sent',sent_at=CURRENT_TIMESTAMP,failed_at=NULL,error_code=NULL WHERE id=?", [delivery.id]);
            await run(db, "INSERT INTO visit_audit_events(visit_id,actor_user_id,event_type,metadata_json) VALUES(?,?,'document_delivery_sent',?)", [visitId, visit.technician_user_id, JSON.stringify({ document_id: document.id, recipient_type: delivery.recipient_type, email: delivery.recipient_email })]);
          }
        });
      } catch (error) {
        console.error({ status: Number.isInteger(error.status) ? error.status : null, message: 'Falha ao enviar ou registrar a entrega do comprovante da visita.' });
        for (const delivery of pending) await run(db, "UPDATE visit_document_deliveries SET status='failed',failed_at=CURRENT_TIMESTAMP,error_code=? WHERE id=?", ['GRAPH_ERROR', delivery.id]);
      }
    }
    document.deliveries = await all(db, 'SELECT * FROM visit_document_deliveries WHERE document_id=? ORDER BY id', [document.id]);
    return { generated, document };
  }

  return (visitId, settings) => {
    // Serialize automatic and manual requests within the server, preventing duplicate generation/send.
    const work = (queues.get(db) || Promise.resolve()).then(() => generateAndDeliver(visitId, settings));
    queues.set(db, work.catch(() => {}));
    return work.catch(error => {
      console.error({ status: Number.isInteger(error.status) ? error.status : null, message: 'Falha ao preparar o comprovante final da visita.' });
      throw error;
    });
  };
}
module.exports = { createFinalDocumentService };
