const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./helpdesk.sqlite');

db.serialize(() => {
    db.run("ALTER TABLE tickets ADD COLUMN sla_notified_near INTEGER DEFAULT 0", (err) => {
        if (err) console.log("Column sla_notified_near might exist");
    });
    db.run("ALTER TABLE tickets ADD COLUMN sla_notified_breach INTEGER DEFAULT 0", (err) => {
        if (err) console.log("Column sla_notified_breach might exist");
    });
    console.log("SLA notification columns added.");
    db.close();
});
