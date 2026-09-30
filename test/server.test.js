import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.js';

const seedFile = fileURLToPath(new URL('../config/default-config.json', import.meta.url));
let dir, server, base, dataFile;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'schatz-'));
  dataFile = join(dir, 'config.json');
  const app = createApp({ dataFile, seedFile, adminPassword: 'geheim', secret: 'test-secret' });
  await app.store.load();
  server = app.server;
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await rm(dir, { recursive: true, force: true });
});

const get = (p, opts) => fetch(base + p, opts);
const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

async function login() {
  const res = await post('/api/admin/login', { password: 'geheim' });
  assert.equal(res.status, 200);
  return (await res.json()).token;
}

test('Healthcheck', async () => {
  const res = await get('/api/health');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'ok');
});

test('Erster Start schreibt die Vorlage mit Tokens fest', async () => {
  const saved = JSON.parse(await readFile(dataFile, 'utf8'));
  assert.ok(saved.codes.length > 0);
  for (const c of saved.codes) assert.match(c.token, /^[A-Z2-9]{8}$/);
});

test('Das Spiel verrät weder Orte noch Tokens', async () => {
  const game = await (await get('/api/game')).json();
  assert.ok(game.total > 0);
  assert.equal(game.codes.length, game.total);
  for (const c of game.codes) {
    assert.equal(c.lat, undefined);
    assert.equal(c.lng, undefined);
    assert.equal(c.token, undefined);
    assert.equal(c.reward, undefined);
    assert.ok(c.hint);
  }
  assert.equal(game.finale, undefined);
});

test('Ein gescannter Token liefert den Schatz mit Ort', async () => {
  const cfg = JSON.parse(await readFile(dataFile, 'utf8'));
  const c = cfg.codes[2];
  for (const variant of [c.token, c.token.toLowerCase(), `${c.token.slice(0, 4)}-${c.token.slice(4)}`]) {
    const res = await get(`/api/find/${variant}`);
    assert.equal(res.status, 200, variant);
    const found = await res.json();
    assert.equal(found.id, c.id);
    assert.equal(found.number, 3);
    assert.equal(found.lat, c.lat);
  }
  assert.equal((await get('/api/find/AAAAAAAA')).status, 404);
  assert.equal((await get('/api/find/zu-kurz')).status, 404);
});

test('Reveal: Schlussbotschaft erst mit allen Schätzen', async () => {
  const cfg = JSON.parse(await readFile(dataFile, 'utf8'));
  const tokens = cfg.codes.map((c) => c.token);
  let res = await (await post('/api/reveal', { tokens: tokens.slice(1) })).json();
  assert.equal(res.complete, false);
  assert.equal(res.finale, '');
  assert.equal(res.codes.length, tokens.length - 1);
  res = await (await post('/api/reveal', { tokens: [...tokens, 'QUATSCH1'] })).json();
  assert.equal(res.complete, true);
  assert.equal(res.finale, cfg.finale);
});

test('Admin: ohne gültiges Token kein Zugriff', async () => {
  assert.equal((await get('/api/admin/config')).status, 401);
  assert.equal((await get('/api/admin/config', { headers: { Authorization: 'Bearer 99999999999999.falsch' } })).status, 401);
  assert.equal((await post('/api/admin/login', { password: 'falsch' })).status, 401);
});

test('Admin: speichern behält Tokens und vergibt neue', async () => {
  const token = await login();
  const auth = { Authorization: `Bearer ${token}` };
  const cfg = await (await get('/api/admin/config', { headers: auth })).json();
  const oldToken = cfg.codes[0].token;
  cfg.codes[0].name = 'Raclette-Schatz';
  cfg.codes.push({ emoji: '🦌', name: 'Rentier', hint: 'Wo steht das Rentier?', reward: '', lat: 46.776, lng: 7.63 });
  const res = await fetch(`${base}/api/admin/config`, { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) });
  assert.equal(res.status, 200);
  const saved = await res.json();
  assert.equal(saved.codes[0].token, oldToken);
  assert.equal(saved.codes[0].name, 'Raclette-Schatz');
  const added = saved.codes.at(-1);
  assert.match(added.token, /^[A-Z2-9]{8}$/);
  assert.match(added.id, /^[a-z0-9]+$/);
  const game = await (await get('/api/game')).json();
  assert.equal(game.total, saved.codes.length);
});

test('Admin: ungültige Konfiguration wird abgelehnt', async () => {
  const token = await login();
  const res = await fetch(`${base}/api/admin/config`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'x', map: { center: [46, 7], zoom: 17 }, codes: [{ name: 'ohne Rätsel', lat: 1, lng: 1 }] }),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Rätsel/);
});

test('Seiten und Sicherheit', async () => {
  for (const p of ['/', '/admin', '/f/ABCD2345']) {
    const res = await get(p);
    assert.equal(res.status, 200, p);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  }
  assert.equal((await get('/../src/server.js')).status, 404);
  assert.equal((await get('/%2e%2e/src/server.js')).status, 404);
  assert.equal((await get('/vendor/leaflet/leaflet.js')).status, 200);
});
