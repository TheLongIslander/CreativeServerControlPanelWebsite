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

module.exports = {
    getEasternTime,
    getFormattedDate,
    getEasternDateHour,
    cleanupExpiredTokens
};
