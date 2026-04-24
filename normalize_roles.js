const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./helpdesk.sqlite');

db.serialize(() => {
    // Normalize roles to lowercase
    db.run("UPDATE users SET role = 'tecnico' WHERE LOWER(role) = 'tecnico' OR role = 'TÉCNICO'");
    db.run("UPDATE users SET role = 'admin_goldtech' WHERE LOWER(role) = 'admin_goldtech'");
    db.run("UPDATE users SET role = 'cliente_gestor' WHERE LOWER(role) = 'cliente_gestor'");
    db.run("UPDATE users SET role = 'cliente_usuario' WHERE LOWER(role) = 'cliente_usuario'");
    
    console.log("User roles normalized to lowercase.");
    db.close();
});
