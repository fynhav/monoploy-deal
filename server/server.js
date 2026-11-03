'use strict';
// Monopoly Deal Tally server. No dependencies: Node's built-in http, crypto and SQLite.
//   - two fixed players (from seed.json), each claims their account by choosing a PIN
//   - one shared game history; XP and levels are worked out in the app from that history
//   - serves the app from ./public so everything lives at one address
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
const PEPPER = process.env.PIN_PEPPER || '';
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_MS = 365 * 24 * 3600 * 1000;
const REFRESH_MS = 24 * 3600 * 1000;
const MAX_BODY = 10 * 1024;

// ---------- database ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'tally.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS users (
    slot INTEGER PRIMARY KEY CHECK (slot IN (0, 1)),
    name TEXT NOT NULL,
    pin_salt BLOB, pin_hash BLOB,
    fails INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    slot INTEGER NOT NULL,
    created INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS games (
    id TEXT PRIMARY KEY,
    w INTEGER NOT NULL CHECK (w IN (0, 1)),
    at TEXT NOT NULL,
    by_slot INTEGER,
    created INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS games_at ON games (at, id);
  CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
`);
const q = {
  getMeta: db.prepare('SELECT v FROM meta WHERE k = ?'),
  setMeta: db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'),
  users: db.prepare('SELECT slot, name, pin_hash IS NOT NULL AS has_pin FROM users ORDER BY slot'),
  user: db.prepare('SELECT * FROM users WHERE slot = ?'),
  addUser: db.prepare('INSERT OR IGNORE INTO users (slot, name) VALUES (?, ?)'),
  setPin: db.prepare('UPDATE users SET pin_salt = ?, pin_hash = ?, fails = 0, locked_until = 0 WHERE slot = ?'),
  clearPin: db.prepare('UPDATE users SET pin_salt = NULL, pin_hash = NULL, fails = 0, locked_until = 0 WHERE slot = ?'),
  setFails: db.prepare('UPDATE users SET fails = ?, locked_until = ? WHERE slot = ?'),
  addSession: db.prepare('INSERT INTO sessions (token_hash, slot, created, last_seen) VALUES (?, ?, ?, ?)'),
  session: db.prepare('SELECT slot, last_seen FROM sessions WHERE token_hash = ?'),
  touchSession: db.prepare('UPDATE sessions SET last_seen = ? WHERE token_hash = ?'),
  delSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
  delSlotSessions: db.prepare('DELETE FROM sessions WHERE slot = ?'),
  expireSessions: db.prepare('DELETE FROM sessions WHERE last_seen < ?'),
  games: db.prepare('SELECT id, w, at FROM games ORDER BY at, id'),
  addGame: db.prepare('INSERT OR IGNORE INTO games (id, w, at, by_slot, created) VALUES (?, ?, ?, ?, ?)'),
  delGame: db.prepare('DELETE FROM games WHERE id = ?'),
  countGames: db.prepare('SELECT COUNT(*) AS n FROM games')
};
const meta = (k) => { const r = q.getMeta.get(k); return r ? r.v : null; };
const rev = () => Number(meta('rev') || 0);
const bump = () => { const n = rev() + 1; q.setMeta.run('rev', String(n)); return n; };

function loadSeed() {
  let seed = { names: ['Player 1', 'Player 2'], games: [] };
  try { seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed.json'), 'utf8')); } catch (e) { /* no seed file */ }
  const names = [0, 1].map((i) => String((seed.names && seed.names[i]) || 'Player ' + (i + 1)).slice(0, 18));
  names.forEach((n, i) => q.addUser.run(i, n));
  if (meta('seeded') !== '1') {
    let n = 0;
    for (const g of seed.games || []) {
      if (validGame(g)) { q.addGame.run(g.id, g.w, new Date(g.at).toISOString(), null, Date.now()); n++; }
    }
    q.setMeta.run('seeded', '1');
    bump();
    console.log('seeded ' + n + ' games');
  }
}

// One-time import: put games in server/import.json ({"games":[{id,w,at}]}) and push. Each distinct file is applied once;
// games already present are left alone, and nothing is ever deleted.
function applyImport() {
  let text;
  try { text = fs.readFileSync(path.join(__dirname, 'import.json'), 'utf8'); } catch (e) { return; }
  const key = 'import:' + crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
  if (meta(key) === '1') return;
  let data;
  try { data = JSON.parse(text); } catch (e) { console.error('import.json is not valid JSON, skipped'); return; }
  let added = 0;
  for (const g of (data && data.games) || []) {
    if (validGame(g)) added += Number(q.addGame.run(g.id, g.w, new Date(g.at).toISOString(), null, Date.now()).changes);
  }
  q.setMeta.run(key, '1');
  if (added) bump();
  console.log('imported ' + added + ' new games');
}

// ---------- helpers ----------
const ID_RE = /^[A-Za-z0-9_-]{6,40}$/;
function validGame(g) {
  return g && typeof g.id === 'string' && ID_RE.test(g.id) && (g.w === 0 || g.w === 1) &&
    typeof g.at === 'string' && !isNaN(Date.parse(g.at));
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
function hashPin(pin, salt) { return crypto.scryptSync(PEPPER + pin, salt, 32); }
function checkPin(pin, user) {
  if (!user.pin_hash) return false;
  const h = hashPin(pin, user.pin_salt);
  return h.length === user.pin_hash.length && crypto.timingSafeEqual(h, Buffer.from(user.pin_hash));
}
const PIN_RE = /^\d{4,6}$/;

function startSession(res, slot, secure) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  q.addSession.run(sha(token), slot, now, now);
  setCookie(res, token, secure);
}
function setCookie(res, token, secure) {
  res.setHeader('Set-Cookie', 'dt_session=' + token + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=' + (SESSION_MS / 1000) + (secure ? '; Secure' : ''));
}
function clearCookie(res, secure) {
  res.setHeader('Set-Cookie', 'dt_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' + (secure ? '; Secure' : ''));
}
function cookieToken(req) {
  const m = /(?:^|;\s*)dt_session=([A-Za-z0-9_-]+)/.exec(req.headers.cookie || '');
  return m ? m[1] : null;
}
function whoAmI(req, res, secure) {
  const token = cookieToken(req);
  if (!token) return null;
  const h = sha(token);
  const s = q.session.get(h);
  if (!s) return null;
  const now = Date.now();
  if (now - s.last_seen > SESSION_MS) { q.delSession.run(h); return null; }
  if (now - s.last_seen > REFRESH_MS) { q.touchSession.run(now, h); setCookie(res, token, secure); }
  return { slot: s.slot, tokenHash: h };
}

function send(res, status, obj, extra) {
  const body = JSON.stringify(obj);
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  }, extra || {}));
  res.end(body);
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('too big'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(v && typeof v === 'object' ? v : {}); }
      catch (e) { reject(Object.assign(new Error('bad json'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}
const lockText = (ms) => {
  const s = Math.ceil(ms / 1000);
  return s < 90 ? s + ' seconds' : Math.ceil(s / 60) + ' minutes';
};

function state(me) {
  const users = q.users.all();
  return {
    rev: rev(),
    me: me,
    names: users.map((u) => u.name),
    games: q.games.all().map((g) => ({ id: g.id, w: g.w, at: g.at }))
  };
}

// ---------- API ----------
async function api(req, res, url, secure) {
  const m = req.method;
  const p = url.pathname;
  if (m !== 'GET' && m !== 'HEAD') {
    const origin = req.headers.origin;
    if (origin) {
      let ok = false;
      try { ok = new URL(origin).host === req.headers.host; } catch (e) { /* bad origin */ }
      if (!ok) return send(res, 403, { error: 'forbidden' });
    }
  }

  if (p === '/api/session' && m === 'GET') {
    const who = whoAmI(req, res, secure);
    return send(res, 200, { me: who ? who.slot : null, users: q.users.all().map((u) => ({ slot: u.slot, name: u.name, hasPin: !!u.has_pin })) });
  }

  if ((p === '/api/login' || p === '/api/setup-pin') && m === 'POST') {
    const b = await readJson(req);
    const slot = b.slot;
    const pin = typeof b.pin === 'string' ? b.pin : '';
    if (slot !== 0 && slot !== 1) return send(res, 400, { error: 'bad-request', message: 'Pick who you are first.' });
    if (!PIN_RE.test(pin)) return send(res, 400, { error: 'bad-pin', message: 'A PIN is 4 to 6 digits.' });
    const user = q.user.get(slot);
    if (!user) return send(res, 400, { error: 'bad-request' });
    const now = Date.now();
    if (user.locked_until > now) {
      return send(res, 429, { error: 'locked', retryIn: user.locked_until - now, message: 'Too many tries. Wait ' + lockText(user.locked_until - now) + ' and try again.' });
    }
    if (p === '/api/setup-pin') {
      if (user.pin_hash) return send(res, 409, { error: 'has-pin', message: 'That account already has a PIN.' });
      const salt = crypto.randomBytes(16);
      q.setPin.run(salt, hashPin(pin, salt), slot);
      startSession(res, slot, secure);
      return send(res, 200, { me: slot });
    }
    if (!user.pin_hash) return send(res, 409, { error: 'no-pin', message: 'Choose a PIN first.' });
    if (!checkPin(pin, user)) {
      const fails = user.fails + 1;
      const wait = fails >= 5 ? Math.min(15 * 60 * 1000, 30 * 1000 * Math.pow(2, fails - 5)) : 0;
      q.setFails.run(fails, wait ? now + wait : 0, slot);
      return send(res, 401, { error: 'wrong-pin', message: wait ? 'Wrong PIN. Wait ' + lockText(wait) + ' and try again.' : 'Wrong PIN.', triesLeft: Math.max(0, 5 - fails) });
    }
    q.setFails.run(0, 0, slot);
    startSession(res, slot, secure);
    return send(res, 200, { me: slot });
  }

  const who = whoAmI(req, res, secure);

  if (p === '/api/logout' && m === 'POST') {
    if (who) q.delSession.run(who.tokenHash);
    clearCookie(res, secure);
    return send(res, 200, { ok: true });
  }

  if (!who) return send(res, 401, { error: 'signed-out' });

  if (p === '/api/state' && m === 'GET') {
    const since = url.searchParams.get('since');
    if (since !== null && Number(since) === rev()) return send(res, 200, { rev: rev(), me: who.slot, unchanged: true });
    return send(res, 200, state(who.slot));
  }

  if (p === '/api/games' && m === 'POST') {
    const g = await readJson(req);
    if (!validGame(g)) return send(res, 400, { error: 'bad-game' });
    const at = new Date(g.at);
    if (at.getTime() > Date.now() + 36 * 3600 * 1000) return send(res, 400, { error: 'bad-game' });
    const r = q.addGame.run(g.id, g.w, at.toISOString(), who.slot, Date.now());
    if (r.changes) bump();
    return send(res, 200, { rev: rev() });
  }

  const del = /^\/api\/games\/([A-Za-z0-9_-]{6,40})$/.exec(p);
  if (del && m === 'DELETE') {
    const r = q.delGame.run(del[1]);
    if (r.changes) bump();
    return send(res, 200, { rev: rev() });
  }

  if (p === '/api/export' && m === 'GET') {
    const s = state(who.slot);
    return send(res, 200, { app: 'monopoly-deal-tally', version: 2, exportedAt: new Date().toISOString(), names: s.names, games: s.games });
  }

  if (p === '/api/change-pin' && m === 'POST') {
    const b = await readJson(req);
    const user = q.user.get(who.slot);
    if (typeof b.oldPin !== 'string' || typeof b.newPin !== 'string' || !PIN_RE.test(b.newPin)) {
      return send(res, 400, { error: 'bad-pin', message: 'A PIN is 4 to 6 digits.' });
    }
    const now = Date.now();
    if (user.locked_until > now) return send(res, 429, { error: 'locked', message: 'Too many tries. Wait ' + lockText(user.locked_until - now) + ' and try again.' });
    if (!PIN_RE.test(b.oldPin) || !checkPin(b.oldPin, user)) {
      const fails = user.fails + 1;
      const wait = fails >= 5 ? Math.min(15 * 60 * 1000, 30 * 1000 * Math.pow(2, fails - 5)) : 0;
      q.setFails.run(fails, wait ? now + wait : 0, who.slot);
      return send(res, 401, { error: 'wrong-pin', message: 'Your current PIN is wrong.' });
    }
    const salt = crypto.randomBytes(16);
    q.setPin.run(salt, hashPin(b.newPin, salt), who.slot);
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { error: 'not-found' });
}

// ---------- static files ----------
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};
function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    const ext = path.extname(file).toLowerCase();
    const cache = ext === '.woff' || ext === '.png' ? 'public, max-age=86400' : 'no-cache';
    res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': cache });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const server = http.createServer(async (req, res) => {
  const secure = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', CSP);
  if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
    if (url.pathname.startsWith('/api/')) return await api(req, res, url, secure);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    return serveStatic(req, res, url);
  } catch (e) {
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'server-error' });
    if (!e.status) console.error(e);
  }
});

// ---------- start ----------
loadSeed();
applyImport();
// Forgotten PIN: set RESET_PIN to a player's name (or "all") in the Railway variables, redeploy, then remove it.
if (process.env.RESET_PIN) {
  const want = process.env.RESET_PIN.trim().toLowerCase();
  q.users.all().forEach((u) => {
    if (want === 'all' || want === u.name.toLowerCase()) {
      q.clearPin.run(u.slot); q.delSlotSessions.run(u.slot);
      console.log('PIN cleared for ' + u.name + '. Remove the RESET_PIN variable now.');
    }
  });
}
q.expireSessions.run(Date.now() - SESSION_MS);
server.listen(PORT, '0.0.0.0', () => console.log('Deal Tally listening on ' + PORT + ', data in ' + DATA_DIR + ', ' + q.countGames.get().n + ' games'));
function stop() { server.close(); try { db.close(); } catch (e) { /* closing anyway */ } process.exit(0); }
process.on('SIGTERM', stop); process.on('SIGINT', stop);
