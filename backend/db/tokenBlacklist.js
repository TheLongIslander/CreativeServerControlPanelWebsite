/*
 * Purpose: SQLite database setup for JWT blacklist storage.
 */
const sqlite3 = require('sqlite3').verbose();

const db = new sqlite3.Database('./token_blacklist.db', sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
  if (err) {
    console.error(err.message);
  }
  db.run('CREATE TABLE IF NOT EXISTS blacklisted_tokens(token TEXT UNIQUE)', (createErr) => {
    if (createErr) {
      console.error(createErr.message);
    }
  });
});

module.exports = db;
