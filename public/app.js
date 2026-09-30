// Die Kinder-App: Stempelkarte, Karte und Scanner.
//
// Was gefunden wurde, liegt nur im localStorage dieses Geräts. Der
// Server erfährt nichts über die Spieler; er beantwortet nur "welcher
// Schatz gehört zu diesem Code?".
/* global Schatz, L, jsQR */
'use strict';

(() => {
  const { api, el, markerIcon, createMap, tokenFromScan, cleanToken, storage } = Schatz;
  const saved = storage('schatzsuche.v1');
  const cachedGame = storage('schatzsuche.game.v1');

  // state.found: token -> { foundAt, code }   (code = Antwort von /api/find)
  const state = Object.assign({ name: '', found: {} }, saved.read({}));
  let game = cachedGame.read(null);
  let finale = '';
  let map = null;
  let foundLayer = null;
  let meMarker = null;

  const $ = (id) => document.getElementById(id);

  function persist() { saved.write(state); }

  // Gefundene Schätze, die es im aktuellen Spiel noch gibt, nach id.
  function foundById() {
    const byId = {};
    for (const [token, entry] of Object.entries(state.found)) {
      if (entry && entry.code) byId[entry.code.id] = { ...entry, token };
    }
    return byId;
  }

  function countFound() {
    if (!game) return 0;
    const byId = foundById();
    return game.codes.filter((c) => byId[c.id]).length;
  }

  // ---------- Darstellung ----------

  function renderHeader() {
    if (!game) return;
    $('title').textContent = game.title;
    $('subtitle').textContent = game.subtitle;
    document.title = game.title;
    const found = countFound();
    $('count-found').textContent = found;
    $('count-total').textContent = game.total;
    const bar = $('progress');
    bar.setAttribute('aria-valuemax', String(game.total));
    bar.setAttribute('aria-valuenow', String(found));
    bar.setAttribute('aria-label', `${found} von ${game.total} Schätzen gefunden`);
    $('progress-bar').style.width = game.total ? `${(found / game.total) * 100}%` : '0';
  }

  function renderStamps() {
    const list = $('stamps');
    list.replaceChildren();
    if (!game) return;
    const byId = foundById();
    if (!game.codes.length) {
      list.append(el('li', { class: 'stamp-empty', text: 'Die Schätze werden gerade versteckt. Schau bald wieder vorbei!' }));
      return;
    }
    game.codes.forEach((c, i) => {
      const f = byId[c.id];
      const code = f ? { ...c, ...f.code } : c;
      const tilt = ((i * 37) % 11) - 5;
      list.append(el('li', { class: `stamp ${f ? 'is-found' : ''}`, style: `--tilt:${tilt}deg` },
        el('div', { class: 'stamp-seal', 'aria-hidden': 'true' },
          f ? el('span', { class: 'stamp-emoji', text: code.emoji }) : el('span', { class: 'stamp-q', text: String(c.number) })),
        el('div', { class: 'stamp-body' },
          el('p', { class: 'stamp-no', text: `Schatz ${c.number}${f ? ` · ${code.name}` : ''}` }),
          el('p', { class: 'stamp-hint', text: c.hint }),
          f && code.reward ? el('p', { class: 'stamp-reward', text: code.reward }) : null,
          f ? el('button', { class: 'stamp-show', type: 'button', text: '🗺️ Auf der Karte zeigen', onclick: () => showOnMap(f.token) }) : null),
        f ? el('span', { class: 'stamp-mark', text: 'Gefunden!' }) : el('span', { class: 'sr-only', text: 'noch nicht gefunden' })));
    });
    if (finale) {
      list.append(el('li', { class: 'stamp-finale' },
        el('div', { class: 'finale-emoji', 'aria-hidden': 'true', text: '🏆' }),
        el('p', { text: finale })));
    }
  }

  function renderMap() {
    if (!map || !game) return;
    foundLayer.clearLayers();
    const byId = foundById();
    game.codes.forEach((c) => {
      const f = byId[c.id];
      if (!f) return;
      const code = f.code;
      const m = L.marker([code.lat, code.lng], { icon: markerIcon(code.emoji, c.number, 'is-found'), title: code.name, keyboard: true });
      m.bindPopup(el('div', { class: 'popup' },
        el('strong', { text: `${code.emoji} ${code.name}` }),
        el('p', { text: c.hint })));
      m.token = f.token;
      m.addTo(foundLayer);
    });
    const found = countFound();
    $('map-note').textContent = found === 0
      ? 'Noch kein Schatz gefunden. Jeder gefundene Schatz erscheint hier auf der Karte!'
      : found === game.total
        ? 'Alle Schätze gefunden – super!'
        : `Du hast ${found} von ${game.total} Schätzen gefunden. Die anderen sind noch versteckt!`;
  }

  function renderAll() {
    renderHeader();
    renderStamps();
    renderMap();
  }

  // ---------- Ansichten ----------

  const VIEWS = { card: 'view-card', map: 'view-map', scan: 'view-scan' };
  const HASH = { stempelkarte: 'card', karte: 'map', scannen: 'scan' };

  function show(view) {
    if (!VIEWS[view]) view = 'card';
    for (const [name, id] of Object.entries(VIEWS)) $(id).hidden = name !== view;
    document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-current', t.dataset.view === view ? 'page' : 'false'));
    document.body.dataset.view = view;
    if (view === 'map') ensureMap();
    if (view !== 'scan') stopScan();
  }

  function route() {
    const view = HASH[location.hash.replace('#', '')] || 'card';
    show(view);
  }

  function go(view) {
    const hash = Object.keys(HASH).find((k) => HASH[k] === view);
    if (location.hash !== `#${hash}`) location.hash = hash;
    else show(view);
  }

  function ensureMap() {
    if (!game) return;
    if (!map) {
      map = createMap('map', game.map);
      foundLayer = L.layerGroup().addTo(map);
      renderMap();
      // Beim ersten Öffnen so zoomen, dass alle gefundenen Schätze drauf sind.
      const found = foundLayer.getLayers().map((m) => m.getLatLng());
      if (found.length) {
        const bounds = L.latLngBounds(found).extend(game.map.center);
        setTimeout(() => map.fitBounds(bounds, { padding: [50, 50], maxZoom: game.map.zoom }), 60);
      }
    }
    setTimeout(() => map.invalidateSize(), 50);
  }

  function showOnMap(token) {
    go('map');
    setTimeout(() => {
      const entry = state.found[token];
      if (!entry || !map) return;
      map.setView([entry.code.lat, entry.code.lng], Math.max(map.getZoom(), 18));
      foundLayer.eachLayer((m) => { if (m.token === token) m.openPopup(); });
    }, 120);
  }

  $('locate').addEventListener('click', () => {
    if (!navigator.geolocation) return;
    ensureMap();
    navigator.geolocation.getCurrentPosition((pos) => {
      const ll = [pos.coords.latitude, pos.coords.longitude];
      if (!meMarker) meMarker = L.marker(ll, { icon: markerIcon('🧒', null, 'is-me'), title: 'Hier bist du', zIndexOffset: 1000 }).addTo(map);
      else meMarker.setLatLng(ll);
      map.setView(ll, Math.max(map.getZoom(), 17));
    }, () => {
      $('map-note').textContent = 'Dein Standort ist leider nicht verfügbar. Frag ein Grosi oder einen Papi, ob sie es erlauben.';
    }, { enableHighAccuracy: true, timeout: 10000 });
  });

  // ---------- Finden ----------

  function celebrate({ emoji, title, text, reward, button }) {
    $('overlay-emoji').textContent = emoji;
    $('overlay-title').textContent = title;
    $('overlay-text').textContent = text;
    $('overlay-reward').textContent = reward || '';
    $('overlay-reward').hidden = !reward;
    $('overlay-close').textContent = button;
    const confetti = $('confetti');
    confetti.replaceChildren();
    const bits = ['⭐', '✨', '❄️', '🎉', '⭐', '🌟'];
    for (let i = 0; i < 36; i++) {
      confetti.append(el('span', {
        text: bits[i % bits.length],
        style: `left:${Math.random() * 100}%;animation-delay:${Math.random() * 0.8}s;animation-duration:${2 + Math.random() * 2}s;font-size:${1 + Math.random() * 1.4}rem`,
      }));
    }
    $('overlay').hidden = false;
    $('overlay-close').focus();
  }

  $('overlay-close').addEventListener('click', () => {
    $('overlay').hidden = true;
    go('card');
  });

  async function find(rawToken) {
    const token = cleanToken(rawToken);
    if (state.found[token]) {
      const c = state.found[token].code;
      celebrate({ emoji: c.emoji, title: 'Den hast du schon!', text: `Den ${c.name} hast du schon in deiner Stempelkarte. Such weiter!`, button: 'Weiter suchen!' });
      return;
    }
    let code;
    try {
      code = await api(`/api/find/${encodeURIComponent(token)}`);
    } catch (err) {
      celebrate(err.status === 404
        ? { emoji: '🤔', title: 'Hmm, komisch …', text: 'Diesen Code kennen wir nicht. Probier es nochmals!', button: 'Nochmals' }
        : { emoji: '📶', title: 'Kein Empfang', text: 'Der Schatz konnte nicht geladen werden. Versuch es gleich nochmals.', button: 'OK' });
      return;
    }
    state.found[token] = { foundAt: new Date().toISOString(), code };
    persist();
    await refresh();
    const left = game ? game.total - countFound() : 0;
    const name = state.name ? `, ${state.name}` : '';
    if (game && left === 0) {
      celebrate({
        emoji: '🏆',
        title: `Alle gefunden${name}!`,
        text: `Du hast den ${code.name} gefunden – und damit ALLE Schätze!`,
        reward: finale || code.reward,
        button: 'Zur Stempelkarte',
      });
    } else {
      celebrate({
        emoji: code.emoji,
        title: `Juhui${name}!`,
        text: `Du hast den ${code.name} gefunden! ${left === 1 ? 'Nur noch ein Schatz fehlt!' : `Noch ${left} Schätze sind versteckt.`}`,
        reward: code.reward,
        button: 'Weiter suchen!',
      });
    }
  }

  // ---------- Scanner ----------

  let stream = null;
  let scanTimer = null;
  let detector = null;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  async function startScan() {
    const status = $('scan-status');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      status.textContent = 'Dieses Gerät kann hier keine Kamera öffnen. Tippe den Geheimcode unten ein oder nutze die Kamera-App.';
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    } catch {
      status.textContent = 'Die Kamera wurde nicht erlaubt. Du kannst auch die normale Kamera-App benutzen oder den Code eintippen.';
      return;
    }
    const video = $('video');
    video.srcObject = stream;
    await video.play().catch(() => {});
    document.body.classList.add('scanning');
    $('scan-start').hidden = true;
    status.textContent = 'Suche nach einem QR-Code …';
    if (!detector && 'BarcodeDetector' in window) {
      try {
        const formats = await window.BarcodeDetector.getSupportedFormats();
        if (formats.includes('qr_code')) detector = new window.BarcodeDetector({ formats: ['qr_code'] });
      } catch { detector = null; }
    }
    tick();
  }

  async function tick() {
    if (!stream) return;
    const video = $('video');
    let text = null;
    if (video.readyState >= 2 && video.videoWidth) {
      try {
        if (detector) {
          const codes = await detector.detect(video);
          if (codes.length) text = codes[0].rawValue;
        } else {
          const scale = Math.min(1, 640 / video.videoWidth);
          canvas.width = Math.round(video.videoWidth * scale);
          canvas.height = Math.round(video.videoHeight * scale);
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const res = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
          if (res) text = res.data;
        }
      } catch { /* nächster Versuch */ }
    }
    if (text) {
      const token = tokenFromScan(text);
      if (token) {
        stopScan();
        if (navigator.vibrate) navigator.vibrate(120);
        find(token);
        return;
      }
      $('scan-status').textContent = 'Das ist kein Schatz-Code. Such weiter!';
    }
    scanTimer = setTimeout(tick, 180);
  }

  function stopScan() {
    clearTimeout(scanTimer);
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    document.body.classList.remove('scanning');
    $('scan-start').hidden = false;
    $('scan-status').textContent = 'Halte die Kamera auf einen Schatz-QR-Code.';
  }

  $('scan-start').addEventListener('click', startScan);
  $('manual').addEventListener('submit', (e) => {
    e.preventDefault();
    const token = cleanToken($('manual-code').value);
    if (token.length !== 8) {
      $('scan-status').textContent = 'Der Geheimcode hat 8 Zeichen, zum Beispiel ABCD-2345.';
      return;
    }
    $('manual-code').value = '';
    find(token);
  });

  // ---------- Daten laden ----------

  async function refresh() {
    try {
      game = await api('/api/game');
      cachedGame.write(game);
    } catch { /* offline: letzter Stand bleibt */ }
    const tokens = Object.keys(state.found);
    if (tokens.length) {
      try {
        const res = await api('/api/reveal', { method: 'POST', body: { tokens } });
        for (const c of res.codes) if (state.found[c.token]) state.found[c.token].code = c;
        finale = res.finale || '';
        persist();
      } catch { /* offline */ }
    } else {
      finale = '';
    }
    renderAll();
  }

  $('owner').value = state.name || '';
  $('owner').addEventListener('input', (e) => {
    state.name = e.target.value.trim().slice(0, 30);
    persist();
  });

  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => go(t.dataset.view)));
  window.addEventListener('hashchange', route);
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopScan(); });

  // Aufruf über einen gescannten QR-Code: /f/ABCD2345
  const direct = /^\/f\/([A-Za-z0-9-]+)\/?$/.exec(location.pathname);
  if (direct) history.replaceState(null, '', '/#stempelkarte');

  // Die Karte füllt genau den Platz zwischen Kopf und Tabs.
  const top = document.querySelector('.top');
  const setTopH = () => document.documentElement.style.setProperty('--top-h', `${top.offsetHeight}px`);
  if ('ResizeObserver' in window) new ResizeObserver(setTopH).observe(top);
  setTopH();

  renderAll();
  route();
  refresh().then(() => { if (direct) find(direct[1]); });
})();
