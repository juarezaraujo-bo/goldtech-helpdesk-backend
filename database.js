const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, 'helpdesk.sqlite');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database', err.message);
    } else {
        console.log('Connected to the SQLite database.');
        
        db.serialize(() => {
            // Create tables
            db.run(`CREATE TABLE IF NOT EXISTS companies (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                trade_name TEXT,
                cnpj TEXT UNIQUE,
                contact_name TEXT,
                contact_email TEXT,
                phone TEXT,
                status TEXT DEFAULT 'Active',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);

            db.run(`CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                company_id INTEGER,
                name TEXT NOT NULL,
                email TEXT UNIQUE,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL, -- 'admin_goldtech', 'tecnico', 'cliente_gestor', 'cliente_usuario'
                active INTEGER DEFAULT 1,
                department TEXT,
                reset_token TEXT,
                reset_token_expires DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(company_id) REFERENCES companies(id)
            )`);

            // Safe migration: add department column if it doesn't exist
            db.run(`ALTER TABLE users ADD COLUMN department TEXT`, (err) => {
                // Ignore error if column already exists
            });

            // Safe migration: add updated_at column
            db.run(`ALTER TABLE users ADD COLUMN updated_at DATETIME`, (err) => {
                if (err) console.error("Migration error updated_at:", err.message);
            });

            // Safe migrations for password reset
            db.run(`ALTER TABLE users ADD COLUMN reset_token TEXT`, () => {});
            db.run(`ALTER TABLE users ADD COLUMN reset_token_expires DATETIME`, () => {});

            db.run(`CREATE TABLE IF NOT EXISTS tickets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                company_id INTEGER NOT NULL,
                opened_by_user_id INTEGER NOT NULL,
                assigned_technician_id INTEGER,
                ticket_number TEXT UNIQUE NOT NULL,
                title TEXT NOT NULL,
                description TEXT,
                category TEXT,
                priority TEXT,
                status TEXT DEFAULT 'Open',
                sla_deadline DATETIME,
                is_auto_assigned INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                closed_at DATETIME,
                FOREIGN KEY(company_id) REFERENCES companies(id),
                FOREIGN KEY(opened_by_user_id) REFERENCES users(id),
                FOREIGN KEY(assigned_technician_id) REFERENCES users(id)
            )`);

            db.run(`CREATE TABLE IF NOT EXISTS ticket_interactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ticket_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                message TEXT NOT NULL,
                interaction_type TEXT DEFAULT 'message', -- 'message', 'status_change', 'internal_note'
                visible_to_client INTEGER DEFAULT 1,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(ticket_id) REFERENCES tickets(id),
                FOREIGN KEY(user_id) REFERENCES users(id)
            )`);

            db.run(`CREATE TABLE IF NOT EXISTS notifications (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER, -- target user (null for all admins)
                ticket_id INTEGER,
                type TEXT, -- 'new_ticket', 'assigned', 'sla_near', 'sla_breach'
                message TEXT,
                read INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(ticket_id) REFERENCES tickets(id),
                FOREIGN KEY(user_id) REFERENCES users(id)
            )`);

            // Seed initial data
            db.get("SELECT count(*) as count FROM companies", (err, row) => {
                if (row && row.count === 0) {
                    console.log('Seeding initial data...');
                    
                    // Seed Companies
                    db.run(`INSERT INTO companies (name, trade_name, cnpj) VALUES (?, ?, ?)`, 
                        ['Goldtech Soluções', 'Goldtech', '00000000000000']);
                    db.run(`INSERT INTO companies (name, trade_name, cnpj) VALUES (?, ?, ?)`, 
                        ['Cliente Alpha Ltda', 'Alpha Corp', '11111111111111']);
                    db.run(`INSERT INTO companies (name, trade_name, cnpj) VALUES (?, ?, ?)`, 
                        ['Cliente Beta S.A.', 'Beta Solutions', '22222222222222']);

                    // Seed Users
                    setTimeout(() => {
                        const insertUser = db.prepare('INSERT INTO users (company_id, name, email, username, password_hash, role) VALUES (?, ?, ?, ?, ?, ?)');
                        // Goldtech Users (Company 1)
                        insertUser.run(1, 'Admin Supremo', 'admin@goldtech.com', 'admin', 'admin123', 'admin_goldtech');
                        insertUser.run(1, 'Técnico Silva', 'silva@goldtech.com', 'tecnico1', 'tech123', 'tecnico');
                        
                        // Alpha Corp Users (Company 2)
                        insertUser.run(2, 'Gestor Alpha', 'gestor@alpha.com', 'alpha_gestor', 'alpha123', 'cliente_gestor');
                        insertUser.run(2, 'Usuário Alpha', 'user@alpha.com', 'alpha_user', 'alpha123', 'cliente_usuario');
                        
                        // Beta Solutions Users (Company 3)
                        insertUser.run(3, 'Gestor Beta', 'gestor@beta.com', 'beta_gestor', 'beta123', 'cliente_gestor');
                        insertUser.finalize();
                    }, 500);

                    // Seed Tickets
                    setTimeout(() => {
                        const insertTicket = db.prepare(`INSERT INTO tickets (company_id, opened_by_user_id, ticket_number, title, description, category, priority, status, sla_deadline) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
                        
                        const now = new Date();
                        const getSla = (hours) => new Date(now.getTime() + hours * 60 * 60 * 1000).toISOString();

                        insertTicket.run(2, 4, 'GT-2026-0001', 'Computador não liga', 'A tela fica preta.', 'Hardware', 'Critical', 'Open', getSla(2));
                        insertTicket.run(2, 3, 'GT-2026-0002', 'Sem acesso ao ERP', 'Erro de senha incorreta.', 'Software', 'Medium', 'In Progress', getSla(8));
                        insertTicket.run(3, 5, 'GT-2026-0003', 'Wi-Fi lento', 'Rede caindo o tempo todo.', 'Internet', 'Low', 'Open', getSla(24));
                        insertTicket.finalize();
                    }, 1000);
                }
            });
        });
    }
});

module.exports = db;
