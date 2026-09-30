// Die Konfiguration des Spiels: Titel, Karte und die Schätze.
//
// Liegt als eine JSON-Datei auf der Platte (DATA_FILE). Was die Kinder
// gefunden haben, steht NICHT hier, sondern nur im localStorage ihrer
// Geräte - der Server kennt keine Spieler.

import { randomBytes } from 'node:crypto';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

// Ohne 0/O, 1/I/L: der Code steht auch zum Abtippen unter dem QR-Code.
const TOKEN_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const TOKEN_LENGTH = 8;
export const TOKEN_RE = new RegExp(`^[${TOKEN_ALPHABET}]{${TOKEN_LENGTH}}$`);
const ID_RE = /^[a-z0-9]{4,16}$/;

const LIMITS = { title: 80, subtitle: 200, finale: 600, name: 60, emoji: 16, hint: 300, reward: 400, url: 200 };
const MAX_CODES = 100;

export function newToken() {
  const bytes = randomBytes(TOKEN_LENGTH);
  let out = '';
  for (const b of bytes) out += TOKEN_ALPHABET[b % TOKEN_ALPHABET.length];
  return out;
}

function newId() {
  return randomBytes(6).toString('hex');
}

export class ValidationError extends Error {}

function str(value, max, field, { required = false } = {}) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') throw new ValidationError(`${field}: Text erwartet`);
  const v = value.trim();
  if (required && !v) throw new ValidationError(`${field}: darf nicht leer sein`);
  if (v.length > max) throw new ValidationError(`${field}: höchstens ${max} Zeichen`);
  return v;
}

function num(value, min, max, field) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new ValidationError(`${field}: Zahl zwischen ${min} und ${max} erwartet`);
  return n;
}

// Prüft eine Konfiguration, wie sie das Admin-UI schickt, und vergibt
// fehlende IDs und Tokens. Bekannte Tokens bleiben stehen, damit schon
// aufgehängte QR-Codes gültig bleiben.
export function normalizeConfig(input) {
  if (!input || typeof input !== 'object') throw new ValidationError('Konfiguration fehlt');
  const map = input.map || {};
  const center = Array.isArray(map.center) ? map.center : [];
  const config = {
    title: str(input.title, LIMITS.title, 'Titel', { required: true }),
    subtitle: str(input.subtitle, LIMITS.subtitle, 'Untertitel'),
    finale: str(input.finale, LIMITS.finale, 'Schlussbotschaft'),
    publicUrl: str(input.publicUrl, LIMITS.url, 'Öffentliche Adresse').replace(/\/+$/, ''),
    map: {
      center: [num(center[0], -90, 90, 'Kartenmitte (Breite)'), num(center[1], -180, 180, 'Kartenmitte (Länge)')],
      zoom: Math.round(num(map.zoom, 3, 19, 'Zoom')),
    },
    codes: [],
  };
  if (config.publicUrl && !/^https?:\/\/[^\s/]+/.test(config.publicUrl)) {
    throw new ValidationError('Öffentliche Adresse: muss mit http:// oder https:// beginnen');
  }

  const codes = Array.isArray(input.codes) ? input.codes : [];
  if (codes.length > MAX_CODES) throw new ValidationError(`Höchstens ${MAX_CODES} Schätze`);
  const ids = new Set();
  const tokens = new Set();
  codes.forEach((c, i) => {
    const label = `Schatz ${i + 1}`;
    if (!c || typeof c !== 'object') throw new ValidationError(`${label}: ungültig`);
    let id = typeof c.id === 'string' && ID_RE.test(c.id) ? c.id : newId();
    while (ids.has(id)) id = newId();
    let token = typeof c.token === 'string' && TOKEN_RE.test(c.token) ? c.token : newToken();
    while (tokens.has(token)) token = newToken();
    ids.add(id);
    tokens.add(token);
    config.codes.push({
      id,
      token,
      emoji: str(c.emoji, LIMITS.emoji, `${label}, Symbol`) || '⭐',
      name: str(c.name, LIMITS.name, `${label}, Name`, { required: true }),
      hint: str(c.hint, LIMITS.hint, `${label}, Rätsel`, { required: true }),
      reward: str(c.reward, LIMITS.reward, `${label}, Belohnung`),
      lat: num(c.lat, -90, 90, `${label}, Breite`),
      lng: num(c.lng, -180, 180, `${label}, Länge`),
    });
  });
  return config;
}

export class ConfigStore {
  constructor(file, seedFile) {
    this.file = file;
    this.seedFile = seedFile;
    this.config = null;
    this.writing = Promise.resolve();
  }

  async load() {
    let raw;
    let seeded = false;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      raw = await readFile(this.seedFile, 'utf8');
      seeded = true;
    }
    this.config = normalizeConfig(JSON.parse(raw));
    // Beim ersten Start die Vorlage mit frisch gewürfelten Tokens
    // festschreiben - sonst hätte jeder Neustart andere QR-Codes.
    if (seeded) await this.save(this.config);
    return this.config;
  }

  async save(input) {
    const config = normalizeConfig(input);
    // Schreibvorgänge nacheinander, und atomar über eine Temp-Datei.
    const run = this.writing.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(config, null, 2) + '\n', 'utf8');
      await rename(tmp, this.file);
      this.config = config;
    });
    this.writing = run.catch(() => {});
    await run;
    return config;
  }
}
