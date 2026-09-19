const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const pino = require('pino');
const QRCode = require('qrcode');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const db = require('./db');

const AUTH_DIR = path.join(db.DATA_DIR, 'auth');
fs.mkdirSync(AUTH_DIR, { recursive: true });

// אירועים: 'connected' (sessionId) | 'loggedout' (sessionId)
const events = new EventEmitter();

// sessionId -> { status, qr, sock, number, starting, destroyed }
const sessions = {};
const metaCache = new Map();
const warnedNotAdmin = new Map();

const PREFIX = '!';
const LINK_REGEX =
  /(https?:\/\/\S+|www\.\S+|chat\.whatsapp\.com\/\S+|\b[a-z0-9-]+\.(?:com|net|org|io|co|il|me|ly|gg|xyz|info|app|tv|ru|to)\b\S*)/gi;

// ---------- helpers ----------
const authPath = (id) => path.join(AUTH_DIR, id);
const num = (jid = '') => jid.split('@')[0].split(':')[0];

function unwrap(message) {
  let m = message;
  while (m?.ephemeralMessage || m?.viewOnceMessage || m?.documentWithCaptionMessage || m?.viewOnceMessageV2) {
    m = (m.ephemeralMessage || m.viewOnceMessage || m.documentWithCaptionMessage || m.viewOnceMessageV2).message;
  }
  return m || {};
}
function getText(c) {
  return c.conversation || c.extendedTextMessage?.text || c.imageMessage?.caption || c.videoMessage?.caption || '';
}
function domainOf(url) {
  return url.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split(/[\/?#]/)[0].toLowerCase();
}
async function getMeta(sock, sessionId, jid) {
  const key = sessionId + ':' + jid;
  const hit = metaCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.meta;
  const meta = await sock.groupMetadata(jid);
  metaCache.set(key, { at: Date.now(), meta });
  return meta;
}
const participantIds = (p) => [p.id, p.lid, p.phoneNumber].filter(Boolean).map(num);
function isAdminOf(meta, ids) {
  const wanted = ids.filter(Boolean).map(num);
  return meta.participants.some((p) => p.admin && participantIds(p).some((x) => wanted.includes(x)));
}
const botIds = (sock) => [sock.user?.id, sock.user?.lid].filter(Boolean);

// ---------- commands ----------
const HELP = `*🤖 פקודות הבוט (למנהלים בלבד)*
${PREFIX}antilink on/off – הסרת קישורים
${PREFIX}antisticker on/off – הסרת סטיקרים
${PREFIX}allow example.com – לאשר דומיין מסוים
${PREFIX}disallow example.com – להסיר אישור דומיין
${PREFIX}status – מצב ההגדרות בקבוצה
${PREFIX}help – התפריט הזה

⚠️ כדי שהבוט יוכל למחוק הודעות הוא חייב להיות מנהל בקבוצה.`;

async function runCommand({ sock, sessionId, jid, cmd, args }) {
  const say = (t) => sock.sendMessage(jid, { text: t });
  const g = db.getGroup(sessionId, jid);
  const onoff = (v) => (v === 'on' ? true : v === 'off' ? false : null);

  switch (cmd) {
    case 'help':
      return say(HELP);
    case 'status':
      return say(
        `*⚙️ הגדרות הקבוצה*\nקישורים: ${g.antiLink ? '🟢 נמחקים' : '⚪ מותרים'}\n` +
          `סטיקרים: ${g.antiSticker ? '🟢 נמחקים' : '⚪ מותרים'}\n` +
          `דומיינים מאושרים: ${g.allowedDomains.length ? g.allowedDomains.join(', ') : 'אין'}`
      );
    case 'antilink': {
      const v = onoff(args[0]);
      if (v === null) return say(`שימוש: ${PREFIX}antilink on/off`);
      db.setGroup(sessionId, jid, { antiLink: v });
      return say(v ? '✅ מחיקת קישורים הופעלה' : '⛔ מחיקת קישורים כובתה');
    }
    case 'antisticker': {
      const v = onoff(args[0]);
      if (v === null) return say(`שימוש: ${PREFIX}antisticker on/off`);
      db.setGroup(sessionId, jid, { antiSticker: v });
      return say(v ? '✅ מחיקת סטיקרים הופעלה' : '⛔ מחיקת סטיקרים כובתה');
    }
    case 'allow': {
      if (!args[0]) return say(`שימוש: ${PREFIX}allow example.com`);
      const d = domainOf(args[0]);
      if (!g.allowedDomains.includes(d)) g.allowedDomains.push(d);
      db.setGroup(sessionId, jid, { allowedDomains: g.allowedDomains });
      return say(`✅ הדומיין ${d} אושר`);
    }
    case 'disallow': {
      if (!args[0]) return say(`שימוש: ${PREFIX}disallow example.com`);
      const d = domainOf(args[0]);
      db.setGroup(sessionId, jid, { allowedDomains: g.allowedDomains.filter((x) => x !== d) });
      return say(`✅ הדומיין ${d} הוסר מהרשימה`);
    }
  }
}

// ---------- message handling ----------
async function handleMessage(sessionId, sock, msg) {
  if (!msg.message) return;
  const jid = msg.key.remoteJid;
  if (!jid || !jid.endsWith('@g.us')) return;

  const content = unwrap(msg.message);
  const text = getText(content).trim();
  const fromMe = !!msg.key.fromMe;

  let meta;
  try { meta = await getMeta(sock, sessionId, jid); } catch { return; }

  if (text.startsWith(PREFIX)) {
    const senderIds = [msg.key.participant, msg.key.participantAlt];
    if (!(fromMe || isAdminOf(meta, senderIds))) return;
    const [cmdRaw, ...args] = text.slice(PREFIX.length).split(/\s+/);
    return runCommand({ sock, sessionId, jid, cmd: cmdRaw.toLowerCase(), args: args.map((a) => a.toLowerCase()) });
  }

  if (fromMe) return;

  const g = db.getGroup(sessionId, jid);
  if (!g.antiLink && !g.antiSticker) return;

  const senderIds = [msg.key.participant, msg.key.participantAlt];
  if (isAdminOf(meta, senderIds)) return;

  let violation = false;
  if (g.antiSticker && content.stickerMessage) violation = true;
  if (!violation && g.antiLink && text) {
    const matches = text.match(LINK_REGEX) || [];
    violation = matches.some((m) => {
      const d = domainOf(m);
      return !g.allowedDomains.some((a) => d === a || d.endsWith('.' + a));
    });
  }
  if (!violation) return;

  if (!isAdminOf(meta, botIds(sock))) {
    const last = warnedNotAdmin.get(jid) || 0;
    if (Date.now() - last > 10 * 60_000) {
      warnedNotAdmin.set(jid, Date.now());
      await sock.sendMessage(jid, { text: '⚠️ אני צריך להיות מנהל בקבוצה כדי למחוק הודעות.' });
    }
    return;
  }
  try { await sock.sendMessage(jid, { delete: msg.key }); } catch (e) { console.error('delete failed', e?.message); }
}

// ---------- session lifecycle ----------
async function start(sessionId) {
  const s = (sessions[sessionId] ||= { status: 'connecting', qr: null, sock: null, number: null });
  if (s.sock || s.starting || s.destroyed) return s;
  s.starting = true;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(authPath(sessionId));
    const { version } = await fetchLatestBaileysVersion();
    if (s.destroyed) return s;

    const sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      browser: ['GroupGuard', 'Chrome', '1.0.0'],
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });
    s.sock = sock;
    s.status = 'connecting';

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (s.destroyed) return;
      if (qr) {
        s.qr = await QRCode.toDataURL(qr, { margin: 1, width: 300 });
        s.status = 'qr';
      }
      if (connection === 'open') {
        s.status = 'connected';
        s.qr = null;
        s.number = num(sock.user?.id);
        console.log(`[${sessionId}] connected as ${s.number}`);
        events.emit('connected', sessionId);
      }
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        s.sock = null;
        if (code === DisconnectReason.loggedOut) {
          // המכשיר נותק מהטלפון
          s.status = 'loggedout';
          events.emit('loggedout', sessionId);
        } else {
          s.status = 'connecting';
          setTimeout(() => { if (!s.destroyed) start(sessionId).catch(console.error); }, 3000);
        }
      }
    });

    sock.ev.on('group-participants.update', ({ id }) => metaCache.delete(sessionId + ':' + id));
    sock.ev.on('groups.update', (arr) => arr.forEach((g) => metaCache.delete(sessionId + ':' + g.id)));
    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const m of messages) handleMessage(sessionId, sock, m).catch((e) => console.error('handle error', e));
    });
  } finally {
    s.starting = false;
  }
  return s;
}

// מנתק את הבוט, מוחק את החיבור השמור, ומפסיק לנסות להתחבר מחדש
async function destroy(sessionId) {
  const s = sessions[sessionId];
  if (s) {
    s.destroyed = true;
    if (s.sock) {
      try { s.status === 'connected' ? await s.sock.logout() : s.sock.end(undefined); } catch {}
    }
    delete sessions[sessionId];
  }
  fs.rmSync(authPath(sessionId), { recursive: true, force: true });
}

function getSession(sessionId) {
  const s = sessions[sessionId];
  return s ? { status: s.status, qr: s.qr, number: s.number } : { status: 'off', qr: null, number: null };
}

// מחבר מחדש אחרי אתחול שרת, רק מספרים שכבר נסרקו (יש להם creds שמורים)
function restore(sessionIds) {
  for (const id of sessionIds) {
    if (fs.existsSync(path.join(authPath(id), 'creds.json'))) {
      start(id).catch((e) => console.error('restore failed', id, e));
    }
  }
}

module.exports = { events, start, destroy, getSession, restore };
