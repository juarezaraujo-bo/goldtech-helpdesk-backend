const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CONTACT_TYPES = new Set(['primary_manager', 'substitute']);

function asId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function asActive(value, fallback = 1) {
  if (value === undefined) return fallback;
  if (value === true || value === 1 || value === '1') return 1;
  if (value === false || value === 0 || value === '0') return 0;
  return null;
}

function text(value, required = false) {
  if (value === undefined || value === null) return required ? null : null;
  const normalized = String(value).trim();
  return required && !normalized ? null : (normalized || null);
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row)));
}
function all(db, sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows)));
}
function run(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, function (error) { error ? reject(error) : resolve(this); }));
}
function asyncRoute(handler) {
  return (req, res) => Promise.resolve(handler(req, res)).catch(error => {
    console.error('Visit catalogs error:', error.message);
    if (error.code && error.code.startsWith('SQLITE_CONSTRAINT')) {
      return res.status(409).json({ error: 'Cadastro duplicado ou relacionado a dados inválidos.' });
    }
    return res.status(500).json({ error: 'Erro interno ao processar o cadastro.' });
  });
}
async function companyExists(db, companyId) {
  return Boolean(await get(db, 'SELECT id FROM companies WHERE id = ?', [companyId]));
}
async function departmentBelongsToCompany(db, departmentId, companyId) {
  return Boolean(await get(db, 'SELECT id FROM company_departments WHERE id = ? AND company_id = ?', [departmentId, companyId]));
}

module.exports = function registerVisitCatalogRoutes(app, db) {
  db.run('PRAGMA foreign_keys = ON');

  app.get('/api/visits/managers', asyncRoute(async (req, res) => {
    const companyId = asId(req.query.companyId);
    if (!companyId) return res.status(400).json({ error: 'companyId é obrigatório.' });
    const departmentId = req.query.departmentId === undefined || req.query.departmentId === '' ? null : asId(req.query.departmentId);
    if (req.query.departmentId !== undefined && req.query.departmentId !== '' && !departmentId) return res.status(400).json({ error: 'departmentId inválido.' });
    if (departmentId && !await departmentBelongsToCompany(db, departmentId, companyId)) return res.status(400).json({ error: 'O setor não pertence à empresa informada.' });
    let sql = 'SELECT c.*, d.name AS department_name FROM company_contacts c LEFT JOIN company_departments d ON d.id=c.department_id WHERE c.company_id = ?';
    const params = [companyId];
    if (departmentId) { sql += ' AND c.department_id = ?'; params.push(departmentId); }
    sql += ' ORDER BY c.active DESC, c.department_id, c.contact_type, c.name';
    const rows = await all(db, sql, params);
    return res.json(rows);
  }));

  app.post('/api/visits/managers', asyncRoute(async (req, res) => {
    const companyId = asId(req.body.company_id);
    const departmentId = asId(req.body.department_id);
    const contactType = text(req.body.contact_type, true);
    const name = text(req.body.name, true);
    const email = text(req.body.email, true);
    const phone = text(req.body.phone);
    const jobTitle = text(req.body.job_title, true);
    const active = asActive(req.body.active);
    if (!companyId || !departmentId || !CONTACT_TYPES.has(contactType) || !name || !email || !EMAIL_PATTERN.test(email) || !jobTitle || active === null) {
      return res.status(400).json({ error: 'Empresa, setor, tipo, nome, e-mail válido, função e situação são obrigatórios.' });
    }
    if (!await companyExists(db, companyId)) return res.status(404).json({ error: 'Empresa não encontrada.' });
    if (!await departmentBelongsToCompany(db, departmentId, companyId)) return res.status(400).json({ error: 'O setor não pertence à empresa informada.' });
    const result = await run(db, 'INSERT INTO company_contacts (company_id, department_id, contact_type, name, email, phone, job_title, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [companyId, departmentId, contactType, name, email, phone, jobTitle, active]);
    const created = await get(db, 'SELECT * FROM company_contacts WHERE id = ?', [result.lastID]);
    return res.status(201).json(created);
  }));

  app.put('/api/visits/managers/:id', asyncRoute(async (req, res) => {
    const id = asId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Responsável inválido.' });
    const current = await get(db, 'SELECT * FROM company_contacts WHERE id = ?', [id]);
    if (!current) return res.status(404).json({ error: 'Responsável não encontrado.' });
    if (req.body.company_id !== undefined && asId(req.body.company_id) !== current.company_id) return res.status(400).json({ error: 'Não é permitido mover o responsável para outra empresa.' });
    const departmentId = req.body.department_id === undefined ? current.department_id : asId(req.body.department_id);
    if (!departmentId || !await departmentBelongsToCompany(db, departmentId, current.company_id)) return res.status(400).json({ error: 'O setor deve pertencer à empresa do responsável.' });
    const contactType = req.body.contact_type === undefined ? current.contact_type : text(req.body.contact_type, true);
    const name = req.body.name === undefined ? current.name : text(req.body.name, true);
    const email = req.body.email === undefined ? current.email : text(req.body.email, true);
    const phone = req.body.phone === undefined ? current.phone : text(req.body.phone);
    const jobTitle = req.body.job_title === undefined ? current.job_title : text(req.body.job_title, true);
    const active = asActive(req.body.active, current.active);
    if (!CONTACT_TYPES.has(contactType) || !name || !email || !EMAIL_PATTERN.test(email) || !jobTitle || active === null) return res.status(400).json({ error: 'Tipo, nome, e-mail válido, função e situação são obrigatórios.' });
    await run(db, 'UPDATE company_contacts SET department_id=?, contact_type=?, name=?, email=?, phone=?, job_title=?, active=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', [departmentId, contactType, name, email, phone, jobTitle, active, id]);
    return res.json(await get(db, 'SELECT * FROM company_contacts WHERE id = ?', [id]));
  }));

  app.get('/api/visits/units', asyncRoute(async (req, res) => {
    const companyId = asId(req.query.companyId);
    if (!companyId) return res.status(400).json({ error: 'companyId é obrigatório.' });
    return res.json(await all(db, 'SELECT * FROM company_units WHERE company_id = ? ORDER BY active DESC, name', [companyId]));
  }));

  app.post('/api/visits/units', asyncRoute(async (req, res) => {
    const companyId = asId(req.body.company_id);
    const name = text(req.body.name, true);
    const address = text(req.body.address);
    const active = asActive(req.body.active);
    if (!companyId || !name || active === null) return res.status(400).json({ error: 'Empresa, nome e situação são obrigatórios.' });
    if (!await companyExists(db, companyId)) return res.status(404).json({ error: 'Empresa não encontrada.' });
    const result = await run(db, 'INSERT INTO company_units (company_id, name, address, active) VALUES (?, ?, ?, ?)', [companyId, name, address, active]);
    return res.status(201).json(await get(db, 'SELECT * FROM company_units WHERE id = ?', [result.lastID]));
  }));

  app.put('/api/visits/units/:id', asyncRoute(async (req, res) => {
    const id = asId(req.params.id);
    const current = id && await get(db, 'SELECT * FROM company_units WHERE id = ?', [id]);
    if (!current) return res.status(404).json({ error: 'Unidade não encontrada.' });
    if (req.body.company_id !== undefined && asId(req.body.company_id) !== current.company_id) return res.status(400).json({ error: 'Não é permitido mover a unidade para outra empresa.' });
    const name = req.body.name === undefined ? current.name : text(req.body.name, true);
    const address = req.body.address === undefined ? current.address : text(req.body.address);
    const active = asActive(req.body.active, current.active);
    if (!name || active === null) return res.status(400).json({ error: 'Nome e situação são obrigatórios.' });
    await run(db, 'UPDATE company_units SET name=?, address=?, active=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', [name, address, active, id]);
    return res.json(await get(db, 'SELECT * FROM company_units WHERE id = ?', [id]));
  }));

  app.get('/api/visits/departments', asyncRoute(async (req, res) => {
    const companyId = asId(req.query.companyId);
    if (!companyId) return res.status(400).json({ error: 'companyId é obrigatório.' });
    const unitId = req.query.unitId === undefined || req.query.unitId === '' ? undefined : asId(req.query.unitId);
    if (req.query.unitId !== undefined && req.query.unitId !== '' && !unitId) return res.status(400).json({ error: 'unitId inválido.' });
    let sql = 'SELECT d.*, u.name AS unit_name FROM company_departments d LEFT JOIN company_units u ON u.id=d.unit_id WHERE d.company_id=?';
    const params = [companyId];
    if (unitId !== undefined) { sql += ' AND d.unit_id=?'; params.push(unitId); }
    sql += ' ORDER BY d.active DESC, d.name';
    return res.json(await all(db, sql, params));
  }));

  app.post('/api/visits/departments', asyncRoute(async (req, res) => {
    const companyId = asId(req.body.company_id);
    const unitId = req.body.unit_id === undefined || req.body.unit_id === null || req.body.unit_id === '' ? null : asId(req.body.unit_id);
    const name = text(req.body.name, true);
    const active = asActive(req.body.active);
    if (!companyId || !name || active === null || (req.body.unit_id && !unitId)) return res.status(400).json({ error: 'Empresa, nome e situação são obrigatórios; unidade deve ser válida.' });
    if (!await companyExists(db, companyId)) return res.status(404).json({ error: 'Empresa não encontrada.' });
    if (unitId && !await get(db, 'SELECT id FROM company_units WHERE id=? AND company_id=?', [unitId, companyId])) return res.status(400).json({ error: 'A unidade não pertence à empresa informada.' });
    const values = [companyId, unitId, name, active, text(req.body.operational_contact_name), text(req.body.operational_contact_email), text(req.body.operational_contact_phone)];
    const result = await run(db, 'INSERT INTO company_departments (company_id, unit_id, name, active, operational_contact_name, operational_contact_email, operational_contact_phone) VALUES (?, ?, ?, ?, ?, ?, ?)', values);
    return res.status(201).json(await get(db, 'SELECT * FROM company_departments WHERE id = ?', [result.lastID]));
  }));

  app.put('/api/visits/departments/:id', asyncRoute(async (req, res) => {
    const id = asId(req.params.id);
    const current = id && await get(db, 'SELECT * FROM company_departments WHERE id = ?', [id]);
    if (!current) return res.status(404).json({ error: 'Setor não encontrado.' });
    if (req.body.company_id !== undefined && asId(req.body.company_id) !== current.company_id) return res.status(400).json({ error: 'Não é permitido mover o setor para outra empresa.' });
    const unitId = req.body.unit_id === undefined ? current.unit_id : (req.body.unit_id === null || req.body.unit_id === '' ? null : asId(req.body.unit_id));
    if (req.body.unit_id !== undefined && req.body.unit_id !== null && req.body.unit_id !== '' && !unitId) return res.status(400).json({ error: 'Unidade inválida.' });
    if (unitId && !await get(db, 'SELECT id FROM company_units WHERE id=? AND company_id=?', [unitId, current.company_id])) return res.status(400).json({ error: 'A unidade não pertence à empresa do setor.' });
    const name = req.body.name === undefined ? current.name : text(req.body.name, true);
    const active = asActive(req.body.active, current.active);
    if (!name || active === null) return res.status(400).json({ error: 'Nome e situação são obrigatórios.' });
    const values = [unitId, name, active, req.body.operational_contact_name === undefined ? current.operational_contact_name : text(req.body.operational_contact_name), req.body.operational_contact_email === undefined ? current.operational_contact_email : text(req.body.operational_contact_email), req.body.operational_contact_phone === undefined ? current.operational_contact_phone : text(req.body.operational_contact_phone), id];
    await run(db, 'UPDATE company_departments SET unit_id=?, name=?, active=?, operational_contact_name=?, operational_contact_email=?, operational_contact_phone=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', values);
    return res.json(await get(db, 'SELECT * FROM company_departments WHERE id = ?', [id]));
  }));
};
