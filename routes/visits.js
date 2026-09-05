const crypto = require('crypto');
const VISIT_TYPES = new Set(['preventive','ticket','emergency','project']);
const DEMAND_STATUSES = new Set(['com_demanda','sem_demanda']);
const SERVER_TIMESTAMPS = ['started_at','completed_at','finished_at','validated_at'];
const NO_DEMAND_DESCRIPTION = 'Setor visitado durante a visita técnica, sem demandas identificadas ou apresentadas no momento do atendimento.';
const asId = value => { const id=Number(value); return Number.isInteger(id)&&id>0?id:null; };
const text = value => value===undefined||value===null?null:(String(value).trim()||null);
const booleanValue = (value,fallback=0) => value===undefined?fallback:(value===true||value===1||value==='1'?1:(value===false||value===0||value==='0'?0:null));
const get = (db,sql,params=[]) => new Promise((resolve,reject)=>db.get(sql,params,(error,row)=>error?reject(error):resolve(row)));
const all = (db,sql,params=[]) => new Promise((resolve,reject)=>db.all(sql,params,(error,rows)=>error?reject(error):resolve(rows)));
const run = (db,sql,params=[]) => new Promise((resolve,reject)=>db.run(sql,params,function(error){error?reject(error):resolve(this)}));
const exec = (db,sql) => new Promise((resolve,reject)=>db.exec(sql,error=>error?reject(error):resolve()));
const rejectsTimestamps = body => SERVER_TIMESTAMPS.some(field=>Object.prototype.hasOwnProperty.call(body||{},field));
const asyncRoute = handler => (req,res)=>Promise.resolve(handler(req,res)).catch(error=>{
  console.error('Visits error:',error.message);
  if(error.code&&error.code.startsWith('SQLITE_CONSTRAINT')) return res.status(409).json({error:'Operação conflitante ou relacionada a dados inválidos.'});
  return res.status(500).json({error:'Erro interno ao processar a visita.'});
});
async function transaction(db,work){
  await exec(db,'BEGIN IMMEDIATE;');
  try { const result=await work(); await exec(db,'COMMIT;'); return result; }
  catch(error){ await exec(db,'ROLLBACK;').catch(()=>{}); throw error; }
}
function visitNumber(){
  const stamp=new Date().toISOString().replace(/\D/g,'').slice(0,14);
  return 'VIS-'+stamp+'-'+crypto.randomBytes(3).toString('hex').toUpperCase();
}
async function loadVisit(db,id){
  const visit=await get(db,"SELECT v.*,c.name AS company_name,u.name AS unit_name,t.name AS technician_name FROM technical_visits v JOIN companies c ON c.id=v.company_id LEFT JOIN company_units u ON u.id=v.unit_id JOIN users t ON t.id=v.technician_user_id WHERE v.id=?",[id]);
  if(!visit) return null;
  visit.departments=await all(db,"SELECT vd.*,d.name AS department_name FROM technical_visit_departments vd JOIN company_departments d ON d.id=vd.department_id WHERE vd.visit_id=? ORDER BY vd.id",[id]);
  visit.validation_summary={total:visit.departments.filter(item=>item.validation_required===1).length,validated:visit.departments.filter(item=>item.validation_required===1&&item.validation_status==='validated').length};
  return visit;
}
async function audit(db,visitId,departmentId,actorUserId,eventType,metadata=null){
  await run(db,'INSERT INTO visit_audit_events(visit_id,visit_department_id,actor_user_id,event_type,metadata_json) VALUES(?,?,?,?,?)',[visitId,departmentId,actorUserId,eventType,metadata?JSON.stringify(metadata):null]);
}
module.exports=function registerVisitRoutes(app,db){
  db.run('PRAGMA foreign_keys = ON');
  app.get('/api/visits',asyncRoute(async(req,res)=>{
    const conditions=[],params=[];
    if(req.user&&req.user.role==='tecnico'){conditions.push('v.technician_user_id=?');params.push(req.user.id)}
    else if(req.query.technicianId!==undefined){const id=asId(req.query.technicianId);if(!id)return res.status(400).json({error:'technicianId inválido.'});conditions.push('v.technician_user_id=?');params.push(id)}
    if(req.query.status){conditions.push('v.status=?');params.push(req.query.status)}
    const where=conditions.length?' WHERE '+conditions.join(' AND '):'';
    const rows=await all(db,"SELECT v.*,c.name AS company_name,u.name AS unit_name,t.name AS technician_name,(SELECT COUNT(*) FROM technical_visit_departments vd WHERE vd.visit_id=v.id) AS department_count,(SELECT COUNT(*) FROM technical_visit_departments vd WHERE vd.visit_id=v.id AND vd.validation_status='validated') AS validated_count FROM technical_visits v JOIN companies c ON c.id=v.company_id LEFT JOIN company_units u ON u.id=v.unit_id JOIN users t ON t.id=v.technician_user_id"+where+' ORDER BY v.created_at DESC,v.id DESC',params);
    return res.json(rows);
  }));
  app.post('/api/visits',asyncRoute(async(req,res)=>{
    if(rejectsTimestamps(req.body))return res.status(400).json({error:'Horários operacionais são definidos exclusivamente pelo servidor.'});
    const companyId=asId(req.body.company_id),technicianId=asId(req.body.technician_id),createdById=asId(req.body.created_by_user_id)||technicianId;
    const unitId=req.body.unit_id===undefined||req.body.unit_id===null||req.body.unit_id===''?null:asId(req.body.unit_id);
    const type=text(req.body.visit_type)||'preventive';
    const departmentIds=[...new Set(Array.isArray(req.body.department_ids)?req.body.department_ids.map(asId):[])];
    if(!companyId||!technicianId||!createdById||!VISIT_TYPES.has(type)||departmentIds.length===0||departmentIds.includes(null))return res.status(400).json({error:'Empresa, técnico, tipo e setores válidos são obrigatórios.'});
    const company=await get(db,'SELECT id FROM companies WHERE id=?',[companyId]);
    const technician=await get(db,"SELECT id FROM users WHERE id=? AND active=1 AND role IN ('tecnico','admin_goldtech')",[technicianId]);
    const creator=await get(db,'SELECT id FROM users WHERE id=? AND active=1',[createdById]);
    if(!company||!technician||!creator)return res.status(400).json({error:'Empresa, técnico ou criador inválido/inativo.'});
    if(unitId&&!await get(db,'SELECT id FROM company_units WHERE id=? AND company_id=? AND active=1',[unitId,companyId]))return res.status(400).json({error:'A unidade não pertence à empresa ou está inativa.'});
    const placeholders=departmentIds.map(()=>'?').join(',');
    const departments=await all(db,'SELECT id,name,unit_id FROM company_departments WHERE active=1 AND company_id=? AND id IN ('+placeholders+')',[companyId,...departmentIds]);
    if(departments.length!==departmentIds.length||departments.some(item=>item.unit_id!==null&&item.unit_id!==unitId))return res.status(400).json({error:'Um ou mais setores não pertencem à empresa/unidade selecionada.'});
    const status=req.body.scheduled_at?'scheduled':'draft';
    const id=await transaction(db,async()=>{
      const result=await run(db,'INSERT INTO technical_visits(visit_number,company_id,unit_id,technician_user_id,visit_type,status,scheduled_at,general_notes,created_by_user_id) VALUES(?,?,?,?,?,?,?,?,?)',[visitNumber(),companyId,unitId,technicianId,type,status,text(req.body.scheduled_at),text(req.body.general_notes),createdById]);
      for(const department of departments)await run(db,'INSERT INTO technical_visit_departments(visit_id,department_id,department_name_snapshot) VALUES(?,?,?)',[result.lastID,department.id,department.name]);
      await audit(db,result.lastID,null,createdById,'visit_created',{department_count:departments.length});
      return result.lastID;
    });
    return res.status(201).json(await loadVisit(db,id));
  }));
  app.get('/api/visits/:id',asyncRoute(async(req,res)=>{
    const id=asId(req.params.id);if(!id)return res.status(400).json({error:'Visita inválida.'});
    const visit=await loadVisit(db,id);return visit?res.json(visit):res.status(404).json({error:'Visita não encontrada.'});
  }));
  app.post('/api/visits/:id/start',asyncRoute(async(req,res)=>{
    if(rejectsTimestamps(req.body))return res.status(400).json({error:'Horários operacionais são definidos exclusivamente pelo servidor.'});
    const id=asId(req.params.id);const visit=id&&await get(db,'SELECT * FROM technical_visits WHERE id=?',[id]);
    if(!visit)return res.status(404).json({error:'Visita não encontrada.'});
    if(!['draft','scheduled'].includes(visit.status))return res.status(409).json({error:'A visita não pode ser iniciada neste status.'});
    const contacts=await all(db,"SELECT contact_type FROM company_contacts WHERE company_id=? AND active=1 AND contact_type IN ('primary_manager','substitute')",[visit.company_id]);
    if(!contacts.some(c=>c.contact_type==='primary_manager')||!contacts.some(c=>c.contact_type==='substitute'))return res.status(409).json({error:'Cadastre um gestor principal e um substituto ativos antes de iniciar a visita.'});
    await transaction(db,async()=>{await run(db,"UPDATE technical_visits SET status='in_progress',started_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?",[id]);await audit(db,id,null,visit.technician_user_id,'visit_started')});
    return res.json(await loadVisit(db,id));
  }));
  app.put('/api/visits/:id/departments/:departmentId',asyncRoute(async(req,res)=>{
    if(rejectsTimestamps(req.body))return res.status(400).json({error:'Horários operacionais são definidos exclusivamente pelo servidor.'});
    const visitId=asId(req.params.id),itemId=asId(req.params.departmentId);
    const item=visitId&&itemId&&await get(db,'SELECT vd.*,v.status AS visit_status,v.technician_user_id FROM technical_visit_departments vd JOIN technical_visits v ON v.id=vd.visit_id WHERE vd.id=? AND vd.visit_id=?',[itemId,visitId]);
    if(!item)return res.status(404).json({error:'Setor da visita não encontrado.'});
    if(item.visit_status!=='in_progress'||item.completed_at)return res.status(409).json({error:'O setor não pode ser alterado neste estado.'});
    const demand=text(req.body.demand_status);if(!DEMAND_STATUSES.has(demand))return res.status(400).json({error:'Situação deve ser com_demanda ou sem_demanda.'});
    let activities=text(req.body.activities),standardized=null;
    if(demand==='sem_demanda'){if(activities)return res.status(400).json({error:'Atividades manuais não são permitidas para setor sem demanda.'});activities=null;standardized=NO_DEMAND_DESCRIPTION}
    if(demand==='com_demanda'&&!activities)return res.status(400).json({error:'Descreva as atividades realizadas para o setor com demanda.'});
    const pending=booleanValue(req.body.has_pending_issue,item.has_pending_issue),requiresReturn=booleanValue(req.body.requires_return,item.requires_return);
    if(pending===null||requiresReturn===null)return res.status(400).json({error:'Indicadores de pendência e retorno devem ser booleanos.'});
    await transaction(db,async()=>{await run(db,'UPDATE technical_visit_departments SET demand_status=?,activities=?,notes=?,has_pending_issue=?,requires_return=?,standardized_description=?,started_at=COALESCE(started_at,CURRENT_TIMESTAMP),updated_at=CURRENT_TIMESTAMP WHERE id=?',[demand,activities,text(req.body.notes),pending,requiresReturn,standardized,itemId]);await audit(db,visitId,itemId,item.technician_user_id,'department_updated',{demand_status:demand})});
    return res.json(await get(db,'SELECT * FROM technical_visit_departments WHERE id=?',[itemId]));
  }));
  app.post('/api/visits/:id/departments/:departmentId/complete',asyncRoute(async(req,res)=>{
    if(rejectsTimestamps(req.body))return res.status(400).json({error:'Horários operacionais são definidos exclusivamente pelo servidor.'});
    const visitId=asId(req.params.id),itemId=asId(req.params.departmentId);
    const item=visitId&&itemId&&await get(db,'SELECT vd.*,v.status AS visit_status,v.technician_user_id FROM technical_visit_departments vd JOIN technical_visits v ON v.id=vd.visit_id WHERE vd.id=? AND vd.visit_id=?',[itemId,visitId]);
    if(!item)return res.status(404).json({error:'Setor da visita não encontrado.'});
    if(item.visit_status!=='in_progress'||item.completed_at)return res.status(409).json({error:'O setor não pode ser concluído neste estado.'});
    if(!DEMAND_STATUSES.has(item.demand_status)||(item.demand_status==='com_demanda'&&!text(item.activities)))return res.status(409).json({error:'Registre corretamente a situação e as atividades antes de concluir.'});
    await transaction(db,async()=>{await run(db,"UPDATE technical_visit_departments SET started_at=COALESCE(started_at,CURRENT_TIMESTAMP),completed_at=CURRENT_TIMESTAMP,validation_status='not_requested',updated_at=CURRENT_TIMESTAMP WHERE id=?",[itemId]);await audit(db,visitId,itemId,item.technician_user_id,'department_completed')});
    return res.json(await get(db,'SELECT * FROM technical_visit_departments WHERE id=?',[itemId]));
  }));
  app.post('/api/visits/:id/finish',asyncRoute(async(req,res)=>{
    if(rejectsTimestamps(req.body))return res.status(400).json({error:'Horários operacionais são definidos exclusivamente pelo servidor.'});
    const id=asId(req.params.id),visit=id&&await get(db,'SELECT * FROM technical_visits WHERE id=?',[id]);
    if(!visit)return res.status(404).json({error:'Visita não encontrada.'});
    if(visit.status!=='in_progress')return res.status(409).json({error:'A visita não pode ser finalizada neste status.'});
    const incomplete=await get(db,'SELECT COUNT(*) AS count FROM technical_visit_departments WHERE visit_id=? AND completed_at IS NULL',[id]);
    if(incomplete.count>0)return res.status(409).json({error:'Conclua todos os setores antes de finalizar a visita.'});
    const nextStatus='awaiting_validation';
    await transaction(db,async()=>{await run(db,'UPDATE technical_visits SET status=?,finished_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?',[nextStatus,id]);await audit(db,id,null,visit.technician_user_id,'visit_finished',{status:nextStatus})});
    return res.json(await loadVisit(db,id));
  }));
};
module.exports.NO_DEMAND_DESCRIPTION=NO_DEMAND_DESCRIPTION;
