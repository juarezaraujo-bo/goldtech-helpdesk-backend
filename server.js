require('dotenv').config();
const express = require('express');
const cors = require('cors');
const db = require('./database');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

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

// --- Authentication Route ---
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.get(`
        SELECT u.id, u.username, u.name, u.role, u.company_id, c.name as company_name 
        FROM users u 
        LEFT JOIN companies c ON u.company_id = c.id
        WHERE u.username = ? AND u.password_hash = ? AND u.active = 1
    `, [username, password], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (row) {
            res.json({ user: row });
        } else {
            res.status(401).json({ error: 'Invalid credentials or inactive user' });
        }
    });
});

// --- Notifications Endpoints ---
app.get('/api/notifications', (req, res) => {
    const { userId } = req.query;
    db.all(`
        SELECT * FROM notifications 
        WHERE user_id = ? 
        ORDER BY created_at DESC 
        LIMIT 50
    `, [userId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.put('/api/notifications/:id/read', (req, res) => {
    db.run("UPDATE notifications SET read = 1 WHERE id = ?", [req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'Marked as read' });
    });
});

// --- Companies Routes ---
app.get('/api/companies', (req, res) => {
    db.all('SELECT * FROM companies ORDER BY name', [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/companies', (req, res) => {
    const { name, trade_name, cnpj, contact_name, contact_email, phone, status } = req.body;
    const query = `INSERT INTO companies (name, trade_name, cnpj, contact_name, contact_email, phone, status) VALUES (?, ?, ?, ?, ?, ?, ?)`;
    db.run(query, [name, trade_name, cnpj, contact_name, contact_email, phone, status || 'Active'], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.status(201).json({ id: this.lastID });
    });
});

app.put('/api/companies/:id', (req, res) => {
    const { name, trade_name, cnpj, contact_name, contact_email, phone, status } = req.body;

    db.get('SELECT * FROM companies WHERE id = ?', [req.params.id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
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
                if (updateErr) return res.status(500).json({ error: updateErr.message });
                res.json({ success: true });
            }
        );
    });
});

// --- Users Routes ---
app.get('/api/users', (req, res) => {
    const { companyId } = req.query;
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
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/users', (req, res) => {
    const { company_id, name, email, username, password_hash, role, department } = req.body;
    const normalizedRole = role ? role.toLowerCase() : 'cliente_usuario';
    const query = `INSERT INTO users (company_id, name, email, username, password_hash, role, department) VALUES (?, ?, ?, ?, ?, ?, ?)`;
    db.run(query, [company_id, name, email, username, password_hash, normalizedRole, department || null], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.status(201).json({ id: this.lastID });
    });
});

app.put('/api/users/:id', (req, res) => {
    const { name, email, username, role, company_id, active, department } = req.body;
    db.get('SELECT * FROM users WHERE id = ?', [req.params.id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
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
                if (err) return res.status(500).json({ error: err.message });
                res.json({ message: 'User updated successfully' });
            }
        );
    });
});

app.put('/api/users/:id/password', (req, res) => {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Password is required' });

    // TODO: Implement bcrypt for password hashing
    const passwordHash = password;

    db.run(
        `UPDATE users SET password_hash=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
        [passwordHash, req.params.id],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, message: 'Password updated successfully' });
        }
    );
});


// --- Ticket Routes ---
app.get('/api/tickets', (req, res) => {
    const { userId, companyId, role, status, priority } = req.query;
    
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

    if (role === 'cliente_usuario') {
        conditions.push('t.opened_by_user_id = ?');
        params.push(userId);
    } else if (role === 'cliente_gestor') {
        conditions.push('t.company_id = ?');
        params.push(companyId);
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
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.get('/api/tickets/:id', (req, res) => {
    const { userId, companyId, role } = req.query;
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
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Ticket not found' });
        
        // Security Check
        const isAdminOrTech = role === 'admin_goldtech' || role === 'tecnico';
        const isOwner = row.opened_by_user_id == userId;
        const isSameCompany = row.company_id == companyId;

        if (!isAdminOrTech && !isSameCompany) {
            return res.status(403).json({ error: 'Access denied' });
        }

        res.json(row);
    });
});

app.post('/api/tickets', (req, res) => {
    const { title, description, category, priority, company_id, opened_by_user_id, assigned_technician_id } = req.body;
    
    db.get("SELECT COUNT(*) as count FROM tickets", (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
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
                if (err) return res.status(500).json({ error: err.message });
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
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Ticket not found' });

        const newStatus = status !== undefined ? status : row.status;
        const newPriority = priority !== undefined ? priority : row.priority;
        const newTech = assigned_technician_id !== undefined ? assigned_technician_id : row.assigned_technician_id;
        const isAuto = assigned_technician_id !== undefined ? 0 : row.is_auto_assigned;
        const closedAt = newStatus === 'Resolved' && row.status !== 'Resolved' ? "CURRENT_TIMESTAMP" : (row.closed_at ? `'${row.closed_at}'` : "NULL");

        const updateQuery = `UPDATE tickets SET status = ?, priority = ?, assigned_technician_id = ?, is_auto_assigned = ?, updated_at = CURRENT_TIMESTAMP, closed_at = ${closedAt} WHERE id = ?`;
        db.run(updateQuery, [newStatus, newPriority, newTech, isAuto, req.params.id], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            
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
        ORDER BY ti.created_at ASC
    `;
    db.all(query, [req.params.id], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/tickets/:id/interactions', (req, res) => {
    const { user_id, message, interaction_type, visible_to_client } = req.body;
    const ticket_id = req.params.id;
    
    db.get("SELECT ticket_number, assigned_technician_id, opened_by_user_id FROM tickets WHERE id = ?", [ticket_id], (err, ticket) => {
        const query = `INSERT INTO ticket_interactions (ticket_id, user_id, message, interaction_type, visible_to_client) VALUES (?, ?, ?, ?, ?)`;
        db.run(query, [ticket_id, user_id, message, interaction_type || 'message', visible_to_client !== undefined ? visible_to_client : 1], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            
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
        if (err) return res.status(500).json({ error: err.message });
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
}, 30000); // Every 30 seconds

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

    if (!email) return res.status(400).json({ error: 'E-mail obrigatório.' });

    db.get('SELECT id, email FROM users WHERE email = ? AND active = 1', [email], async (err, user) => {
        if (err) return res.status(500).json({ error: err.message });

        // Always respond with same message for security
        if (!user) return res.json({ message: SAFE_MSG });

        const token = crypto.randomBytes(32).toString('hex');
        const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

        db.run(
            'UPDATE users SET reset_token = ?, reset_token_expires = ? WHERE id = ?',
            [token, expires, user.id],
            async (updateErr) => {
                if (updateErr) return res.status(500).json({ error: updateErr.message });

                const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
                const resetLink = `${frontendUrl}/reset-password?token=${token}`;

                try {
                    await sendResetEmail(user.email, resetLink);
                } catch (mailErr) {
                    console.error('Erro ao enviar e-mail:', mailErr.message);
                    // Still respond OK so token is generated even if SMTP isn't configured
                }

                res.json({ message: SAFE_MSG });
            }
        );
    });
});

app.post('/api/auth/reset-password', (req, res) => {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'Token e nova senha são obrigatórios.' });

    db.get(
        'SELECT id, reset_token_expires FROM users WHERE reset_token = ?',
        [token],
        (err, user) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!user) return res.status(400).json({ error: 'Token inválido ou expirado.' });

            const now = new Date();
            const expires = new Date(user.reset_token_expires);
            if (now > expires) return res.status(400).json({ error: 'Token expirado. Solicite uma nova redefinição.' });

            // TODO: implementar bcrypt quando o sistema migrar para hash seguro
            // Ex: const hash = await bcrypt.hash(password, 10);
            db.run(
                'UPDATE users SET password_hash = ?, reset_token = NULL, reset_token_expires = NULL WHERE id = ?',
                [password, user.id],
                (updateErr) => {
                    if (updateErr) return res.status(500).json({ error: updateErr.message });
                    res.json({ message: 'Senha redefinida com sucesso.' });
                }
            );
        }
    );
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
