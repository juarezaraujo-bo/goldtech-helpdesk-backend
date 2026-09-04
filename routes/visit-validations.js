const crypto=require('crypto');
const CONTACT_TYPES=new Set(['primary_manager','substitute']);
const TOKEN_TTL_MS=48*60*60*1000;
const asId=value=>{const id=Number(value);return Number.isInteger(id)&&id>0?id:null};
const text=value=>value===undefined||value===null?null:(String(value).trim()||null);
const get=(db,sql,params=[])=>new Promise((resolve,reject)=>db.get(sql,params,(error,row)=>error?reject(error):resolve(row)));
const all=(db,sql,params=[])=>new Promise((resolve,reject)=>db.all(sql,params,(error,rows)=>error?reject(error):resolve(rows)));
const run=(db,sql,params=[])=>new Promise((resolve,reject)=>db.run(sql,params,function(error){error?reject(error):resolve(this)}));
const exec=(db,sql)=>new Promise((resolve,reject)=>db.exec(sql,error=>error?reject(error):resolve()));
const asyncRoute=handler=>(req,res)=>Promise.resolve(handler(req,res)).catch(error=>{console.error('Visit validation error:',error.message);return res.status(500).json({error:'Erro interno ao processar a validação.'})});
const sqliteDate=date=>date.toISOString().slice(0,19).replace('T',' ');
const tokenHash=token=>crypto.createHash('sha256').update(token).digest('hex');
const publicUrl=(frontendUrl,token)=>frontendUrl.replace(/\/$/,'')+'/visitas/validar/'+encodeURIComponent(token);
async function transaction(db,work){await exec(db,'BEGIN IMMEDIATE;');try{const result=await work();await exec(db,'COMMIT;');return result}catch(error){await exec(db,'ROLLBACK;').catch(()=>{});throw error}}
async function audit(db,visitId,itemId,contactId,eventType,ip,userAgent,metadata=null){await run(db,'INSERT INTO visit_audit_events(visit_id,visit_department_id,actor_contact_id,event_type,ip,user_agent,metadata_json) VALUES(?,?,?,?,?,?,?)',[visitId,itemId,contactId,eventType,ip||null,userAgent||null,metadata?JSON.stringify(metadata):null])}
module.exports=function registerVisitValidationRoutes(app,db,options={}){
  db.run('PRAGMA foreign_keys=ON');
  const mailer=options.mailer;
  const finalizeVisit=require('../services/visit-final-document').createFinalDocumentService(db,options);
  const frontendUrl=options.frontendUrl||process.env.FRONTEND_URL||'http://localhost:5173';
  const from=options.from||process.env.SMTP_FROM||'"Goldtech Helpdesk" <suporte@goldtech.com.br>';
  const ttlMs=options.tokenTtlMs||TOKEN_TTL_MS;
  app.post('/api/visits/:id/departments/:itemId/request-validation',asyncRoute(async(req,res)=>{
    const visitId=asId(req.params.id),itemId=asId(req.params.itemId),contactType=text(req.body&&req.body.contact_type);
    if(!visitId||!itemId||!CONTACT_TYPES.has(contactType))return res.status(400).json({error:'Informe primary_manager ou substitute.'});
    if(req.body.email!==undefined||req.body.responsible_email!==undefined)return res.status(400).json({error:'O e-mail deve vir do cadastro do responsável.'});
    const item=await get(db,'SELECT vd.*,v.company_id,v.visit_number,v.status AS visit_status,c.name AS company_name,d.name AS department_name,t.name AS technician_name FROM technical_visit_departments vd JOIN technical_visits v ON v.id=vd.visit_id JOIN companies c ON c.id=v.company_id JOIN company_departments d ON d.id=vd.department_id JOIN users t ON t.id=v.technician_user_id WHERE vd.id=? AND vd.visit_id=?',[itemId,visitId]);
    if(!item)return res.status(404).json({error:'Setor da visita não encontrado.'});
    if(!item.completed_at)return res.status(409).json({error:'Conclua o setor antes de solicitar validação.'});
    if(!['in_progress','awaiting_validation'].includes(item.visit_status))return res.status(409).json({error:'A visita não permite solicitação de validação neste status.'});
    if(item.validation_status==='validated')return res.status(409).json({error:'O setor já foi validado.'});
    const contact=await get(db,'SELECT * FROM company_contacts WHERE company_id=? AND contact_type=? AND active=1',[item.company_id,contactType]);
    if(!contact)return res.status(409).json({error:'Responsável ativo não encontrado para a empresa.'});
    const token=crypto.randomBytes(32).toString('base64url');
    const hash=tokenHash(token),hint=token.slice(-6),protocol='VAL-'+new Date().toISOString().replace(/\D/g,'').slice(0,14)+'-'+crypto.randomBytes(3).toString('hex').toUpperCase();
    const expiresAt=sqliteDate(new Date(Date.now()+ttlMs));
    const requestId=await transaction(db,async()=>{
      await run(db,"UPDATE visit_validation_requests SET status='revoked' WHERE visit_department_id=? AND status IN ('created','sent','delivery_failed')",[itemId]);
      const result=await run(db,"INSERT INTO visit_validation_requests(visit_department_id,contact_id,contact_type_snapshot,recipient_name,recipient_email,recipient_job_title,token_hash,token_hint,status,expires_at,protocol) VALUES(?,?,?,?,?,?,?,?, 'created',?,?)",[itemId,contact.id,contact.contact_type,contact.name,contact.email,contact.job_title,hash,hint,expiresAt,protocol]);
      return result.lastID;
    });
    const validationUrl=publicUrl(frontendUrl,token);
    try{
      if(!mailer||typeof mailer.sendMail!=='function')throw new Error('Mailer não configurado');
      await mailer.sendMail({from,to:contact.email,subject:'Validação de visita técnica - '+item.visit_number,text:'Valide o atendimento do setor '+item.department_name+' acessando: '+validationUrl,html:'<p>Olá, '+contact.name+'.</p><p>Valide o atendimento do setor <strong>'+item.department_name+'</strong>:</p><p><a href="'+validationUrl+'">Validar visita técnica</a></p>'});
    }catch(error){
      // The Graph transport logs only HTTP status and a fixed, safe message.
      await run(db,"UPDATE visit_validation_requests SET status='delivery_failed' WHERE id=?",[requestId]);
      return res.status(502).json({error:'Não foi possível enviar o e-mail de validação.'});
    }
    await transaction(db,async()=>{
      await run(db,"UPDATE visit_validation_requests SET status='sent',sent_at=CURRENT_TIMESTAMP WHERE id=?",[requestId]);
      await run(db,"UPDATE technical_visit_departments SET selected_contact_id=?,validator_name_snapshot=?,validator_email_snapshot=?,validator_phone_snapshot=?,validator_job_title_snapshot=?,validation_status='pending',validation_requested_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?",[contact.id,contact.name,contact.email,contact.phone,contact.job_title,itemId]);
      await audit(db,visitId,itemId,contact.id,'validation_requested',req.ip,req.get('user-agent'),{contact_type:contactType,protocol});
    });
    return res.status(201).json({success:true,email_sent:true,recipient:{name:contact.name,email:contact.email,contact_type:contact.contact_type},expires_at:expiresAt,protocol});
  }));
  app.get('/api/visits/public/validate/:token',asyncRoute(async(req,res)=>{
    const hash=tokenHash(req.params.token||'');
    const row=await get(db,"SELECT vr.id AS request_id,vr.status AS request_status,vr.expires_at,vr.recipient_name AS responsible_name,vd.id AS visit_department_id,vd.validation_status,v.visit_number,c.name AS company_name,d.name AS department_name,t.name AS technician_name,vd.demand_status,vd.activities,vd.standardized_description,vd.notes FROM visit_validation_requests vr JOIN technical_visit_departments vd ON vd.id=vr.visit_department_id JOIN technical_visits v ON v.id=vd.visit_id JOIN companies c ON c.id=v.company_id JOIN company_departments d ON d.id=vd.department_id JOIN users t ON t.id=v.technician_user_id WHERE vr.token_hash=?",[hash]);
    if(!row)return res.status(404).json({error:'Link de validação inválido.'});
    if(row.request_status==='validated'||row.validation_status==='validated')return res.status(409).json({error:'Este link já foi utilizado.'});
    if(row.request_status!=='sent')return res.status(410).json({error:'Este link não está mais disponível.'});
    if(new Date(row.expires_at.replace(' ','T')+'Z')<=new Date()){
      await transaction(db,async()=>{await run(db,"UPDATE visit_validation_requests SET status='expired' WHERE id=? AND status='sent'",[row.request_id]);await run(db,"UPDATE technical_visit_departments SET validation_status='expired',updated_at=CURRENT_TIMESTAMP WHERE id=? AND validation_status='pending'",[row.visit_department_id])});
      return res.status(410).json({error:'Este link expirou.'});
    }
    const details=await get(db,'SELECT v.created_at AS visit_created_at,v.started_at AS visit_started_at,v.finished_at AS visit_finished_at,vd.started_at,vd.completed_at,vd.has_pending_issue,vd.requires_return FROM technical_visit_departments vd JOIN technical_visits v ON v.id=vd.visit_id WHERE vd.id=?',[row.visit_department_id]);
    res.set('Cache-Control','no-store');
    return res.json({visit_number:row.visit_number,company_name:row.company_name,department_name:row.department_name,technician_name:row.technician_name,demand_status:row.demand_status,activities:row.activities||row.standardized_description,notes:row.notes,responsible_name:row.responsible_name,validation_status:row.validation_status,...details});
  }));
  app.post('/api/visits/public/validate/:token',asyncRoute(async(req,res)=>{
    if(req.body.accepted!==true)return res.status(400).json({error:'O aceite explícito é obrigatório.'});
    const name=text(req.body.name),role=text(req.body.role);
    if(!name)return res.status(400).json({error:'Informe o nome de quem está validando.'});
    const hash=tokenHash(req.params.token||''),ip=req.ip,userAgent=req.get('user-agent')||null;
    const outcome=await transaction(db,async()=>{
      const row=await get(db,"SELECT vr.*,vd.visit_id,vd.validation_status FROM visit_validation_requests vr JOIN technical_visit_departments vd ON vd.id=vr.visit_department_id WHERE vr.token_hash=?",[hash]);
      if(!row)return{status:404,error:'Link de validação inválido.'};
      if(row.status==='validated'||row.validation_status==='validated')return{status:409,error:'Este link já foi utilizado.'};
      if(row.status!=='sent')return{status:410,error:'Este link não está mais disponível.'};
      if(new Date(row.expires_at.replace(' ','T')+'Z')<=new Date()){await run(db,"UPDATE visit_validation_requests SET status='expired' WHERE id=?",[row.id]);await run(db,"UPDATE technical_visit_departments SET validation_status='expired',updated_at=CURRENT_TIMESTAMP WHERE id=? AND validation_status='pending'",[row.visit_department_id]);return{status:410,error:'Este link expirou.'}}
      const updated=await run(db,"UPDATE visit_validation_requests SET status='validated',validated_at=CURRENT_TIMESTAMP,accepted=1,validation_ip=?,validation_user_agent=? WHERE id=? AND status='sent'",[ip,userAgent,row.id]);
      if(updated.changes!==1)return{status:409,error:'Este link já foi utilizado.'};
      await run(db,"UPDATE technical_visit_departments SET validation_status='validated',validated_at=CURRENT_TIMESTAMP,validator_name_snapshot=?,validator_job_title_snapshot=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",[name,role||row.recipient_job_title,row.visit_department_id]);
      await audit(db,row.visit_id,row.visit_department_id,row.contact_id,'department_validated',ip,userAgent,{protocol:row.protocol,name,role:role||row.recipient_job_title});
      const remaining=await get(db,"SELECT COUNT(*) AS count FROM technical_visit_departments WHERE visit_id=? AND validation_required=1 AND validation_status!='validated'",[row.visit_id]);
      if(remaining.count===0){await run(db,"UPDATE technical_visits SET status='validated',finished_at=COALESCE(finished_at,CURRENT_TIMESTAMP),validated_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?",[row.visit_id]);await audit(db,row.visit_id,null,row.contact_id,'visit_validated',ip,userAgent,{protocol:row.protocol})}
      return{status:200,protocol:row.protocol,visitValidated:remaining.count===0,visitId:row.visit_id};
    });
    if(outcome.error)return res.status(outcome.status).json({error:outcome.error});
    if(outcome.visitValidated){
      console.info('ultima validacao detectada');
      console.info('gerando comprovante automatico');
      try{
        const result=await finalizeVisit(outcome.visitId);
        if(result.document.deliveries.some(delivery=>delivery.status!=='sent')){
          console.error({status:null,message:'comprovante automatico com falha de entrega; pendencias registradas para retry'});
        }else{
          console.info('comprovante automatico concluido');
        }
      }catch(error){
        // Validation is already committed; a document failure must not undo or consume the token again.
        console.error({status:Number.isInteger(error.status)?error.status:null,message:'erro ao gerar comprovante automatico; validacao preservada para retry do comprovante'});
      }
    }
    return res.json({protocol:outcome.protocol,visit_validated:outcome.visitValidated});
  }));
};
module.exports.tokenHash=tokenHash;
