const crypto = require('crypto');

const MODES = new Set(['manual_visit', 'ticket_automation']);
const VISIT_TYPES = new Set(['preventive', 'ticket', 'emergency', 'project']);
const PRIORITY_SLA_HOURS = { Critical: 2, High: 4, Medium: 8, Low: 24 };

const get = (db, sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row)));
const all = (db, sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows)));
const run = (db, sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, function (error) { error ? reject(error) : resolve(this); }));
const exec = (db, sql) => new Promise((resolve, reject) => db.exec(sql, error => error ? reject(error) : resolve()));
const asId = value => { const id = Number(value); return Number.isInteger(id) && id > 0 ? id : null; };
const cleanText = value => value === undefined || value === null ? null : (String(value).trim() || null);

class IntegratedCreationError extends Error {
  constructor(message, code = 'INVALID_INTEGRATED_CREATION') {
    super(message);
    this.name = 'IntegratedCreationError';
    this.code = code;
  }
}

async function nextSequentialNumber(db, table, column, prefix) {
  const row = await get(
    db,
    `SELECT MAX(CAST(SUBSTR(${column}, ?) AS INTEGER)) AS sequence FROM ${table} WHERE ${column} GLOB ?`,
    [prefix.length + 1, `${prefix}[0-9]*`]
  );
  return prefix + String((Number(row && row.sequence) || 0) + 1).padStart(4, '0');
}

async function nextVisitNumber(db) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    const number = `VIS-${stamp}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    if (!await get(db, 'SELECT id FROM technical_visits WHERE visit_number=?', [number])) return number;
  }
  throw new IntegratedCreationError('Não foi possível gerar número único para a visita.', 'NUMBER_COLLISION');
}

async function validateReferences(db, data) {
  const company = await get(db, 'SELECT id FROM companies WHERE id=?', [data.companyId]);
  if (!company) throw new IntegratedCreationError('Empresa inválida.');

  const creator = await get(db, 'SELECT id FROM users WHERE id=? AND active=1', [data.createdById]);
  if (!creator) throw new IntegratedCreationError('Usuário criador inválido ou inativo.');

  if (data.technicianId) {
    const technician = await get(db, "SELECT id FROM users WHERE id=? AND active=1 AND role IN ('tecnico','admin_goldtech')", [data.technicianId]);
    if (!technician) throw new IntegratedCreationError('Técnico inválido ou inativo.');
  }

  if (data.unitId) {
    const unit = await get(db, 'SELECT id FROM company_units WHERE id=? AND company_id=? AND active=1', [data.unitId, data.companyId]);
    if (!unit) throw new IntegratedCreationError('A unidade não pertence à empresa ou está inativa.');
  }

  if (!data.departmentIds.length) return [];
  const placeholders = data.departmentIds.map(() => '?').join(',');
  const departments = await all(
    db,
    `SELECT id,name,unit_id FROM company_departments WHERE active=1 AND company_id=? AND id IN (${placeholders})`,
    [data.companyId, ...data.departmentIds]
  );
  if (departments.length !== data.departmentIds.length || departments.some(item => item.unit_id !== null && item.unit_id !== data.unitId)) {
    throw new IntegratedCreationError('Um ou mais setores não pertencem à empresa/unidade selecionada.');
  }
  return departments;
}

function normalizeInput(input = {}) {
  const mode = input.mode;
  if (!MODES.has(mode)) throw new IntegratedCreationError('Modo de criação inválido.');

  const ticket = input.ticket || {};
  const visit = input.visit || {};
  const serviceOrder = input.service_order || {};
  const companyId = asId(input.company_id || ticket.company_id || visit.company_id);
  const createdById = asId(input.created_by_user_id || ticket.opened_by_user_id || visit.created_by_user_id);
  const ticketTechnicianId = asId(ticket.assigned_technician_id);
  const visitTechnicianId = asId(visit.technician_user_id);
  if (ticketTechnicianId && visitTechnicianId && ticketTechnicianId !== visitTechnicianId) {
    throw new IntegratedCreationError('Chamado e visita devem possuir o mesmo técnico.');
  }
  const technicianId = visitTechnicianId || ticketTechnicianId;
  const unitId = visit.unit_id === undefined || visit.unit_id === null || visit.unit_id === '' ? null : asId(visit.unit_id);
  const departmentIds = [...new Set(Array.isArray(visit.department_ids) ? visit.department_ids.map(asId) : [])];
  const visitType = cleanText(visit.visit_type) || (mode === 'ticket_automation' ? 'ticket' : 'preventive');

  if (!companyId || !createdById) throw new IntegratedCreationError('Empresa e usuário criador são obrigatórios.');
  if (mode === 'manual_visit' && !technicianId) throw new IntegratedCreationError('Técnico é obrigatório para visita manual.');
  if (mode === 'manual_visit' && (!departmentIds.length || departmentIds.includes(null))) throw new IntegratedCreationError('Setores válidos são obrigatórios para visita manual.');
  if (departmentIds.includes(null)) throw new IntegratedCreationError('Setor inválido.');
  if (!VISIT_TYPES.has(visitType)) throw new IntegratedCreationError('Tipo de visita inválido.');

  const priority = cleanText(ticket.priority) || 'Medium';
  const slaHours = PRIORITY_SLA_HOURS[priority] || 24;
  return {
    mode,
    companyId,
    createdById,
    technicianId,
    unitId,
    departmentIds,
    visitType,
    ticket: {
      title: cleanText(ticket.title) || 'Visita técnica',
      description: cleanText(ticket.description),
      category: cleanText(ticket.category) || 'Visita Técnica',
      priority,
      slaDeadline: cleanText(ticket.sla_deadline) || new Date(Date.now() + slaHours * 60 * 60 * 1000).toISOString(),
      origin: cleanText(ticket.origin) || 'technical_visit',
      isAutoAssigned: ticket.is_auto_assigned ? 1 : 0
    },
    serviceOrder: { description: cleanText(serviceOrder.description) },
    visit: {
      status: cleanText(visit.scheduled_at) ? 'scheduled' : 'draft',
      scheduledAt: cleanText(visit.scheduled_at),
      generalNotes: cleanText(visit.general_notes)
    }
  };
}

async function createIntegratedVisit(db, input) {
  const data = normalizeInput(input);
  await exec(db, 'BEGIN IMMEDIATE;');
  try {
    const departments = await validateReferences(db, data);
    const year = new Date().getFullYear();
    const ticketNumber = await nextSequentialNumber(db, 'tickets', 'ticket_number', `GT-${year}-`);
    const orderNumber = await nextSequentialNumber(db, 'service_orders', 'order_number', `OS-${year}-`);
    const visitNumber = await nextVisitNumber(db);
    const ticketStatus = data.technicianId ? 'In Progress' : 'Open';

    const ticketResult = await run(db, `
      INSERT INTO tickets(
        company_id,opened_by_user_id,assigned_technician_id,ticket_number,title,description,
        category,priority,status,sla_deadline,is_auto_assigned,origin
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    `, [
      data.companyId, data.createdById, data.technicianId, ticketNumber, data.ticket.title,
      data.ticket.description, data.ticket.category, data.ticket.priority, ticketStatus,
      data.ticket.slaDeadline, data.ticket.isAutoAssigned, data.ticket.origin
    ]);

    const orderResult = await run(db, `
      INSERT INTO service_orders(
        order_number,ticket_id,service_mode,status,assigned_technician_id,description,created_by_user_id
      ) VALUES(?,?,'onsite','draft',?,?,?)
    `, [orderNumber, ticketResult.lastID, data.technicianId, data.serviceOrder.description, data.createdById]);

    const visitResult = await run(db, `
      INSERT INTO technical_visits(
        visit_number,company_id,unit_id,technician_user_id,ticket_id,service_order_id,
        visit_type,status,scheduled_at,general_notes,created_by_user_id
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?)
    `, [
      visitNumber, data.companyId, data.unitId, data.technicianId, ticketResult.lastID,
      orderResult.lastID, data.visitType, data.visit.status, data.visit.scheduledAt,
      data.visit.generalNotes, data.createdById
    ]);

    for (const department of departments) {
      await run(db, 'INSERT INTO technical_visit_departments(visit_id,department_id,department_name_snapshot) VALUES(?,?,?)', [visitResult.lastID, department.id, department.name]);
    }
    await run(db, 'INSERT INTO visit_audit_events(visit_id,actor_user_id,event_type,metadata_json) VALUES(?,?,?,?)', [
      visitResult.lastID,
      data.createdById,
      'visit_created',
      JSON.stringify({ mode: data.mode, ticket_id: ticketResult.lastID, service_order_id: orderResult.lastID, department_count: departments.length })
    ]);

    await exec(db, 'COMMIT;');
    return {
      ticket: { id: ticketResult.lastID, ticket_number: ticketNumber },
      service_order: { id: orderResult.lastID, order_number: orderNumber },
      visit: { id: visitResult.lastID, visit_number: visitNumber }
    };
  } catch (error) {
    await exec(db, 'ROLLBACK;').catch(() => {});
    throw error;
  }
}

module.exports = { createIntegratedVisit, IntegratedCreationError };
