const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const path = require('path');
const db = require('./db');
const bot = require('./bot');

const PORT = process.env.PORT || 3000;
const ACCESS_CODE = process.env.ACCESS_CODE;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const isProd = process.env.NODE_ENV === 'production';

if (!ACCESS_CODE) {
  console.error('ACCESS_CODE חסר. הגדר אותו במשתני הסביבה (בקוד הכניסה לפאנל).');
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1); // Render עובד מאחורי פרוקסי
app.use(express.json());
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: isProd, maxAge: 1000 * 60 * 60 * 12 },
  })
);

// קבצים סטטיים (הפאנל). דף הקישור החד-פעמי מוגש בנפרד למטה.
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', extensions: [] }));

app.get('/healthz', (req, res) => res.send('ok'));

// ---------- הגנה על הכניסה: הגבלת ניסיונות ----------
const attempts = new Map(); // ip -> { n, until }
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const requireAdmin = (req, res, next) =>
  req.session.admin ? next() : res.status(401).json({ error: 'לא מחובר' });

app.post('/api/login', (req, res) => {
  const ip = req.ip;
  const a = attempts.get(ip) || { n: 0, until: 0 };
  if (a.until > Date.now()) return res.status(429).json({ error: 'יותר מדי ניסיונות. נסה שוב בעוד כמה דקות.' });

  if (!safeEqual(req.body?.code || '', ACCESS_CODE)) {
    a.n += 1;
    if (a.n >= 5) { a.until = Date.now() + 15 * 60_000; a.n = 0; }
    attempts.set(ip, a);
    return res.status(401).json({ error: 'קוד שגוי' });
  }
  attempts.delete(ip);
  req.session.admin = true;
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get('/api/me', (req, res) => res.json({ admin: !!req.session.admin }));

// ---------- קישורים חד-פעמיים ----------
const baseUrl = (req) => PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
const consumed = new Map(); // token -> זמן. כדי שדף הקישור ידע להציג "חובר בהצלחה"

app.get('/api/admin/state', requireAdmin, (req, res) => {
  const links = db.listLinks().map((l) => ({
    token: l.token,
    url: `${baseUrl(req)}/l/${l.token}`,
    createdAt: l.createdAt,
    expiresAt: l.expiresAt,
  }));
  const pendingIds = new Set(db.listLinks().map((l) => l.sessionId));
  const numbers = db
    .listSessions()
    .filter((s) => !pendingIds.has(s.id)) // ממתינים לסריקה לא נחשבים כמחוברים
    .map((s) => ({ id: s.id, ...bot.getSession(s.id), createdAt: s.createdAt }));
  res.json({ links, numbers });
});

app.post('/api/admin/links', requireAdmin, (req, res) => {
  const l = db.createLink();
  res.json({ token: l.token, url: `${baseUrl(req)}/l/${l.token}`, expiresAt: l.expiresAt });
});

app.delete('/api/admin/links/:token', requireAdmin, async (req, res) => {
  const l = db.getLink(req.params.token);
  if (l) {
    await bot.destroy(l.sessionId); // ממתין לסריקה: מבטלים את הסשן וכל מה שנוצר בשבילו
    db.deleteSession(l.sessionId);
  }
  res.json({ ok: true });
});

app.post('/api/admin/numbers/:id/disconnect', requireAdmin, async (req, res) => {
  await bot.destroy(req.params.id);
  db.deleteSession(req.params.id);
  res.json({ ok: true });
});

// ---------- דף ה-QR הציבורי (מי שיש לו את הקישור) ----------
app.get('/l/:token', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'link.html'));
});

app.post('/api/public/link/:token/start', async (req, res) => {
  const l = db.getLink(req.params.token);
  if (!l || l.expiresAt < Date.now()) return res.status(404).json({ error: 'invalid' });
  await bot.start(l.sessionId);
  res.json({ ok: true });
});

app.get('/api/public/link/:token/status', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const token = req.params.token;
  const l = db.getLink(token);
  if (!l || l.expiresAt < Date.now()) return res.status(404).json({ used: consumed.has(token) });
  const s = bot.getSession(l.sessionId);
  res.json({ status: s.status, qr: s.qr }); // לא חושפים כאן את המספר
});

// ---------- אירועי הבוט ----------
bot.events.on('connected', (sessionId) => {
  const l = db.linkForSession(sessionId);
  if (l) {
    // הקישור נוצל: מוחקים אותו מיד
    consumed.set(l.token, Date.now());
    db.deleteLink(l.token);
  }
});
bot.events.on('loggedout', async (sessionId) => {
  // המשתמש ניתק את המכשיר מהטלפון: מנקים הכל
  await bot.destroy(sessionId);
  db.deleteSession(sessionId);
});

// ניקוי: קישורים שפג תוקפם, וזיכרון של קישורים שנוצלו
setInterval(async () => {
  const now = Date.now();
  for (const l of db.listLinks()) {
    if (l.expiresAt < now) {
      await bot.destroy(l.sessionId);
      db.deleteSession(l.sessionId);
    }
  }
  for (const [t, at] of consumed) if (now - at > 10 * 60_000) consumed.delete(t);
}, 60_000);

app.listen(PORT, () => {
  console.log(`Server on port ${PORT}`);
  const pending = new Set(db.listLinks().map((l) => l.sessionId));
  bot.restore(db.listSessions().map((s) => s.id).filter((id) => !pending.has(id)));
});

process.on('unhandledRejection', (e) => console.error('unhandledRejection', e));
process.on('uncaughtException', (e) => console.error('uncaughtException', e));
