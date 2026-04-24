const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./helpdesk.sqlite');

db.serialize(() => {
    db.run("ALTER TABLE tickets ADD COLUMN is_auto_assigned INTEGER DEFAULT 0", (err) => {
        if (err) {
            console.log("Column might already exist or error:", err.message);
        } else {
            console.log("Column is_auto_assigned added successfully.");
        }
        db.close();
    });
});
