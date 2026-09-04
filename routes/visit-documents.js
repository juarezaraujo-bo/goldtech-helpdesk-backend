const { createFinalDocumentService } = require('../services/visit-final-document');
const asId = value => { const id = Number(value); return Number.isInteger(id) && id > 0 ? id : null; };
const all = (db, sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows)));

module.exports = function registerVisitDocumentRoutes(app, db, options = {}) {
  db.run('PRAGMA foreign_keys=ON');
  const finalizeVisit = createFinalDocumentService(db, options);
  app.post('/api/visits/:id/documents/final', async (req, res) => {
    const id = asId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Visita inválida.' });
    try {
      const result = await finalizeVisit(id, req.body || {});
      return res.status(result.generated ? 201 : 200).json(result);
    } catch (error) {
      const status = [404, 409].includes(error.status) ? error.status : 500;
      return res.status(status).json({ error: status === 500 ? 'Erro interno ao gerar o comprovante.' : error.message });
    }
  });
  app.get('/api/visits/:id/documents', async (req, res) => {
    const id = asId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Visita inválida.' });
    try {
      const documents = await all(db, 'SELECT * FROM visit_documents WHERE visit_id=? ORDER BY version DESC,id DESC', [id]);
      for (const document of documents) document.deliveries = await all(db, 'SELECT * FROM visit_document_deliveries WHERE document_id=? ORDER BY id', [document.id]);
      return res.json(documents);
    } catch {
      console.error({ status: null, message: 'Falha ao consultar comprovantes da visita.' });
      return res.status(500).json({ error: 'Erro interno ao gerar o comprovante.' });
    }
  });
  return finalizeVisit;
};
