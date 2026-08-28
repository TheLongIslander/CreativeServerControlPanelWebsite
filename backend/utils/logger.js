/*
 * Purpose: Lazy SQLite-backed activity logging and time utilities.
 */
const path = require('path');
const jwt = require('jsonwebtoken');
const sqlite3 = require('sqlite3').verbose();
const tokenBlacklist = require('../db/tokenBlacklist');

let logDb = null;
let activityDb = null;
let logReady = null;
let activityReady = null;

function openDatabase(filePath, schema) {
  return new Promise((resolve, reject) => {
    const handle = new sqlite3.Database(filePath, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, err => {
      if (err) {
        reject(err);
        return;
      }
      handle.run(schema, createErr => {
        if (createErr) reject(createErr);
        else resolve(handle);
      });
    });
  });
}

async function getLogDb() {
  if (logDb) return logDb;
  if (!logReady) {
    const filePath = path.resolve(process.env.SERVER_LOGS_DB_PATH || './server_logs.db');
    logReady = openDatabase(filePath, `
      CREATE TABLE IF NOT EXISTS server_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        timestamp TEXT NOT NULL
      )
    `).then(handle => {
      logDb = handle;
      return handle;
    }).catch(err => {
      logReady = null;
      throw err;
    });
  }
  return logReady;
}

async function getActivityDb() {
  if (activityDb) return activityDb;
  if (!activityReady) {
    const filePath = path.resolve(process.env.SFTP_ACTIVITY_DB_PATH || './sftp_activity_log.db');
    activityReady = openDatabase(filePath, `
      CREATE TABLE IF NOT EXISTS sftp_activity_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT,
        action TEXT,
        file_path TEXT,
        timestamp TEXT,
        ip_address TEXT
      )
    `).then(handle => {
      activityDb = handle;
      return handle;
    }).catch(err => {
      activityReady = null;
      throw err;
    });
  }
  return activityReady;
}

function run(handle, sql, params) {
  return new Promise((resolve, reject) => {
    handle.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function getEasternTime(date = new Date()) {
  return date.toLocaleString('en-US', { timeZone: 'America/New_York' });
}

function getFormattedDate(value = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: 'long', day: 'numeric'
  }).formatToParts(value);
  const day = Number(parts.find(part => part.type === 'day').value);
  const month = parts.find(part => part.type === 'month').value;
  const year = parts.find(part => part.type === 'year').value;
  let suffix = 'th';
  if (day % 10 === 1 && day % 100 !== 11) suffix = 'st';
  else if (day % 10 === 2 && day % 100 !== 12) suffix = 'nd';
  else if (day % 10 === 3 && day % 100 !== 13) suffix = 'rd';
  return `${month} ${day}${suffix}, ${year}`;
}

function getEasternDateHour(date = new Date()) {
  return date.toLocaleString('en-US', {
    timeZone: 'America/New_York', hour12: false, hour: 'numeric', year: 'numeric', month: 'long', day: 'numeric'
  });
}

async function cleanupExpiredTokens() {
  const rows = await tokenBlacklist.list();
  await Promise.all(rows.map(async row => {
    const decoded = jwt.decode(row.token);
    if (!decoded || !decoded.exp || decoded.exp * 1000 < Date.now()) {
      await tokenBlacklist.remove(row.token);
    }
  }));
}

async function logServerAction(action) {
  const timestamp = getEasternTime();
  const handle = await getLogDb();
  await run(handle, 'INSERT INTO server_logs (action, timestamp) VALUES (?, ?)', [action, timestamp]);
}

async function logSFTPServerAction(username, action, filePath, ipAddress) {
  const timestamp = getEasternTime();
  const handle = await getActivityDb();
  await run(handle, `
    INSERT INTO sftp_activity_log (username, action, file_path, timestamp, ip_address)
    VALUES (?, ?, ?, ?, ?)
  `, [username, action, filePath, timestamp, ipAddress]);
}

async function close() {
  const handles = [logDb, activityDb].filter(Boolean);
  logDb = null;
  activityDb = null;
  logReady = null;
  activityReady = null;
  await Promise.all(handles.map(handle => new Promise((resolve, reject) => {
    handle.close(err => (err ? reject(err) : resolve()));
  })));
}

module.exports = {
  cleanupExpiredTokens,
  close,
  getEasternDateHour,
  getEasternTime,
  getFormattedDate,
  logServerAction,
  logSFTPServerAction
};
