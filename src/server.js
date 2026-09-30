// Schatzsuche am Chrischtchindlimärit Steffisburg - HTTP-Server.
//
// Node ohne Abhängigkeiten. Liefert die Seiten aus public/ aus und
// eine kleine JSON-API:
//
//   GET  /api/health          Healthcheck
//   GET  /api/game            Spiel für die Kinder - OHNE Orte und Tokens
//   GET  /api/find/:token     ein gescannter Schatz, jetzt mit Ort
//   POST /api/reveal          alle gefundenen Schätze auf einmal auffrischen
//   POST /api/admin/login     Passwort -> Token
//   GET  /api/admin/config    ganze Konfiguration (Admin)
//   PUT  /api/admin/config    ganze Konfiguration speichern (Admin)

import { createServer } from 'node:http';
import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigStore, ValidationError, TOKEN_RE } from './config-store.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PUBLIC_DIR = join(ROOT, 'public');
const ADMIN_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_BODY = 256 * 1024;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    // Leaflet positioniert Kacheln und Marker über style-Attribute.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://tile.openstreetmap.org",
    "connect-src 'self'",
    "media-src 'self' blob:",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  // Die Kamera braucht der Scanner, den Standort der "Wo bin ich?"-Knopf.
  'Permissions-Policy': 'camera=(self), geolocation=(self), microphone=()',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

function json(res, status, data) {
  send(res, status, JSON.stringify(data), {
    'Content-Type': TYPES['.json'],
    'Cache-Control': 'no-store',
  });
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Anfrage zu gross'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolveBody(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(Object.assign(new Error('Ungültiges JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

// Was ein Kind VOR dem Fund sieht: Rätsel ja, Ort und Token nein.
function publicCode(c, i) {
  return { id: c.id, number: i + 1, emoji: c.emoji, name: c.name, hint: c.hint };
}

// Was ein Kind NACH dem Fund sieht.
function foundCode(c, i) {
  return { ...publicCode(c, i), token: c.token, reward: c.reward, lat: c.lat, lng: c.lng };
}

export function createApp({ dataFile, seedFile, adminPassword, secret }) {
  const store = new ConfigStore(dataFile, seedFile);
  const hmacKey = secret || randomBytes(32).toString('hex');
  const passwordHash = adminPassword ? createHash('sha256').update(adminPassword).digest() : null;

  function sign(payload) {
    return createHmac('sha256', hmacKey).update(payload).digest('base64url');
  }

  function issueToken() {
    const exp = String(Date.now() + ADMIN_TTL_MS);
    return `${exp}.${sign(`admin:${exp}`)}`;
  }

  function isAdmin(req) {
    const header = req.headers.authorization || '';
    const m = /^Bearer (\d+)\.([\w-]+)$/.exec(header);
    if (!m) return false;
    const [, exp, sig] = m;
    if (Number(exp) < Date.now()) return false;
    const expected = Buffer.from(sign(`admin:${exp}`));
    const given = Buffer.from(sig);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  function checkPassword(given) {
    if (!passwordHash || typeof given !== 'string') return false;
    const h = createHash('sha256').update(given).digest();
    return timingSafeEqual(h, passwordHash);
  }

  async function serveStatic(res, urlPath) {
    let rel = urlPath;
    if (rel === '/' || rel.startsWith('/f/')) rel = '/index.html';
    else if (rel === '/admin' || rel === '/admin/') rel = '/admin.html';
    const file = normalize(join(PUBLIC_DIR, decodeURIComponent(rel)));
    if (!file.startsWith(PUBLIC_DIR + sep)) return json(res, 404, { error: 'Nicht gefunden' });
    try {
      const info = await stat(file);
      if (!info.isFile()) throw new Error('kein File');
      const body = await readFile(file);
      const type = TYPES[extname(file)] || 'application/octet-stream';
      // Die Bibliotheken ändern sich nie, der Rest soll nach einem Update
      // sofort frisch sein.
      const cache = rel.startsWith('/vendor/') ? 'public, max-age=604800' : 'no-cache';
      send(res, 200, body, { 'Content-Type': type, 'Cache-Control': cache });
    } catch {
      json(res, 404, { error: 'Nicht gefunden' });
    }
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    const method = req.method;
    const config = store.config;

    if (path === '/api/health' && method === 'GET') {
      return json(res, 200, { status: 'ok', codes: config.codes.length });
    }

    if (path === '/api/game' && method === 'GET') {
      return json(res, 200, {
        title: config.title,
        subtitle: config.subtitle,
        map: config.map,
        total: config.codes.length,
        codes: config.codes.map(publicCode),
      });
    }

    const find = /^\/api\/find\/([A-Za-z0-9-]+)$/.exec(path);
    if (find && method === 'GET') {
      const token = find[1].toUpperCase().replace(/-/g, '');
      const i = TOKEN_RE.test(token) ? config.codes.findIndex((c) => c.token === token) : -1;
      if (i < 0) return json(res, 404, { error: 'Diesen Schatz gibt es nicht' });
      return json(res, 200, foundCode(config.codes[i], i));
    }

    if (path === '/api/reveal' && method === 'POST') {
      const body = await readBody(req);
      const tokens = new Set(Array.isArray(body.tokens) ? body.tokens.slice(0, 200).filter((t) => typeof t === 'string') : []);
      const codes = [];
      config.codes.forEach((c, i) => {
        if (tokens.has(c.token)) codes.push(foundCode(c, i));
      });
      // Die Schlussbotschaft (z. B. "Hol dir am Stand X eine Überraschung")
      // gibt es erst, wenn wirklich alle gefunden sind.
      const complete = config.codes.length > 0 && codes.length === config.codes.length;
      return json(res, 200, { codes, total: config.codes.length, complete, finale: complete ? config.finale : '' });
    }

    if (path === '/api/admin/login' && method === 'POST') {
      if (!passwordHash) return json(res, 503, { error: 'Kein Admin-Passwort gesetzt (ADMIN_PASSWORD)' });
      const body = await readBody(req);
      if (!checkPassword(body.password)) return json(res, 401, { error: 'Falsches Passwort' });
      return json(res, 200, { token: issueToken() });
    }

    if (path === '/api/admin/config') {
      if (!isAdmin(req)) return json(res, 401, { error: 'Bitte neu anmelden' });
      if (method === 'GET') return json(res, 200, config);
      if (method === 'PUT') {
        const body = await readBody(req);
        try {
          return json(res, 200, await store.save(body));
        } catch (err) {
          if (err instanceof ValidationError) return json(res, 400, { error: err.message });
          throw err;
        }
      }
    }

    if (path.startsWith('/api/')) return json(res, 404, { error: 'Nicht gefunden' });
    if (method !== 'GET' && method !== 'HEAD') return json(res, 405, { error: 'Methode nicht erlaubt' });
    return serveStatic(res, path);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      const status = err.status || 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) json(res, status, { error: status === 500 ? 'Interner Fehler' : err.message });
    });
  });

  return { server, store };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  if (!process.env.ADMIN_PASSWORD) console.warn('ADMIN_PASSWORD fehlt - das Admin-UI bleibt gesperrt.');
  if (!process.env.SECRET) console.warn('SECRET fehlt - Admin-Logins überleben keinen Neustart.');
  const { server, store } = createApp({
    dataFile: process.env.DATA_FILE || join(ROOT, 'data', 'config.json'),
    seedFile: join(ROOT, 'config', 'default-config.json'),
    adminPassword: process.env.ADMIN_PASSWORD,
    secret: process.env.SECRET,
  });
  await store.load();
  server.listen(port, () => console.log(`Schatzsuche läuft auf Port ${port} (${store.config.codes.length} Schätze)`));
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
