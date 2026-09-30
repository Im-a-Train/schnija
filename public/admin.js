// Admin-UI: Schätze anlegen, auf der Karte platzieren, QR-Codes drucken.
/* global Schatz, L, qrcode */
'use strict';

(() => {
  const { api, el, markerIcon, createMap, prettyToken } = Schatz;
  const session = {
    get() { try { return sessionStorage.getItem('schatzsuche.admin'); } catch { return null; } },
    set(t) { try { sessionStorage.setItem('schatzsuche.admin', t); } catch { /* egal */ } },
    clear() { try { sessionStorage.removeItem('schatzsuche.admin'); } catch { /* egal */ } },
  };

  const $ = (id) => document.getElementById(id);
  let token = session.get();
  let config = null;
  let dirty = false;
  let map = null;
  let markers = new Map(); // code (Objekt) -> Leaflet-Marker
  let placing = null;      // null | 'new' | code
  let openCode = null;     // der aufgeklappte Schatz

  // ---------- Anmeldung ----------

  function showLogin(message = '') {
    $('editor').hidden = true;
    $('login').hidden = false;
    $('login-error').textContent = message;
    $('password').focus();
  }

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('login-error').textContent = '';
    try {
      const res = await api('/api/admin/login', { method: 'POST', body: { password: $('password').value } });
      token = res.token;
      session.set(token);
      $('password').value = '';
      await start();
    } catch (err) {
      $('login-error').textContent = err.message;
    }
  });

  $('logout').addEventListener('click', () => {
    if (dirty && !confirm('Es gibt ungespeicherte Änderungen. Trotzdem abmelden?')) return;
    session.clear();
    token = null;
    dirty = false;
    showLogin();
  });

  async function authed(path, opts = {}) {
    try {
      return await api(path, { ...opts, token });
    } catch (err) {
      if (err.status === 401) {
        session.clear();
        showLogin('Deine Anmeldung ist abgelaufen. Bitte neu anmelden – ungespeicherte Änderungen bleiben erhalten.');
      }
      throw err;
    }
  }

  // ---------- Speichern ----------

  function setDirty(value = true) {
    dirty = value;
    $('save-state').textContent = dirty ? 'Ungespeicherte Änderungen' : 'Alles gespeichert ✓';
    $('save-state').classList.toggle('is-dirty', dirty);
  }

  async function save() {
    $('save').disabled = true;
    try {
      const saved = await authed('/api/admin/config', { method: 'PUT', body: config });
      // Neue Schätze bekommen ihre id und ihren Token erst beim Speichern.
      config = saved;
      setDirty(false);
      renderAll();
      return true;
    } catch (err) {
      if (err.status !== 401) alert(`Speichern fehlgeschlagen: ${err.message}`);
      return false;
    } finally {
      $('save').disabled = false;
    }
  }

  $('save').addEventListener('click', save);
  window.addEventListener('beforeunload', (e) => {
    if (dirty) { e.preventDefault(); e.returnValue = ''; }
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); }
    if (e.key === 'Escape' && placing) setPlacing(null);
  });

  // ---------- Einstellungen ----------

  function renderSettings() {
    $('s-title').value = config.title;
    $('s-subtitle').value = config.subtitle;
    $('s-finale').value = config.finale;
    $('s-url').value = config.publicUrl;
    $('s-view').textContent = `${config.map.center[0].toFixed(5)}, ${config.map.center[1].toFixed(5)} · Zoom ${config.map.zoom}`;
  }

  const bindings = { 's-title': 'title', 's-subtitle': 'subtitle', 's-finale': 'finale', 's-url': 'publicUrl' };
  for (const [id, key] of Object.entries(bindings)) {
    $(id).addEventListener('input', (e) => { config[key] = e.target.value; setDirty(); });
  }
  $('s-use-view').addEventListener('click', () => {
    const c = map.getCenter();
    config.map = { center: [+c.lat.toFixed(6), +c.lng.toFixed(6)], zoom: map.getZoom() };
    renderSettings();
    setDirty();
  });

  // ---------- Karte ----------

  function setPlacing(mode) {
    placing = mode;
    document.body.classList.toggle('placing', !!mode);
    $('place-new').textContent = mode === 'new' ? '✖️ Abbrechen' : '➕ Neuen Schatz platzieren';
    $('map-hint').textContent = mode
      ? (mode === 'new' ? 'Klicke auf die Karte, wo der neue Schatz hängt.' : `Klicke auf die Karte, wo «${mode.name}» neu hängt.`)
      : 'Marker ziehen, um einen Schatz zu verschieben.';
  }

  $('place-new').addEventListener('click', () => setPlacing(placing === 'new' ? null : 'new'));

  function initMap() {
    if (map) return;
    map = createMap('admin-map', config.map);
    map.on('click', (e) => {
      if (!placing) return;
      const lat = +e.latlng.lat.toFixed(6);
      const lng = +e.latlng.lng.toFixed(6);
      if (placing === 'new') {
        const code = { emoji: '⭐', name: 'Neuer Schatz', hint: '', reward: '', lat, lng };
        config.codes.push(code);
        openCode = code;
      } else {
        placing.lat = lat;
        placing.lng = lng;
      }
      setPlacing(null);
      setDirty();
      renderAll();
    });
  }

  function renderMarkers() {
    for (const m of markers.values()) m.remove();
    markers = new Map();
    config.codes.forEach((code, i) => {
      const m = L.marker([code.lat, code.lng], {
        icon: markerIcon(code.emoji || '⭐', i + 1, code === openCode ? 'is-found' : ''),
        draggable: true,
        title: code.name,
        autoPan: true,
      });
      m.on('dragend', () => {
        const ll = m.getLatLng();
        code.lat = +ll.lat.toFixed(6);
        code.lng = +ll.lng.toFixed(6);
        setDirty();
      });
      m.on('click', () => {
        openCode = code;
        renderAll();
        const item = document.querySelector(`[data-index="${i}"]`);
        if (item) item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
      m.addTo(map);
      markers.set(code, m);
    });
  }

  // ---------- Liste ----------

  function field(label, input) {
    return el('label', {}, label, input);
  }

  function renderCodes() {
    const list = $('codes');
    list.replaceChildren();
    $('code-count').textContent = config.codes.length;
    if (!config.codes.length) {
      list.append(el('li', { class: 'empty', text: 'Noch keine Schätze. Klicke auf «Neuen Schatz platzieren» und dann auf die Karte.' }));
    }
    config.codes.forEach((code, i) => {
      const isOpen = code === openCode;
      const update = (key) => (e) => {
        code[key] = e.target.value;
        setDirty();
        if (key === 'emoji' || key === 'name') {
          const m = markers.get(code);
          if (m) m.setIcon(markerIcon(code.emoji || '⭐', i + 1, 'is-found'));
          summaryText.textContent = `${code.emoji || '⭐'} ${code.name || 'Ohne Namen'}`;
        }
      };
      const summaryText = el('span', { class: 'code-title', text: `${code.emoji || '⭐'} ${code.name || 'Ohne Namen'}` });
      const details = el('details', { class: 'code', open: isOpen },
        el('summary', {},
          el('span', { class: 'code-num', text: String(i + 1) }),
          summaryText,
          code.token ? null : el('span', { class: 'pill pill-new', text: 'neu' })),
        el('div', { class: 'code-body' },
          el('div', { class: 'row' },
            field('Symbol', el('input', { type: 'text', value: code.emoji, maxlength: 16, class: 'emoji-input', oninput: update('emoji') })),
            field('Name', el('input', { type: 'text', value: code.name, maxlength: 60, oninput: update('name') }))),
          field('Rätsel – wo ist der Schatz? (sehen die Kinder immer)',
            el('textarea', { rows: 3, maxlength: 300, placeholder: 'z. B. Da, wo es fein nach heissem Käse riecht …', oninput: update('hint') }, code.hint)),
          field('Belohnung – was die Kinder nach dem Fund lesen',
            el('textarea', { rows: 2, maxlength: 400, placeholder: 'z. B. Wusstest du, dass …', oninput: update('reward') }, code.reward)),
          el('p', { class: 'small' },
            code.token ? `Geheimcode: ${prettyToken(code.token)}` : 'Geheimcode und QR-Code gibt es nach dem Speichern.'),
          el('div', { class: 'code-actions' },
            el('button', { type: 'button', class: 'btn btn-small btn-light', text: '🖨️ Drucken', disabled: !code.token, onclick: () => printCodes([code]) }),
            el('button', { type: 'button', class: 'btn btn-small btn-light', text: '📍 Neu platzieren', onclick: () => setPlacing(code) }),
            el('button', { type: 'button', class: 'btn btn-small btn-light', text: '⬆️', title: 'Nach vorne', disabled: i === 0, onclick: () => move(i, -1) }),
            el('button', { type: 'button', class: 'btn btn-small btn-light', text: '⬇️', title: 'Nach hinten', disabled: i === config.codes.length - 1, onclick: () => move(i, 1) }),
            el('button', { type: 'button', class: 'btn btn-small btn-danger', text: '🗑️ Löschen', onclick: () => remove(i) }))));
      details.addEventListener('toggle', () => {
        if (details.open) {
          openCode = code;
          document.querySelectorAll('.code[open]').forEach((d) => { if (d !== details) d.open = false; });
          map.panTo([code.lat, code.lng]);
          renderMarkers();
        } else if (openCode === code) {
          openCode = null;
          renderMarkers();
        }
      });
      list.append(el('li', { 'data-index': i }, details));
    });
  }

  function move(i, delta) {
    const [c] = config.codes.splice(i, 1);
    config.codes.splice(i + delta, 0, c);
    setDirty();
    renderAll();
  }

  function remove(i) {
    const c = config.codes[i];
    if (!confirm(`«${c.name}» wirklich löschen? Ein schon aufgehängter QR-Code funktioniert danach nicht mehr.`)) return;
    config.codes.splice(i, 1);
    if (openCode === c) openCode = null;
    setDirty();
    renderAll();
  }

  function renderAll() {
    renderSettings();
    renderCodes();
    renderMarkers();
  }

  // ---------- Drucken ----------

  function baseUrl() {
    return (config.publicUrl || location.origin).replace(/\/+$/, '');
  }

  // QR-Code als SVG: ein Pfad, skaliert sauber auf jede Druckgrösse.
  function qrSvg(text) {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const q = 4; // Ruhezone
    let d = '';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + q},${r + q}h1v1h-1z`;
    }
    const size = n + q * 2;
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
    svg.setAttribute('class', 'qr');
    svg.setAttribute('shape-rendering', 'crispEdges');
    const bg = document.createElementNS(ns, 'rect');
    bg.setAttribute('width', size); bg.setAttribute('height', size); bg.setAttribute('fill', '#fff');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d); path.setAttribute('fill', '#14213d');
    svg.append(bg, path);
    return svg;
  }

  function sheet(children, extraClass = '') {
    return el('section', { class: `sheet ${extraClass}` }, el('div', { class: 'sheet-inner' }, children));
  }

  async function ensureSaved() {
    if (!dirty) return true;
    if (!confirm('Vor dem Drucken muss gespeichert werden. Jetzt speichern?')) return false;
    return save();
  }

  async function printCodes(codes) {
    if (!(await ensureSaved())) return;
    const indexOf = (c) => config.codes.findIndex((x) => x.token === c.token);
    const out = $('print');
    out.replaceChildren();
    for (const code of codes.map((c) => config.codes[indexOf(c)]).filter(Boolean)) {
      const i = indexOf(code);
      const url = `${baseUrl()}/f/${code.token}`;
      out.append(sheet([
        el('p', { class: 'p-kicker', text: config.title }),
        el('div', { class: 'p-badge' }, el('span', { class: 'p-emoji', text: code.emoji }), el('span', { class: 'p-num', text: String(i + 1) })),
        el('h2', { class: 'p-title', text: 'Du hast einen Schatz gefunden!' }),
        el('div', { class: 'p-qr' }, qrSvg(url)),
        el('p', { class: 'p-scan', text: '📷 Scanne mich und hol dir deinen Stempel!' }),
        el('p', { class: 'p-code' }, 'Geheimcode: ', el('strong', { text: prettyToken(code.token) })),
      ]));
    }
    window.print();
  }

  async function printStart() {
    if (!(await ensureSaved())) return;
    const out = $('print');
    out.replaceChildren(sheet([
      el('p', { class: 'p-kicker', text: 'Für Kinder · gratis · mit dem Handy' }),
      el('div', { class: 'p-big-emoji', text: '🗺️⭐🎁' }),
      el('h2', { class: 'p-title p-title-big', text: config.title }),
      el('p', { class: 'p-lead', text: config.subtitle }),
      el('div', { class: 'p-qr' }, qrSvg(`${baseUrl()}/`)),
      el('ol', { class: 'p-steps' },
        el('li', { text: 'QR-Code scannen und die Stempelkarte öffnen.' }),
        el('li', { text: 'Rätsel lesen und die Stände auf dem Märit suchen.' }),
        el('li', { text: `Alle ${config.codes.length} Schatz-Codes scannen – und staunen!` })),
      el('p', { class: 'p-code', text: baseUrl().replace(/^https?:\/\//, '') }),
    ], 'sheet-start'));
    window.print();
  }

  $('print-all').addEventListener('click', () => printCodes(config.codes.filter((c) => c.token)));
  $('print-start').addEventListener('click', printStart);

  // ---------- Export / Import ----------

  $('export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
    const a = el('a', { href: URL.createObjectURL(blob), download: `schatzsuche-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  $('import').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.codes)) throw new Error('keine Schätze in der Datei');
      if (!confirm(`${data.codes.length} Schätze importieren? Die aktuelle Konfiguration wird ersetzt (erst beim Speichern).`)) return;
      config = data;
      openCode = null;
      map.setView(config.map.center, config.map.zoom);
      setDirty();
      renderAll();
    } catch (err) {
      alert(`Import fehlgeschlagen: ${err.message}`);
    }
  });

  // ---------- Start ----------

  async function start() {
    const fresh = await authed('/api/admin/config');
    // Nach einer abgelaufenen Anmeldung die ungespeicherten Änderungen behalten.
    if (!dirty || !config) {
      config = fresh;
      setDirty(false);
    }
    openCode = null;
    $('login').hidden = true;
    $('editor').hidden = false;
    initMap();
    setTimeout(() => map.invalidateSize(), 50);
    renderAll();
  }

  if (token) start().catch(() => {});
  else showLogin();
})();
