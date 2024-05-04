// utils.js
const jwt = require('jsonwebtoken');
const sqlite3 = require('sqlite3').verbose();

// Initialize the SQLite database
const db = new sqlite3.Database('./token_blacklist.db', sqlite3.OPEN_READWRITE, (err) => {
    if (err) {
        return console.error('Error opening database:', err.message);
    }
    console.log('Connected to the SQLite database.');
});
const logDB = new sqlite3.Database('./server_logs.db', sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
    if (err) {
        console.error('Error when creating the database', err);
    } else {
        console.log('Database created!');
        // Create the table if it does not exist
        logDB.run(`CREATE TABLE IF NOT EXISTS server_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            action TEXT NOT NULL,
            timestamp TEXT NOT NULL
        )`);
    }
});

function getEasternTime() {
    const date = new Date();
    return date.toLocaleString('en-US', { timeZone: 'America/New_York' });
}
function getFormattedDate() {
    const date = new Date();
    const day = date.getDate();
    const month = date.toLocaleString('en-US', { month: 'long', timeZone: 'America/New_York' });
    const year = date.getFullYear();
    let suffix = 'th';
    if (day % 10 === 1 && day !== 11) suffix = 'st';
    else if (day % 10 === 2 && day !== 12) suffix = 'nd';
    else if (day % 10 === 3 && day !== 13) suffix = 'rd';
  
    return `${month} ${day}${suffix}, ${year}`;
  }
  function getEasternDateHour() {
    const date = new Date();
    return date.toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false, hour: 'numeric', year: 'numeric', month: 'long', day: 'numeric' });
}

function cleanupExpiredTokens() {
    console.log("Running cleanup...");
    db.all('SELECT token FROM blacklisted_tokens', [], (err, rows) => {
        if (err) {
            return console.error(err.message);
        }
        rows.forEach(row => {
            const decoded = jwt.decode(row.token, { complete: true });
            if (decoded && decoded.payload.exp * 1000 < Date.now()) {
                db.run('DELETE FROM blacklisted_tokens WHERE token = ?', [row.token], (err) => {
                    if (err) {
                        console.error('Failed to delete expired token:', err.message);
                    }
                });
            }
        });
    });
}
function logServerAction(action) {
    const timestamp = getEasternTime(); // This will fetch the time in Eastern Time
    logDB.run('INSERT INTO server_logs (action, timestamp) VALUES (?, ?)', [action, timestamp], (err) => {
        if (err) {
            return console.error('Error logging to database:', err.message);
        }
        console.log(`Logged action "${action}" at ${timestamp}`);
    });
}

module.exports = {
    getEasternTime,
    getFormattedDate,
    getEasternDateHour,
    cleanupExpiredTokens,
    logServerAction
};
