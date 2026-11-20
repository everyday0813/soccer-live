'use strict';

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');

// Optional local .env (Docker passes env via env_file; existing vars win).
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') {
  try { process.loadEnvFile(envFile); } catch (err) { console.warn(`[env] could not load .env: ${err.message}`); }
}

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
if (!ADMIN_PASSWORD.trim()) {
  console.error('FATAL: ADMIN_PASSWORD is not set. Set ADMIN_PASSWORD in the environment (or .env) and restart.');
  process.exit(1);
}

const express = require('express');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

const config = require('./config.json');
const { openDb } = require('./db');
const { FixtureService } = require('./espn');

function secretFromEnv(name) {
  const v = process.env[name];
  if (v && v.trim()) return v;
  console.warn(`[warn] ${name} is not set; using a random value for this process (set it in .env for production).`);
  return crypto.randomBytes(32).toString('hex');
}

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const UPLOADS_DIR = path.resolve(process.env.UPLOADS_DIR || path.join(DATA_DIR, 'uploads'));
const SESSION_SECRET = secretFromEnv('SESSION_SECRET');
const IP_SALT = secretFromEnv('IP_SALT');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_TTL_MS = 12 * 3600 * 1000;
const SITE_NAME = 'បាល់ទាត់ផ្ទាល់';
const DEFAULT_COMMENT_NAME = 'អ្នកគាំទ្រ';

fs.mkdirSync(UPLOADS_DIR, { recursive: true });
const db = openDb(DATA_DIR);
const fixtures = new FixtureService(config);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPrivatePeer(addr) {
  if (!addr) return false;
  const a = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
  if (a === '::1' || a.startsWith('127.')) return true;
  if (/^10\./.test(a) || /^192\.168\./.test(a)) return true;
  const m = /^172\.(\d+)\./.exec(a);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  return /^f[cd][0-9a-f]{2}:/i.test(a);
}

/**
 * Real client IP. Behind Cloudflare (cloudflared -> 127.0.0.1 -> container)
 * CF-Connecting-IP carries the visitor address; only trust it when the TCP
 * peer is local/private, i.e. the request really came through our proxy.
 * Otherwise fall back to Express' trust-proxy aware req.ip.
 */
function clientIp(req) {
  const cf = (req.get('cf-connecting-ip') || '').trim();
  if (cf && net.isIP(cf) && isPrivatePeer(req.socket.remoteAddress)) return cf;
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function ipHash(req) {
  const ip = clientIp(req);
  // Collapse IPv6 to its /56 so one host can't rotate addresses past limits.
  const key = net.isIPv6(ip) ? ipKeyGenerator(ip) : ip;
  return crypto.createHash('sha256').update(key + IP_SALT).digest('hex');
}

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g;
const VISIBLE = /[^\s\u200B-\u200D\u2060\uFEFF]/;

function cleanText(value, { multiline }) {
  let s = typeof value === 'string' ? value : '';
  s = s.normalize('NFC').replace(/\r\n?/g, '\n').replace(CONTROL_CHARS, '');
  s = multiline ? s.replace(/\t/g, ' ').replace(/\n{3,}/g, '\n\n') : s.replace(/\s+/g, ' ');
  return s.trim();
}

const charLen = (s) => [...s].length;
const isMatchId = (id) => typeof id === 'string' && /^\d{1,15}$/.test(id);

function safeHttpUrl(raw, max = 2000) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.length > max) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Accepts a bare URL or a pasted `<iframe src="...">` embed code. */
function parseStreamInput(raw) {
  let s = typeof raw === 'string' ? raw.trim() : '';
  const iframe = /<iframe[^>]*\ssrc\s*=\s*["']([^"']+)["']/i.exec(s);
  if (iframe) s = iframe[1].replace(/&amp;/g, '&');
  const url = safeHttpUrl(s);
  if (!url) return null;
  const kind = /\.m3u8$/i.test(new URL(url).pathname) ? 'hls' : 'embed';
  return { url, kind };
}

function streamIdSet() {
  return new Set(db.allStreams().map((s) => s.match_id));
}

function bannerView(b) {
  if (!b) return null;
  return {
    slot: b.slot,
    type: b.type,
    imageUrl: b.imagePath ? `/uploads/${encodeURIComponent(b.imagePath)}` : null,
    linkUrl: b.linkUrl,
    html: b.type === 'html' ? b.html : null,
    updatedAt: b.updatedAt,
  };
}

function showPlaceholders() {
  return db.getSetting('showAdPlaceholders') !== 'false';
}

function slotsConfig() {
  return { showAdPlaceholders: showPlaceholders(), slots: db.listBanners().map(bannerView) };
}

const escHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// JSON safe to embed inside <script type="application/json">.
const jsonForHtml = (obj) =>
  JSON.stringify(obj).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

function detectImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.toString('latin1', 0, 4) === 'GIF8') return 'gif';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

function removeUpload(name) {
  if (!name) return;
  const p = path.join(UPLOADS_DIR, path.basename(name));
  fs.rm(p, { force: true }, () => {});
}

// ---------------------------------------------------------------------------
// Sessions (in-memory; a restart simply logs the admin out)
// ---------------------------------------------------------------------------

const sessions = new Map(); // token -> expiresAt

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}

function isAdmin(req) {
  const token = req.signedCookies && req.signedCookies.sid;
  if (!token) return false;
  const exp = sessions.get(token);
  if (!exp || exp < Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [t, exp] of sessions) if (exp < now) sessions.delete(t);
}, 10 * 60 * 1000).unref();

function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return res.status(401).json({ error: 'unauthorized' });
  next();
}

function passwordMatches(input) {
  const a = crypto.createHash('sha256').update(String(input || '')).digest();
  const b = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  });
  next();
});

app.use(cookieParser(SESSION_SECRET));
app.use(express.json({ limit: '128kb' }));

const limiterDefaults = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: ipHash,
  validate: { trustProxy: false, xForwardedForHeader: false, keyGeneratorIpFallback: false },
};

const apiLimiter = rateLimit({
  ...limiterDefaults,
  windowMs: 60 * 1000,
  limit: 300,
  handler: (req, res) => res.status(429).json({ error: 'rate_limited' }),
});

const commentLimiter = rateLimit({
  ...limiterDefaults,
  windowMs: 10 * 1000,
  limit: 1,
  skipFailedRequests: true,
  handler: (req, res, next, opts) =>
    res.status(429).json({ error: 'rate_limited', retryAfter: Math.ceil(opts.windowMs / 1000) }),
});

const loginLimiter = rateLimit({
  ...limiterDefaults,
  windowMs: 15 * 60 * 1000,
  limit: 5,
  skipSuccessfulRequests: true,
  handler: (req, res) => res.status(429).json({ error: 'too_many_attempts' }),
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send('User-agent: *\nDisallow: /admin\nDisallow: /api/\n');
});

app.use('/api', apiLimiter, (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// ----- Public API ----------------------------------------------------------

app.get('/api/matches', async (req, res) => {
  try {
    const data = await fixtures.getMatches();
    const streams = streamIdSet();
    for (const m of data.matches) m.hasStream = streams.has(m.id);
    res.json(data);
  } catch (err) {
    console.error('[api/matches]', err);
    res.json({ updatedAt: new Date().toISOString(), matches: [] });
  }
});

app.get('/api/match/:id', async (req, res) => {
  const { id } = req.params;
  if (!isMatchId(id)) return res.status(404).json({ error: 'not_found' });
  let match = null;
  try {
    match = await fixtures.getMatch(id);
  } catch (err) {
    console.error('[api/match]', err);
  }
  const s = db.getStream(id);
  if (!match) return res.status(404).json({ error: 'not_found', stream: s ? { url: s.url, kind: s.kind } : null });
  match.hasStream = !!s;
  res.json({ match, stream: s ? { url: s.url, kind: s.kind } : null });
});

app.get('/api/slots', (req, res) => res.json(slotsConfig()));

async function matchKnown(id) {
  if (fixtures.peekMatch(id)) return true;
  if (db.getStream(id) || db.hasComments(id)) return true;
  try {
    return !!(await fixtures.getMatch(id));
  } catch {
    return false;
  }
}

app.get('/api/match/:id/comments', (req, res) => {
  const { id } = req.params;
  if (!isMatchId(id)) return res.status(404).json({ error: 'not_found' });
  const after = Math.max(0, parseInt(req.query.after, 10) || 0);
  res.json({ comments: db.listComments(id, after, 200), count: db.countComments(id) });
});

app.post('/api/match/:id/comments', commentLimiter, async (req, res) => {
  const { id } = req.params;
  if (!isMatchId(id) || !(await matchKnown(id))) return res.status(404).json({ error: 'unknown_match' });

  const body = cleanText(req.body && req.body.body, { multiline: true });
  let name = cleanText(req.body && req.body.name, { multiline: false });
  if (!body || !VISIBLE.test(body) || charLen(body) > 500) {
    return res.status(400).json({ error: 'invalid_body', max: 500 });
  }
  if (charLen(name) > 40) return res.status(400).json({ error: 'invalid_name', max: 40 });
  if (!name || !VISIBLE.test(name)) name = DEFAULT_COMMENT_NAME;

  const comment = db.addComment({ matchId: id, name, body, ipHash: ipHash(req) });
  res.status(201).json({ comment });
});

// ----- Admin API -----------------------------------------------------------

function sessionCookieOptions(req) {
  return { httpOnly: true, sameSite: 'lax', secure: req.secure, signed: true, path: '/', maxAge: SESSION_TTL_MS };
}

app.post('/api/admin/login', loginLimiter, (req, res) => {
  if (!passwordMatches(req.body && req.body.password)) return res.status(401).json({ error: 'invalid_password' });
  res.cookie('sid', createSession(), sessionCookieOptions(req));
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  const token = req.signedCookies && req.signedCookies.sid;
  if (token) sessions.delete(token);
  const { maxAge, ...opts } = sessionCookieOptions(req);
  res.clearCookie('sid', opts);
  res.json({ ok: true });
});

app.get('/api/admin/state', requireAdmin, async (req, res) => {
  let matches = [];
  try {
    matches = await fixtures.getAdminMatches();
  } catch (err) {
    console.error('[admin/state]', err);
  }
  const streams = {};
  for (const s of db.allStreams()) streams[s.match_id] = s.url;
  for (const m of matches) m.hasStream = Object.prototype.hasOwnProperty.call(streams, m.id);
  res.json({
    streams,
    banners: db.listBanners().map(bannerView),
    matches,
    settings: { showAdPlaceholders: showPlaceholders() },
  });
});

app.post('/api/admin/stream', requireAdmin, (req, res) => {
  const matchId = String((req.body && req.body.matchId) || '');
  if (!isMatchId(matchId)) return res.status(400).json({ error: 'invalid_match_id' });
  const raw = req.body && typeof req.body.url === 'string' ? req.body.url.trim() : '';
  if (!raw) {
    db.deleteStream(matchId);
    return res.json({ ok: true, stream: null });
  }
  const parsed = parseStreamInput(raw);
  if (!parsed) return res.status(400).json({ error: 'invalid_url' });
  db.setStream(matchId, parsed.url, parsed.kind);
  res.json({ ok: true, stream: parsed });
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024, files: 1, fields: 10 },
});

function parseSlot(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 3 ? n : null;
}

app.post('/api/admin/banner', requireAdmin, (req, res, next) => {
  upload.single('image')(req, res, (err) => {
    if (err) {
      const tooBig = err.code === 'LIMIT_FILE_SIZE';
      return res.status(tooBig ? 413 : 400).json({ error: tooBig ? 'file_too_large' : 'invalid_upload' });
    }
    next();
  });
}, (req, res) => {
  const b = req.body || {};
  const slot = parseSlot(b.slot);
  if (!slot) return res.status(400).json({ error: 'invalid_slot' });
  const prev = db.getBanner(slot);

  if (b.type === 'html') {
    const html = typeof b.html === 'string' ? b.html.trim() : '';
    if (!html || html.length > 50000) return res.status(400).json({ error: 'invalid_html' });
    db.setBanner({ slot, type: 'html', html });
    if (prev && prev.imagePath) removeUpload(prev.imagePath);
    return res.json({ ok: true, banner: bannerView(db.getBanner(slot)) });
  }

  const linkUrl = safeHttpUrl(b.linkUrl);
  if (!linkUrl) return res.status(400).json({ error: 'invalid_link_url' });

  let imagePath = prev && prev.type === 'image' ? prev.imagePath : null;
  if (req.file) {
    const ext = detectImage(req.file.buffer);
    if (!ext) return res.status(400).json({ error: 'unsupported_image' });
    imagePath = `slot${slot}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
    fs.writeFileSync(path.join(UPLOADS_DIR, imagePath), req.file.buffer, { mode: 0o644 });
  }
  if (!imagePath) return res.status(400).json({ error: 'image_required' });

  db.setBanner({ slot, type: 'image', imagePath, linkUrl });
  if (prev && prev.imagePath && prev.imagePath !== imagePath) removeUpload(prev.imagePath);
  res.json({ ok: true, banner: bannerView(db.getBanner(slot)) });
});

app.delete('/api/admin/banner/:slot', requireAdmin, (req, res) => {
  const slot = parseSlot(req.params.slot);
  if (!slot) return res.status(400).json({ error: 'invalid_slot' });
  const prev = db.getBanner(slot);
  db.deleteBanner(slot);
  if (prev && prev.imagePath) removeUpload(prev.imagePath);
  res.json({ ok: true });
});

app.post('/api/admin/settings', requireAdmin, (req, res) => {
  const v = req.body && req.body.showAdPlaceholders;
  if (typeof v !== 'boolean') return res.status(400).json({ error: 'invalid_settings' });
  db.setSetting('showAdPlaceholders', v ? 'true' : 'false');
  res.json({ ok: true, settings: { showAdPlaceholders: v } });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));

// ----- Pages & static ------------------------------------------------------

const readPage = (name) => fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8');
const pages = { index: readPage('index.html'), match: readPage('match.html'), admin: readPage('admin.html') };

function sendHtml(res, html, status = 200, extraHeaders = {}) {
  res.status(status).set({
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Content-Security-Policy': "frame-ancestors 'self'",
    ...extraHeaders,
  }).send(html);
}

app.get(['/', '/index.html'], (req, res) => sendHtml(res, pages.index));

app.get('/match/:id', async (req, res) => {
  const { id } = req.params;
  if (!isMatchId(id)) return sendHtml(res, notFoundPage(), 404);
  let match = null;
  try {
    match = await fixtures.getMatch(id);
  } catch { /* render without match data; the page fetches it itself */ }

  const cfg = slotsConfig();
  const s = db.getStream(id);
  const stream = s ? { url: s.url, kind: s.kind } : null;
  if (match) match.hasStream = !!stream;
  const filled = new Set(cfg.slots.map((s) => s.slot));
  let html = pages.match;
  if (match) {
    const title = `${match.home.name} vs ${match.away.name} · ${SITE_NAME}`;
    html = html
      .replace(/<title>[^<]*<\/title>/, `<title>${escHtml(title)}</title>`)
      .replace(/(<meta property="og:title" content=")[^"]*(")/, `$1${escHtml(title)}$2`);
  }
  // Collapse empty slots server-side when placeholders are off (no layout shift).
  for (const n of [1, 2, 3]) {
    if (!filled.has(n) && !cfg.showAdPlaceholders) html = html.replace(`data-slot="${n}"`, `data-slot="${n}" hidden`);
  }
  html = html.replace(
    '<script id="page-data" type="application/json">{}</script>',
    `<script id="page-data" type="application/json">${jsonForHtml({ match, stream, slots: cfg })}</script>`
  );
  sendHtml(res, html);
});

app.get('/admin', (req, res) => {
  sendHtml(res, pages.admin, 200, {
    'Content-Security-Policy':
      "default-src 'self'; img-src 'self' https: data:; style-src 'self' https://fonts.googleapis.com; " +
      "font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
    'X-Robots-Tag': 'noindex, nofollow',
  });
});

app.use('/uploads', express.static(UPLOADS_DIR, { maxAge: '30d', immutable: true, index: false, dotfiles: 'deny' }));
app.use('/css', express.static(path.join(PUBLIC_DIR, 'css'), { maxAge: '10m' }));
app.use('/js', express.static(path.join(PUBLIC_DIR, 'js'), { maxAge: '10m' }));

function notFoundPage() {
  return `<!doctype html><html lang="km"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>404 · ${SITE_NAME}</title><link rel="stylesheet" href="/css/app.css"></head>
<body><main class="container narrow center-page"><p class="big-404">404</p><a class="btn" href="/">ត្រឡប់ក្រោយ</a></main></body></html>`;
}

app.use((req, res) => sendHtml(res, notFoundPage(), 404));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', err);
  if (res.headersSent) return;
  if (req.path.startsWith('/api/')) {
    const status = err.type === 'entity.parse.failed' ? 400 : err.status === 413 ? 413 : 500;
    return res.status(status).json({ error: status === 500 ? 'server_error' : 'bad_request' });
  }
  res.status(500).type('text/plain').send('Server error');
});

// ---------------------------------------------------------------------------

const server = app.listen(PORT, () => {
  console.log(`soccer-live listening on :${PORT} (data: ${DATA_DIR}, uploads: ${UPLOADS_DIR}, leagues: ${config.leagues.length})`);
  fixtures.warmUp().then(() => console.log('[espn] cache warmed')).catch(() => {});
});

function shutdown(sig) {
  console.log(`${sig} received, shutting down`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
