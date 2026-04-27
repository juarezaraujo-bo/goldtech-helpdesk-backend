const db = require('../../database');

// Helpers for notifications (copied from server.js for the state machine to work later)
const createNotification = (userId, ticketId, type, message) => {
    const query = `INSERT INTO notifications (user_id, ticket_id, type, message) VALUES (?, ?, ?, ?)`;
    db.run(query, [userId, ticketId, type, message]);
};

const notifyAdmins = (ticketId, type, message) => {
    db.all("SELECT id FROM users WHERE role = 'admin_goldtech'", [], (err, rows) => {
        if (rows) {
            rows.forEach(admin => createNotification(admin.id, ticketId, type, message));
        }
    });
};

const handleWebhook = async (req, res) => {
  const { phone, message } = req.body;

  console.log('Webhook WhatsApp recebido:', { phone, message });

  if (!phone || !message) {
      return res.status(400).json({ error: 'Phone and message are required' });
  }

  const text = message.toLowerCase().trim();
  const reply = (msg) => res.json({ reply: msg });
  
  const saveSession = (phone, step, data, callback) => {
      db.get('SELECT id FROM whatsapp_sessions WHERE phone = ?', [phone], (err, row) => {
          const dataStr = JSON.stringify(data);
          if (row) {
              db.run('UPDATE whatsapp_sessions SET step = ?, data = ?, updated_at = CURRENT_TIMESTAMP WHERE phone = ?', [step, dataStr, phone], callback);
          } else {
              db.run('INSERT INTO whatsapp_sessions (phone, step, data) VALUES (?, ?, ?)', [phone, step, dataStr], callback);
          }
      });
  };

  const deleteSession = (phone, callback) => {
      db.run('DELETE FROM whatsapp_sessions WHERE phone = ?', [phone], callback);
  };

  db.get('SELECT * FROM whatsapp_sessions WHERE phone = ?', [phone], (err, session) => {
      if (err) return res.status(500).json({ error: err.message });

      let sessionData = {};
      if (session && session.data) {
          try { sessionData = JSON.parse(session.data); } catch(e) {}
      }

      const step = session ? session.step : 'initial';
      console.log(`[WhatsApp Webhook] Etapa atual para ${phone}: ${step}`);

      if (step === 'initial') {
          const triggers = ['abrir chamado', 'chamado', 'suporte', 'problema'];
          if (triggers.some(t => text.includes(t))) {
              saveSession(phone, 'awaiting_name', {}, () => {
                  return reply("Olá! Percebi que você precisa de suporte. Por favor, me diga o seu *Nome*:");
              });
          } else {
              return reply("Olá! Sou o assistente da GoldTech. Para abrir um chamado, digite *'abrir chamado'*, *'suporte'* ou *'problema'*.");
          }
      } 
      else if (step === 'awaiting_name') {
          sessionData.name = message.trim();
          saveSession(phone, 'awaiting_company', sessionData, () => {
              return reply(`Certo, ${sessionData.name}. Qual o nome da sua *Empresa*?`);
          });
      }
      else if (step === 'awaiting_company') {
          sessionData.company = message.trim();
          saveSession(phone, 'awaiting_sector', sessionData, () => {
              return reply("Qual o seu *Setor/Departamento*?");
          });
      }
      else if (step === 'awaiting_sector') {
          sessionData.sector = message.trim();
          saveSession(phone, 'awaiting_problem', sessionData, () => {
              return reply("Por favor, descreva detalhadamente o *Problema* que está ocorrendo:");
          });
      }
      else if (step === 'awaiting_problem') {
          sessionData.problem = message.trim();
          saveSession(phone, 'awaiting_priority', sessionData, () => {
              return reply("Qual a *Prioridade* deste chamado?\nDigite o número correspondente:\n1 - Baixa\n2 - Média\n3 - Alta\n4 - Crítica");
          });
      }
      else if (step === 'awaiting_priority') {
          const priorityMap = { '1': 'Low', '2': 'Medium', '3': 'High', '4': 'Critical' };
          let priority = priorityMap[text] || null;
          if (!priority) {
              if (text.includes('baixa')) priority = 'Low';
              else if (text.includes('média') || text.includes('media')) priority = 'Medium';
              else if (text.includes('alta')) priority = 'High';
              else if (text.includes('crítica') || text.includes('critica')) priority = 'Critical';
          }

          if (!priority) {
              return reply("Prioridade inválida. Por favor, digite apenas um número (1 a 4).");
          }

          sessionData.priority = priority;

          // Finalizar: Criar Ticket
          createWhatsAppTicket(phone, sessionData, (err, ticketNumber) => {
              deleteSession(phone, () => {
                  if (err) {
                      console.error('[WhatsApp Webhook] Erro ao criar chamado:', err);
                      return reply("Desculpe, ocorreu um erro interno ao criar seu chamado. Tente novamente mais tarde.");
                  }
                  console.log(`[WhatsApp Webhook] Chamado ${ticketNumber} criado com sucesso para ${phone}.`);
                  return reply(`✅ *Chamado Criado com Sucesso!*\n\nO número do seu protocolo é: *${ticketNumber}*\n\nNossa equipe já foi notificada e entrará em contato em breve.`);
              });
          });
      }
  });
};

function createWhatsAppTicket(phone, data, callback) {
    db.get("SELECT id, company_id FROM users WHERE username = 'whatsapp_user'", (err, wpUser) => {
        if (err || !wpUser) {
            return callback(err || new Error("Generic WhatsApp user not found"));
        }

        const company_id = wpUser.company_id;
        const opened_by_user_id = wpUser.id;

        db.get("SELECT COUNT(*) as count FROM tickets", (err, row) => {
            if (err) return callback(err);

            const nextId = (row.count + 1).toString().padStart(4, '0');
            const year = new Date().getFullYear();
            const ticketNumber = `GT-${year}-${nextId}`;

            const title = data.problem.length > 30 ? data.problem.substring(0, 30) + '...' : data.problem;
            
            const description = `*Abertura via WhatsApp*\n\n` +
                                `*Nome:* ${data.name}\n` +
                                `*Empresa:* ${data.company}\n` +
                                `*Setor:* ${data.sector}\n` +
                                `*WhatsApp:* ${phone}\n\n` +
                                `*Problema Relatado:*\n${data.problem}`;

            const priority = data.priority;
            const category = 'Outros';
            
            const slaHoursMap = { 'Critical': 2, 'High': 4, 'Medium': 8, 'Low': 24 };
            const slaHours = slaHoursMap[priority] || 24;
            const slaDeadline = new Date(Date.now() + slaHours * 60 * 60 * 1000).toISOString();

            const workloadQuery = `
                SELECT u.id 
                FROM users u 
                LEFT JOIN tickets t ON u.id = t.assigned_technician_id AND t.status IN ('Open', 'In Progress')
                WHERE (u.role = 'tecnico' OR LOWER(u.role) = 'tecnico' OR u.role = 'TÉCNICO') AND u.active = 1
                GROUP BY u.id 
                ORDER BY COUNT(t.id) ASC 
                LIMIT 1
            `;

            db.get(workloadQuery, [], (err, techRow) => {
                const assigned_technician_id = techRow ? techRow.id : null;
                const is_auto_assigned = techRow ? 1 : 0;
                const status = assigned_technician_id ? 'In Progress' : 'Open';

                const insertQuery = `
                    INSERT INTO tickets 
                    (company_id, opened_by_user_id, ticket_number, title, description, category, priority, sla_deadline, assigned_technician_id, status, is_auto_assigned, origin, whatsapp_number) 
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `;

                db.run(insertQuery, [
                    company_id, opened_by_user_id, ticketNumber, title, description, category, priority, 
                    slaDeadline, assigned_technician_id, status, is_auto_assigned, 'whatsapp', phone
                ], function(err) {
                    if (err) return callback(err);

                    const ticketId = this.lastID;
                    
                    notifyAdmins(ticketId, 'new_ticket', `Novo chamado via WhatsApp: ${ticketNumber}`);
                    if (assigned_technician_id) {
                        createNotification(assigned_technician_id, ticketId, 'assigned', `Chamado ${ticketNumber} foi atribuído a você (Origem: WhatsApp).`);
                    }

                    callback(null, ticketNumber);
                });
            });
        });
    });
}

module.exports = {
    handleWebhook
};
