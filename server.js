const express = require('express');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

function createApp(db, authOptions = {}) {
const app = express();
const databaseError = (res, error) => {
    console.error('Helpdesk database operation failed', { code: error.code || 'DATABASE_ERROR' });
    return res.status(500).json({ error: 'Não foi possível processar a solicitação.' });
};

app.use(express.json());
require('./services/helpdesk-auth').installHelpdeskAuth(app, db, authOptions);
require('./routes/visit-catalogs')(app, db);
require('./routes/visits')(app, db);

app.get('/', (req, res) => {
    res.json({ status: 'ok', service: 'goldtech-helpdesk-api' });
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', service: 'goldtech-helpdesk-api' });
});

// --- Notification Helper ---
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

// Login and session endpoints are registered centrally by helpdesk-auth.

// --- Notifications Endpoints ---
app.get('/api/notifications', (req, res) => {
    const userId = req.user.id;
    db.all(`
        SELECT * FROM notifications 
        WHERE user_id = ? 
        ORDER BY created_at DESC 
        LIMIT 50
    `, [userId], (err, rows) => {
        if (err) return databaseError(res, err);
        res.json(rows);
    });
});

app.put('/api/notifications/:id/read', (req, res) => {
    db.run("UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?", [req.params.id, req.user.id], function(err) {
        if (err) return databaseError(res, err);
        if (!this.changes) return res.status(404).json({ error: 'Notificação não encontrada.' });
        res.json({ message: 'Marked as read' });
    });
});

// --- Companies Routes ---
app.get('/api/companies', (req, res) => {
    const internal = ['admin_goldtech', 'tecnico'].includes(req.user.role);
    db.all('SELECT * FROM companies' + (internal ? '' : ' WHERE id = ?') + ' ORDER BY name', internal ? [] : [req.user.company_id || null], (err, rows) => {
        if (err) return databaseError(res, err);
        res.json(rows);
    });
});

app.post('/api/companies', (req, res) => {
    const { name, trade_name, cnpj, contact_name, contact_email, phone, status } = req.body;
    const query = `INSERT INTO companies (name, trade_name, cnpj, contact_name, contact_email, phone, status) VALUES (?, ?, ?, ?, ?, ?, ?)`;
    db.run(query, [name, trade_name, cnpj, contact_name, contact_email, phone, status || 'Active'], function(err) {
        if (err) return databaseError(res, err);
        res.status(201).json({ id: this.lastID });
    });
});

app.put('/api/companies/:id', (req, res) => {
    const { name, trade_name, cnpj, contact_name, contact_email, phone, status } = req.body;

    db.get('SELECT * FROM companies WHERE id = ?', [req.params.id], (err, row) => {
        if (err) return databaseError(res, err);
        if (!row) return res.status(404).json({ error: 'Cliente não encontrado.' });

        const updatedName           = name          !== undefined ? name          : row.name;
        const updatedTradeName      = trade_name    !== undefined ? trade_name    : row.trade_name;
        const updatedCnpj           = cnpj          !== undefined ? cnpj          : row.cnpj;
        const updatedContact        = contact_name  !== undefined ? contact_name  : row.contact_name;
        const updatedContactEmail   = contact_email !== undefined ? contact_email : row.contact_email;
        const updatedPhone          = phone         !== undefined ? phone         : row.phone;
        const updatedStatus         = status        !== undefined ? status        : row.status;

        db.run(
            `UPDATE companies SET name=?, trade_name=?, cnpj=?, contact_name=?, contact_email=?, phone=?, status=? WHERE id=?`,
            [updatedName, updatedTradeName, updatedCnpj, updatedContact, updatedContactEmail, updatedPhone, updatedStatus, req.params.id],
            function(updateErr) {
                if (updateErr) return databaseError(res, updateErr);
                res.json({ success: true });
            }
        );
    });
});

// --- Users Routes ---
app.get('/api/users', (req, res) => {
    const companyId = ['admin_goldtech', 'tecnico'].includes(req.user.role) ? req.query.companyId : req.user.company_id;
    if (!['admin_goldtech', 'tecnico'].includes(req.user.role) && !companyId) return res.status(403).json({ error: 'Permissão insuficiente.' });
    let query = `
        SELECT u.id, u.name, u.username, u.email, u.role, u.active, u.company_id, u.department, c.name as company_name 
        FROM users u 
        LEFT JOIN companies c ON u.company_id = c.id
    `;
    let params = [];
    if (companyId) {
        query += ' WHERE u.company_id = ?';
        params.push(companyId);
    }
    query += ' ORDER BY u.name';
    
    db.all(query, params, (err, rows) => {
        if (err) return databaseError(res, err);
        res.json(rows);
    });
});

app.post('/api/users', (req, res) => {
    const { company_id, name, email, username, password_hash, role, department } = req.body;
    const normalizedRole = role ? role.toLowerCase() : 'cliente_usuario';
    const query = `INSERT INTO users (company_id, name, email, username, password_hash, role, department) VALUES (?, ?, ?, ?, ?, ?, ?)`;
    db.run(query, [company_id, name, email, username, password_hash, normalizedRole, department || null], function(err) {
        if (err) return databaseError(res, err);
        res.status(201).json({ id: this.lastID });
    });
});

app.put('/api/users/:id', (req, res) => {
    const { name, email, username, role, company_id, active, department } = req.body;
    db.get('SELECT * FROM users WHERE id = ?', [req.params.id], (err, row) => {
        if (err) return databaseError(res, err);
        if (!row) return res.status(404).json({ error: 'User not found' });

        const updatedName       = name       !== undefined ? name       : row.name;
        const updatedEmail      = email      !== undefined ? email      : row.email;
        const updatedUsername   = username   !== undefined ? username   : row.username;
        const updatedRole       = role       !== undefined ? role.toLowerCase() : row.role;
        const updatedCompany    = company_id !== undefined ? company_id : row.company_id;
        const updatedActive     = active     !== undefined ? active     : row.active;
        const updatedDepartment = department !== undefined ? department : row.department;

        db.run(
            `UPDATE users SET name=?, email=?, username=?, role=?, company_id=?, active=?, department=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
            [updatedName, updatedEmail, updatedUsername, updatedRole, updatedCompany, updatedActive, updatedDepartment, req.params.id],
            function(err) {
                if (err) return databaseError(res, err);
                res.json({ message: 'User updated successfully' });
            }
        );
    });
});

app.put('/api/users/:id/password', (req, res) => {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Password is required' });

    // The centralized authorization middleware has already hashed the new password.
    const passwordHash = password;

    db.run(
        `UPDATE users SET password_hash=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
        [passwordHash, req.params.id],
        function(err) {
            if (err) return databaseError(res, err);
            res.json({ success: true, message: 'Password updated successfully' });
        }
    );
});


// --- Ticket Routes ---
app.get('/api/tickets', (req, res) => {
    const { status, priority } = req.query;
    
    let query = `
        SELECT t.*, 
            c.name as company_name, 
            u.name as opened_by_name,
            u.department as opener_department,
            tech.name as technician_name
        FROM tickets t
        JOIN companies c ON t.company_id = c.id
        JOIN users u ON t.opened_by_user_id = u.id
        LEFT JOIN users tech ON t.assigned_technician_id = tech.id
    `;
    
    let params = [];
    let conditions = [];

    if (!req.isInternal) {
        conditions.push('t.company_id = ?');
        params.push(req.user.company_id);
    }

    if (status) {
        conditions.push('t.status = ?');
        params.push(status);
    }
    if (priority) {
        conditions.push('t.priority = ?');
        params.push(priority);
    }

    if (conditions.length > 0) {
        query += ' WHERE ' + conditions.join(' AND ');
    }
    
    query += ' ORDER BY t.created_at DESC';

    db.all(query, params, (err, rows) => {
        if (err) return databaseError(res, err);
        res.json(rows);
    });
});

app.get('/api/tickets/:id', (req, res) => {
    const query = `
        SELECT t.*, 
            c.name as company_name, 
            u.name as opened_by_name,
            u.department as opener_department,
            tech.name as technician_name
        FROM tickets t
        JOIN companies c ON t.company_id = c.id
        JOIN users u ON t.opened_by_user_id = u.id
        LEFT JOIN users tech ON t.assigned_technician_id = tech.id
        WHERE t.id = ?
    `;
    db.get(query, [req.params.id], (err, row) => {
        if (err) return databaseError(res, err);
        if (!row) return res.status(404).json({ error: 'Ticket not found' });
        
        // Security Check
        const isAdminOrTech = req.isInternal;
        const isSameCompany = row.company_id === req.user.company_id;

        if (!isAdminOrTech && !isSameCompany) {
            return res.status(403).json({ error: 'Access denied' });
        }

        res.json(row);
    });
});

app.post('/api/tickets', (req, res) => {
    const { title, description, category, priority, company_id, opened_by_user_id, assigned_technician_id } = req.body;
    
    db.get("SELECT COUNT(*) as count FROM tickets", (err, row) => {
        if (err) return databaseError(res, err);
        const nextId = (row.count + 1).toString().padStart(4, '0');
        const year = new Date().getFullYear();
        const ticketNumber = `GT-${year}-${nextId}`;

        const slaHoursMap = { 'Critical': 2, 'High': 4, 'Medium': 8, 'Low': 24 };
        const slaHours = slaHoursMap[priority] || 24;
        const slaDeadline = new Date(Date.now() + slaHours * 60 * 60 * 1000).toISOString();

        const getAssignee = (callback) => {
            if (assigned_technician_id) {
                callback(assigned_technician_id, 0);
            } else {
                const workloadQuery = `
                    SELECT u.id 
                    FROM users u 
                    LEFT JOIN tickets t ON u.id = t.assigned_technician_id AND t.status IN ('Open', 'In Progress')
                    WHERE (u.role = 'tecnico' OR LOWER(u.role) = 'tecnico' OR u.role = 'TÉCNICO') AND u.active = 1
                    GROUP BY u.id 
                    ORDER BY COUNT(t.id) ASC 
                    LIMIT 1
                `;
                db.get(workloadQuery, [], (err, row) => {
                    if (row) callback(row.id, 1);
                    else callback(null, 0);
                });
            }
        };

        getAssignee((finalTechId, isAuto) => {
            const status = finalTechId ? 'In Progress' : 'Open';
            const query = `INSERT INTO tickets (company_id, opened_by_user_id, ticket_number, title, description, category, priority, sla_deadline, assigned_technician_id, status, is_auto_assigned) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
            
            db.run(query, [company_id, opened_by_user_id, ticketNumber, title, description, category, priority, slaDeadline, finalTechId, status, isAuto], function(err) {
                if (err) return databaseError(res, err);
                const ticketId = this.lastID;
                
                // Notifications
                notifyAdmins(ticketId, 'new_ticket', `Novo chamado criado: ${ticketNumber}`);
                if (finalTechId) {
                    createNotification(finalTechId, ticketId, 'assigned', `Você foi designado para o chamado ${ticketNumber}`);
                }

                res.status(201).json({ id: ticketId, ticket_number: ticketNumber, sla_deadline: slaDeadline, assigned_technician_id: finalTechId, is_auto_assigned: isAuto });
            });
        });
    });
});

app.put('/api/tickets/:id', (req, res) => {
    const { status, priority, assigned_technician_id } = req.body;
    
    db.get('SELECT * FROM tickets WHERE id = ?', [req.params.id], (err, row) => {
        if (err) return databaseError(res, err);
        if (!row) return res.status(404).json({ error: 'Ticket not found' });

        const newStatus = status !== undefined ? status : row.status;
        const newPriority = priority !== undefined ? priority : row.priority;
        const newTech = assigned_technician_id !== undefined ? assigned_technician_id : row.assigned_technician_id;
        const isAuto = assigned_technician_id !== undefined ? 0 : row.is_auto_assigned;
        const closedAt = newStatus === 'Resolved' && row.status !== 'Resolved' ? "CURRENT_TIMESTAMP" : (row.closed_at ? `'${row.closed_at}'` : "NULL");

        const updateQuery = `UPDATE tickets SET status = ?, priority = ?, assigned_technician_id = ?, is_auto_assigned = ?, updated_at = CURRENT_TIMESTAMP, closed_at = ${closedAt} WHERE id = ?`;
        db.run(updateQuery, [newStatus, newPriority, newTech, isAuto, req.params.id], function(err) {
            if (err) return databaseError(res, err);
            
            // Notification for assignment change
            if (assigned_technician_id && assigned_technician_id != row.assigned_technician_id) {
                createNotification(assigned_technician_id, req.params.id, 'assigned', `Você foi designado para o chamado ${row.ticket_number}`);
            }

            res.json({ message: 'Ticket updated successfully' });
        });
    });
});

// --- Ticket Interactions Routes ---
app.get('/api/tickets/:id/interactions', (req, res) => {
    const query = `
        SELECT ti.*, u.name as user_name, u.role as user_role
        FROM ticket_interactions ti
        JOIN users u ON ti.user_id = u.id
        WHERE ti.ticket_id = ?
        ${req.isInternal ? '' : "AND ti.visible_to_client = 1 AND ti.interaction_type = 'message'"}
        ORDER BY ti.created_at ASC
    `;
    db.all(query, [req.params.id], (err, rows) => {
        if (err) return databaseError(res, err);
        res.json(rows);
    });
});

app.post('/api/tickets/:id/interactions', (req, res) => {
    const { user_id, message, interaction_type, visible_to_client } = req.body;
    const ticket_id = req.params.id;
    
    db.get("SELECT ticket_number, assigned_technician_id, opened_by_user_id FROM tickets WHERE id = ?", [ticket_id], (err, ticket) => {
        if (err) return res.status(500).json({ error: 'Não foi possível processar a solicitação.' });
        if (!ticket) return res.status(404).json({ error: 'Chamado não encontrado.' });
        const query = `INSERT INTO ticket_interactions (ticket_id, user_id, message, interaction_type, visible_to_client) VALUES (?, ?, ?, ?, ?)`;
        db.run(query, [ticket_id, user_id, message, interaction_type || 'message', visible_to_client !== undefined ? visible_to_client : 1], function(err) {
            if (err) return databaseError(res, err);
            
            // Notification logic
            if (ticket) {
                // If client replies, notify tech
                if (user_id == ticket.opened_by_user_id) {
                    if (ticket.assigned_technician_id) {
                        createNotification(ticket.assigned_technician_id, ticket_id, 'client_reply', `Cliente respondeu no chamado ${ticket.ticket_number}`);
                    }
                    notifyAdmins(ticket_id, 'client_reply', `Cliente respondeu no chamado ${ticket.ticket_number}`);
                } 
                // If tech replies, notify admins (or tech can be admin)
                else {
                    // Logic for notifying client could be added here if needed
                }
            }

            res.status(201).json({ id: this.lastID });
        });
    });
});

app.get('/api/technicians/workload', (req, res) => {
    db.all(`
        SELECT u.id, u.name, COUNT(t.id) as workload 
        FROM users u 
        LEFT JOIN tickets t ON u.id = t.assigned_technician_id AND t.status IN ('Open', 'In Progress')
        WHERE (u.role = 'tecnico' OR LOWER(u.role) = 'tecnico' OR u.role = 'TÉCNICO' OR u.role = 'admin_goldtech') AND u.active = 1
        GROUP BY u.id 
        ORDER BY workload DESC
    `, [], (err, rows) => {
        if (err) return databaseError(res, err);
        res.json(rows);
    });
});

// --- Background SLA Check ---
setInterval(() => {
    const now = new Date();
    db.all("SELECT id, ticket_number, sla_deadline, assigned_technician_id, sla_notified_near, sla_notified_breach, created_at FROM tickets WHERE status != 'Resolved'", [], (err, rows) => {
        if (rows) {
            rows.forEach(ticket => {
                const deadline = new Date(ticket.sla_deadline);
                const created = new Date(ticket.created_at);
                const totalSlaMs = deadline - created;
                const timeRemainingMs = deadline - now;
                const percentRemaining = (timeRemainingMs / totalSlaMs) * 100;

                // Breach check
                if (now > deadline && !ticket.sla_notified_breach) {
                    const msg = `SLA violado no chamado ${ticket.ticket_number}`;
                    notifyAdmins(ticket.id, 'sla_breach', msg);
                    if (ticket.assigned_technician_id) createNotification(ticket.assigned_technician_id, ticket.id, 'sla_breach', msg);
                    db.run("UPDATE tickets SET sla_notified_breach = 1 WHERE id = ?", [ticket.id]);
                } 
                // Near breach check (20% remaining)
                else if (percentRemaining <= 20 && !ticket.sla_notified_near && !ticket.sla_notified_breach) {
                    const msg = `SLA próximo do limite (20%) no chamado ${ticket.ticket_number}`;
                    notifyAdmins(ticket.id, 'sla_near', msg);
                    if (ticket.assigned_technician_id) createNotification(ticket.assigned_technician_id, ticket.id, 'sla_near', msg);
                    db.run("UPDATE tickets SET sla_notified_near = 1 WHERE id = ?", [ticket.id]);
                }
            });
        }
    });
}, 30000).unref(); // Every 30 seconds; does not keep test instances alive.

// --- Password Reset Routes ---

const mailer = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
    },
});

const visitMailer = require('./services/visit-graph-mailer').createVisitGraphMailer();
require('./routes/visit-documents')(app, db, { mailer: visitMailer });
require('./routes/visit-validations')(app, db, { mailer: visitMailer });

const sendResetEmail = async (toEmail, resetLink) => {
    await mailer.sendMail({
        from: process.env.SMTP_FROM || '"Goldtech Helpdesk" <suporte@goldtech.com.br>',
        to: toEmail,
        subject: 'Redefinição de senha — Goldtech Helpdesk',
        html: `
            <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px;background:#0f1117;color:#fff;border-radius:16px">
                <h2 style="color:#d4af37;margin-top:0">Goldtech Helpdesk</h2>
                <p style="color:#94a3b8">Recebemos uma solicitação para redefinir sua senha.</p>
                <p style="color:#94a3b8">Clique no botão abaixo para criar uma nova senha. O link expira em <strong style="color:#fff">1 hora</strong>.</p>
                <a href="${resetLink}" style="display:inline-block;margin:24px 0;padding:14px 28px;background:#d4af37;color:#000;font-weight:700;border-radius:10px;text-decoration:none">Redefinir senha</a>
                <p style="color:#64748b;font-size:0.8rem">Se você não solicitou a redefinição, ignore este e-mail.</p>
                <p style="color:#64748b;font-size:0.8rem;margin-top:32px">© ${new Date().getFullYear()} Goldtech Soluções em Tecnologia</p>
            </div>
        `,
    });
};

app.post('/api/auth/forgot-password', (req, res) => {
    const { email } = req.body;
    const SAFE_MSG = 'Se o e-mail estiver cadastrado, enviaremos as instruções de recuperação.';

    // Respond before account lookup or mail delivery, identically for all accounts.
    res.json({ message: SAFE_MSG });

    db.get('SELECT id, email FROM users WHERE LOWER(TRIM(email)) = ? AND active = 1', [email], async (err, user) => {
        if (err) { console.error('Password recovery lookup failed', { code: err.code }); return; }

        // Always respond with same message for security
        if (!user) return;

        const token = crypto.randomBytes(32).toString('hex');
        const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

        db.run(
            'UPDATE users SET reset_token = ?, reset_token_expires = ? WHERE id = ?',
            [token, expires, user.id],
            async (updateErr) => {
                if (updateErr) { console.error('Password recovery update failed', { code: updateErr.code }); return; }

                const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
                const resetLink = `${frontendUrl}/reset-password?token=${token}`;

                try {
                    await (authOptions.sendResetEmail || sendResetEmail)(user.email, resetLink);
                } catch (mailErr) {
                    console.error('Password recovery delivery failed', { code: mailErr.code || 'MAIL_ERROR' });
                    // Still respond OK so token is generated even if SMTP isn't configured
                }

            }
        );
    });
});

// Token-based password recovery is handled centrally by helpdesk-auth.

// --- WhatsApp Integration ---
app.post('/api/whatsapp/webhook', (req, res) => {
    const { phone, message } = req.body;

    if (!phone || !message) {
        return res.status(400).json({ error: 'Phone and message are required' });
    }

    const text = message.toLowerCase().trim();
    console.log(`[WhatsApp Webhook] Recebido de ${phone}: ${text}`);

    // Helpers
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

    // Check existing session
    db.get('SELECT * FROM whatsapp_sessions WHERE phone = ?', [phone], (err, session) => {
        if (err) return databaseError(res, err);

        let sessionData = {};
        if (session && session.data) {
            try { sessionData = JSON.parse(session.data); } catch(e) {}
        }

        const step = session ? session.step : 'initial';
        console.log(`[WhatsApp Webhook] Etapa atual para ${phone}: ${step}`);

        // State Machine
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
            const priorityMap = {
                '1': 'Low',
                '2': 'Medium',
                '3': 'High',
                '4': 'Critical'
            };

            // Aceita 1, 2, 3, 4 ou o texto.
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
});

function createWhatsAppTicket(phone, data, callback) {
    // 1. Encontrar o user "Contato WhatsApp"
    db.get("SELECT id, company_id FROM users WHERE username = 'whatsapp_user'", (err, wpUser) => {
        if (err || !wpUser) {
            return callback(err || new Error("Generic WhatsApp user not found"));
        }

        const company_id = wpUser.company_id;
        const opened_by_user_id = wpUser.id;

        // 2. Gerar Título e Ticket Number
        db.get("SELECT COUNT(*) as count FROM tickets", (err, row) => {
            if (err) return callback(err);

            const nextId = (row.count + 1).toString().padStart(4, '0');
            const year = new Date().getFullYear();
            const ticketNumber = `GT-${year}-${nextId}`;

            // Título: pega os primeiros 30 caracteres do problema
            const title = data.problem.length > 30 ? data.problem.substring(0, 30) + '...' : data.problem;

            // Descrição formata as informações capturadas
            const description = `*Abertura via WhatsApp*\n\n` +
                                `*Nome:* ${data.name}\n` +
                                `*Empresa:* ${data.company}\n` +
                                `*Setor:* ${data.sector}\n` +
                                `*WhatsApp:* ${phone}\n\n` +
                                `*Problema Relatado:*\n${data.problem}`;

            const priority = data.priority;
            const category = 'Outros'; // Categoria default

            // SLA
            const slaHoursMap = { 'Critical': 2, 'High': 4, 'Medium': 8, 'Low': 24 };
            const slaHours = slaHoursMap[priority] || 24;
            const slaDeadline = new Date(Date.now() + slaHours * 60 * 60 * 1000).toISOString();

            // Auto-assign
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

                    // Notificações
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

app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    res.status(error.type === 'entity.parse.failed' ? 400 : 500).json({ error: 'Não foi possível processar a solicitação.' });
});
return app;
}

if (require.main === module) {
    require('dotenv').config();
    const app = createApp(require('./database'));
    const port = process.env.PORT || 5000;
    app.listen(port, () => console.log(`Server is running on port ${port}`));
}
module.exports = { createApp };
