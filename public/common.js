// Gemeinsame Helfer für die Kinder-App und das Admin-UI.
/* exported Schatz */
'use strict';

const Schatz = (() => {
  const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  const TILE_ATTRIBUTION = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

  async function api(path, { method = 'GET', body, token } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    let data = null;
    try { data = await res.json(); } catch { /* leer */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Fehler ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  // Marker als rundes Emoji-Abzeichen mit Nummer - ohne Bilddateien.
  function markerIcon(emoji, number, extraClass = '') {
    const wrap = el('div', { class: `pin ${extraClass}` },
      el('span', { class: 'pin-emoji', text: emoji }),
      number ? el('span', { class: 'pin-num', text: String(number) }) : null);
    return L.divIcon({ html: wrap.outerHTML, className: 'pin-wrap', iconSize: [48, 56], iconAnchor: [24, 52], popupAnchor: [0, -46] });
  }

  function createMap(elementId, map) {
    const m = L.map(elementId, { zoomControl: true, attributionControl: true }).setView(map.center, map.zoom);
    L.tileLayer(TILE_URL, { maxZoom: 19, attribution: TILE_ATTRIBUTION }).addTo(m);
    return m;
  }

  // Der Token zum Abtippen: ABCD-2345
  function prettyToken(token) {
    return token.length === 8 ? `${token.slice(0, 4)}-${token.slice(4)}` : token;
  }

  function cleanToken(text) {
    return String(text || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  // Liest einen Token aus einem gescannten Text: entweder die URL
  // .../f/ABCD2345 oder der blanke Code.
  function tokenFromScan(text) {
    const s = String(text || '').trim();
    const m = /\/f\/([A-Za-z0-9-]{8,9})\/?(?:[?#].*)?$/.exec(s);
    if (m) return cleanToken(m[1]);
    const t = cleanToken(s);
    return t.length === 8 ? t : null;
  }

  function storage(key) {
    return {
      read(fallback) {
        try {
          const raw = localStorage.getItem(key);
          return raw ? JSON.parse(raw) : fallback;
        } catch { return fallback; }
      },
      write(value) {
        try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
      },
      remove() {
        try { localStorage.removeItem(key); } catch { /* egal */ }
      },
    };
  }

  return { api, el, markerIcon, createMap, prettyToken, cleanToken, tokenFromScan, storage };
})();
