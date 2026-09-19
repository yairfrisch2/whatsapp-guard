// אחסון בקובץ JSON. התיקייה נקבעת ב-DATA_DIR (ב-Render: הדיסק הקבוע /var/data)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'db.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

// sessions: כל מספר שחובר (או ממתין לחיבור) | links: קישורי QR חד-פעמיים | groups: הגדרות לכל קבוצה
let db = { sessions: {}, links: {}, groups: {} };
if (fs.existsSync(FILE)) {
  try { db = { ...db, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch (e) { console.error('db read error', e); }
}

function save() {
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(db, null, 2));
  fs.renameSync(FILE + '.tmp', FILE);
}

const LINK_TTL_MS = 30 * 60 * 1000; // תוקף קישור: 30 דקות

// ---- links ----
function createLink() {
  const sessionId = 's' + crypto.randomBytes(6).toString('hex');
  const token = crypto.randomBytes(24).toString('hex');
  const now = Date.now();
  db.sessions[sessionId] = { id: sessionId, createdAt: now };
  db.links[token] = { token, sessionId, createdAt: now, expiresAt: now + LINK_TTL_MS };
  save();
  return db.links[token];
}
function getLink(token) { return db.links[token]; }
function deleteLink(token) { delete db.links[token]; save(); }
function listLinks() { return Object.values(db.links).sort((a, b) => b.createdAt - a.createdAt); }
function linkForSession(sessionId) { return Object.values(db.links).find((l) => l.sessionId === sessionId); }

// ---- sessions ----
function listSessions() { return Object.values(db.sessions); }
function deleteSession(id) {
  delete db.sessions[id];
  for (const k of Object.keys(db.groups)) if (k.startsWith(id + ':')) delete db.groups[k];
  for (const [t, l] of Object.entries(db.links)) if (l.sessionId === id) delete db.links[t];
  save();
}

// ---- group settings ----
const DEFAULTS = () => ({ antiLink: false, antiSticker: false, allowedDomains: [] });
function getGroup(sessionId, jid) {
  return { ...DEFAULTS(), ...(db.groups[sessionId + ':' + jid] || {}) };
}
function setGroup(sessionId, jid, patch) {
  const key = sessionId + ':' + jid;
  db.groups[key] = { ...getGroup(sessionId, jid), ...patch };
  save();
  return db.groups[key];
}

module.exports = {
  DATA_DIR, createLink, getLink, deleteLink, listLinks, linkForSession,
  listSessions, deleteSession, getGroup, setGroup,
};
