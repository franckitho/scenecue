'use strict';
/* Caméra — éditeur d'un calque : source (iPhone ou caméra du PC), cadrage, forme, bordure */

const C = window.Cam;
const _ = I18N.t; // traduction (voir i18n.js et en.js)
I18N.apply();
// Le bridge vient de SceneCue, qui charge ce module dans une scène.
const api = window.bridge || hostBridge() || stubBridge();

function hostBridge() {
  try {
    return window.parent !== window && typeof window.parent.sceneCueBridge === 'function'
      ? window.parent.sceneCueBridge(window)
      : null;
  } catch { return null; }
}

// Permet d'ouvrir index.html dans un navigateur classique (sans SceneCue) pour travailler l'interface.
function stubBridge() {
  const status = {
    running: false, error: _('Serveur indisponible hors de SceneCue'), port: 8443, httpPort: 8080, addresses: [], ip: '127.0.0.1',
    key: '0000', url: 'https://127.0.0.1:8443/?k=0000', phone: null, viewers: 0, facing: 'user', quality: '1080',
  };
  return {
    init: async () => ({ state: null, displays: [{ id: 1, index: 1, primary: true, width: 1920, height: 1080, pxW: 1920, pxH: 1080 }] }),
    saveState() {}, saveShared() {}, setLive() {}, resetTimer() {}, suggestName() {},
    call: async (m) => (m === 'qr' ? { size: 21, path: '' } : status),
    on() {},
  };
}

// ---------- utilitaires ----------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const LINUX = /Linux/.test(navigator.userAgent);
// conseils propres au système (pare-feu de Windows ou de Linux)
for (const e of $$('[data-os]')) e.hidden = e.dataset.os !== (LINUX ? 'linux' : 'win');
const { clamp } = C;
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
const storage = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
};

// ---------- état ----------
let state;
let info = { source: null, live: false, error: null, width: 0, height: 0, fps: 0, label: '', linked: null };
let srv = null; // serveur et téléphone (backend du module)
let displays = [];
let devices = [];
let view;
let qrUrl = null;
const frame = $('#frame');
const stage = $('#stage');
const handle = el('div', 'cm-handle');
const binders = [];

let sendQueued = false;
function commit() {
  view.update(state);
  refreshVisibility();
  refreshHint();
  refreshWait();
  if (!sendQueued) {
    sendQueued = true;
    requestAnimationFrame(() => { sendQueued = false; api.saveState(C.clone(state)); });
  }
}

function edited(key) {
  if (key === 'entrance') view.replay();
  if (key === 'source') onSource();
}

const sync = (key) => binders.forEach((f) => (!key || f.key === key) && f());

// ---------- affichage conditionnel ----------
const WHEN = {
  phone: () => state.source === 'phone',
  device: () => state.source === 'device',
  free: () => state.fit === 'free',
  round: () => state.shape === 'round',
  'not-circle': () => state.shape !== 'circle',
  border: () => !!state.border,
};
function refreshVisibility() {
  for (const e of $$('[data-when]')) e.hidden = !WHEN[e.dataset.when]();
  handle.hidden = state.fit !== 'free';
  frame.classList.toggle('editable', state.fit === 'free');
  $('#desk').classList.toggle('single', state.source !== 'phone');
}

function refreshHint() {
  $('#stage-hint').textContent = state.fit === 'free'
    ? _('Glisse la caméra pour la placer · tire le coin pour la redimensionner · Alt : sans aimant')
    : _('Cadrage plein écran · passe en « Libre » pour déplacer la caméra');
}

// ---------- contrôles liés à l'état ----------
function fmtValue(v, fmt, unit, step) {
  if (fmt === 'pct') return `${Math.round(v * 100)}%`;
  if (fmt === 'signed') return `${v > 0 ? '+' : ''}${Math.round(v * 100)}%`;
  const dec = step < 0.1 ? 2 : step < 1 ? 1 : 0;
  const s = Number(v).toFixed(dec);
  return fmt === 'x' ? `${s}×` : `${s}${unit || ''}`;
}
function setPct(input) {
  const min = +input.min, max = +input.max;
  input.style.setProperty('--pct', `${((+input.value - min) / (max - min)) * 100}%`);
}

function buildRange(host) {
  const key = host.dataset.bind;
  const min = +host.dataset.min, max = +host.dataset.max, step = +host.dataset.step;
  const { format, unit } = host.dataset;
  const input = el('input');
  Object.assign(input, { type: 'range', min, max, step });
  const val = el('input', 'ctl-value');
  val.spellcheck = false;
  host.replaceChildren(el('span', 'ctl-label', host.dataset.label), input, val);

  const show = (v) => { input.value = v; setPct(input); val.value = fmtValue(v, format, unit, step); };
  const put = (v) => { state[key] = v; show(v); edited(key); commit(); };

  input.addEventListener('input', () => put(+input.value));
  input.addEventListener('dblclick', () => put(C.DEFAULT_STATE[key] ?? min));
  val.addEventListener('focus', () => val.select());
  val.addEventListener('change', () => {
    let v = parseFloat(val.value.replace(',', '.'));
    if (Number.isNaN(v)) { show(state[key]); return; }
    if (format === 'pct' || format === 'signed') v /= 100;
    put(clamp(v, min, max));
  });
  val.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') val.blur();
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const k = (e.shiftKey ? 10 : 1) * step * (e.key === 'ArrowUp' ? 1 : -1);
      put(clamp(+(state[key] + k).toFixed(4), min, max));
    }
  });
  const f = () => show(state[key]);
  f.key = key;
  binders.push(f);
}

function buildChoice(host) {
  const key = host.dataset.bind;
  const asNumber = host.hasAttribute('data-number');
  const titles = (host.dataset.titles || '').split('|');
  host.dataset.options.split(',').forEach((part, i) => {
    const [v, ...rest] = part.split(':');
    const b = el('button', '', rest.join(':'));
    b.type = 'button';
    b.dataset.v = v;
    b.title = titles[i] || rest.join(':');
    b.addEventListener('click', () => {
      if (String(state[key]) === v) return;
      state[key] = asNumber ? Number(v) : v;
      edited(key);
      sync();
      commit();
    });
    host.append(b);
  });
  const f = () => { const cur = String(state[key]); for (const b of host.children) b.classList.toggle('on', b.dataset.v === cur); };
  f.key = key;
  binders.push(f);
}

function buildToggle(btn) {
  const key = btn.dataset.bind;
  btn.type = 'button';
  btn.setAttribute('role', 'switch');
  const f = () => { const on = !!state[key]; btn.classList.toggle('on', on); btn.setAttribute('aria-checked', on); };
  f.key = key;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    state[key] = !state[key];
    f();
    edited(key);
    commit();
  });
  binders.push(f);
}

function buildColor() {
  const input = $('#border-color');
  const f = () => { input.value = state.borderColor; $('#border-hex').textContent = state.borderColor.toUpperCase(); };
  input.addEventListener('input', () => { state.borderColor = input.value.toUpperCase(); f(); commit(); });
  binders.push(f);
}

// ---------- aperçu ----------
function currentDisplay() {
  return displays.find((d) => d.primary) || displays[0] || { width: 1920, height: 1080, pxW: 1920, pxH: 1080 };
}

function layoutStage() {
  const d = currentDisplay();
  const cw = C.CANVAS_W, ch = Math.round((cw * d.height) / d.width);
  const cs = getComputedStyle(stage);
  const aw = stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const ah = stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const k = Math.max(0.05, Math.min(aw / cw, ah / ch));
  const w = Math.round(cw * k), h = Math.round(ch * k);
  frame.style.width = `${w}px`;
  frame.style.height = `${h}px`;
  view.resize(w, h);
  frame.style.setProperty('--px', `${1 / view.k}px`); // 1 px à l'écran, dans le canevas mis à l'échelle
  $('#scale-note').textContent = `${Math.round((w / d.pxW) * 100)}%`;
}

function padPositions() {
  const r = view.rect || { w: 0, h: 0 };
  const m = 40;
  const ex = clamp((r.w / 2 + m) / view.cw, 0, 0.5);
  const ey = clamp((r.h / 2 + m) / view.ch, 0, 0.5);
  const out = [];
  for (const y of [ey, 0.5, 1 - ey]) for (const x of [ex, 0.5, 1 - ex]) out.push([x, y]);
  return out;
}
function buildPad() {
  const pad = $('#pad');
  for (let i = 0; i < 9; i++) {
    const b = el('button');
    b.type = 'button';
    b.addEventListener('click', () => {
      const [x, y] = padPositions()[i];
      state.x = +x.toFixed(4);
      state.y = +y.toFixed(4);
      commit();
      refreshPad();
    });
    pad.append(b);
  }
}
function refreshPad() {
  const pos = padPositions();
  $$('#pad button').forEach((b, i) => {
    const [x, y] = pos[i];
    b.classList.toggle('on', Math.abs(state.x - x) < 0.004 && Math.abs(state.y - y) < 0.004);
  });
}

// glisser pour déplacer, coin pour redimensionner
function setupDrag() {
  const box = view.box;
  const gv = $('#guide-v'), gh = $('#guide-h');
  box.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || state.fit !== 'free') return;
    e.preventDefault();
    const resizing = e.target === handle;
    const fr = frame.getBoundingClientRect();
    const sx = e.clientX, sy = e.clientY, ox = state.x, oy = state.y, os = state.size;
    const cx = fr.left + ox * fr.width, cy = fr.top + oy * fr.height;
    const d0 = Math.max(6, Math.hypot(sx - cx, sy - cy));
    box.setPointerCapture(e.pointerId);
    frame.classList.add(resizing ? 'resizing' : 'dragging');
    const move = (ev) => {
      if (resizing) {
        state.size = +clamp((os * Math.hypot(ev.clientX - cx, ev.clientY - cy)) / d0, 0.05, 1).toFixed(3);
        sync('size');
      } else {
        let x = ox + (ev.clientX - sx) / fr.width;
        let y = oy + (ev.clientY - sy) / fr.height;
        const snapX = !ev.altKey && Math.abs(x - 0.5) < 8 / fr.width;
        const snapY = !ev.altKey && Math.abs(y - 0.5) < 8 / fr.height;
        if (snapX) x = 0.5;
        if (snapY) y = 0.5;
        state.x = +clamp(x, 0, 1).toFixed(4);
        state.y = +clamp(y, 0, 1).toFixed(4);
        gv.classList.toggle('on', snapX);
        gh.classList.toggle('on', snapY);
      }
      commit();
    };
    const up = () => {
      box.removeEventListener('pointermove', move);
      box.removeEventListener('pointerup', up);
      box.removeEventListener('pointercancel', up);
      box.removeEventListener('lostpointercapture', up);
      frame.classList.remove('dragging', 'resizing');
      gv.classList.remove('on');
      gh.classList.remove('on');
      refreshPad();
    };
    box.addEventListener('pointermove', move);
    box.addEventListener('pointerup', up);
    box.addEventListener('pointercancel', up);
    box.addEventListener('lostpointercapture', up);
  });
}

// ---------- source ----------
async function onSource() {
  if (state.source === 'phone') {
    api.suggestName('iPhone');
    try { renderStatus(await api.call('start')); } catch (e) { toast(e.message); }
  } else {
    await loadDevices();
    const d = devices.find((x) => x.id === state.device) || devices[0];
    if (d) api.suggestName(d.label);
  }
}

async function loadDevices() {
  try { devices = await C.listDevices(); } catch { devices = []; }
  const sel = $('#device');
  sel.replaceChildren();
  if (!devices.length) {
    const o = el('option', '', _('Aucune caméra détectée'));
    o.value = '';
    sel.append(o);
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  for (const d of devices) {
    const o = el('option', '', d.label);
    o.value = d.id;
    sel.append(o);
  }
  // caméra enregistrée débranchée : on garde son nom dans la liste pour ne pas la remplacer en silence
  if (state.device && !devices.some((d) => d.id === state.device)) {
    const o = el('option', '', _('{name} (débranchée)', { name: state.deviceLabel || _('Caméra') }));
    o.value = state.device;
    sel.prepend(o);
  }
  sel.value = state.device || devices[0].id;
}

$('#device').addEventListener('change', (e) => {
  const d = devices.find((x) => x.id === e.target.value);
  state.device = e.target.value;
  state.deviceLabel = d ? d.label : '';
  if (d) api.suggestName(d.label);
  commit();
});
$('#refresh').addEventListener('click', loadDevices);
if (navigator.mediaDevices) navigator.mediaDevices.addEventListener('devicechange', () => { if (state.source === 'device') loadDevices(); });

// ---------- iPhone : serveur, QR code, commandes ----------
function renderStatus(s) {
  if (!s) return;
  srv = s;
  $('#url').textContent = s.url;
  $('#srv-note').textContent = s.running ? `https · port ${s.port}` : _(s.starting ? 'démarrage…' : 'arrêté');
  const err = $('#srv-error');
  err.hidden = !s.error && !s.httpError;
  err.textContent = s.error ? _('Serveur : {error}', { error: s.error })
    : s.httpError ? _("Adresse http:// indisponible ({error}). L'adresse https:// fonctionne.", { error: s.httpError }) : '';

  // carte réseau : utile seulement s'il y en a plusieurs
  const real = s.addresses.filter((a) => !a.virtual);
  const ipRow = $('#ip-row');
  ipRow.hidden = s.addresses.length < 2;
  const sel = $('#ip');
  const virt = ` (${_('virtuelle')})`;
  const opts = s.addresses.map((a) => `${a.ip}|${a.name}${a.virtual ? virt : ''}`).join(',');
  if (sel.dataset.opts !== opts) {
    sel.dataset.opts = opts;
    sel.replaceChildren(...s.addresses.map((a) => { const o = el('option', '', `${a.ip} · ${a.name}${a.virtual ? virt : ''}`); o.value = a.ip; return o; }));
  }
  sel.value = s.ip;
  if (!real.length && !err.textContent) {
    err.hidden = false;
    err.textContent = _("Aucune carte Wi-Fi ou Ethernet trouvée : branche le PC au même réseau que l'iPhone.");
  }

  if (s.url !== qrUrl) {
    qrUrl = s.url;
    api.call('qr', s.url).then(({ size, path }) => {
      const q = 4; // marge blanche réglementaire
      $('#qr').innerHTML = `<svg viewBox="${-q} ${-q} ${size + 2 * q} ${size + 2 * q}" shape-rendering="crispEdges"><rect x="${-q}" y="${-q}" width="${size + 2 * q}" height="${size + 2 * q}" fill="#fff"/><path d="${path}" fill="#0E0D0C"/></svg>`;
    }).catch(() => {});
  }

  for (const b of $('#facing').children) b.classList.toggle('on', b.dataset.v === s.facing);
  for (const b of $('#quality').children) b.classList.toggle('on', b.dataset.v === s.quality);

  const p = s.phone;
  const ps = $('#phone-state');
  let text = _('Aucun téléphone : scanne le QR code');
  let cls = '';
  if (p && !p.connected) { text = _('Téléphone injoignable (Safari en arrière-plan ?)'); cls = 'warn'; }
  else if (p) {
    const i = p.info || {};
    const parts = [i.device && i.device !== 'Navigateur' ? i.device : _(i.device || 'Téléphone')];
    if (i.width) parts.push(`${i.width}×${i.height}`);
    if (i.fps) parts.push(`${i.fps} ${_('i/s')}`);
    parts.push(i.onAir ? _("à l'écran") : _(i.viewers > 1 ? '{n} aperçus' : '{n} aperçu', { n: i.viewers || 0 }));
    text = parts.join(' · ');
    cls = 'ok';
  }
  ps.className = `phone-state ${cls}`;
  $('#phone-text').textContent = text;
  refreshWait();
}

function command(patch) {
  api.call('command', patch).then(renderStatus).catch((e) => toast(e.message));
}
$('#facing').addEventListener('click', (e) => { if (e.target.dataset.v) command({ facing: e.target.dataset.v }); });
$('#quality').addEventListener('click', (e) => { if (e.target.dataset.v) command({ quality: e.target.dataset.v }); });
$('#ip').addEventListener('change', (e) => api.call('configure', { ip: e.target.value }).then(renderStatus).catch((er) => toast(er.message)));
$('#copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(srv.url); toast(_('Adresse copiée'), true); } catch { toast(_("Copie impossible : sélectionne l'adresse à la main.")); }
});

// ---------- état de la caméra dans l'aperçu ----------
function onInfo(i) {
  const was = info;
  info = i;
  if (i.error && i.error !== was.error) toast(i.error);
  if (i.live && i.width && (i.width !== was.width || i.height !== was.height)) refreshPad();
  if (state.source === 'device' && i.label && i.label !== state.deviceLabel && !state.device) state.deviceLabel = i.label;
  const chip = $('#chip');
  let text = '';
  let cls = '';
  if (i.live) {
    text = [state.source === 'phone' ? 'iPhone' : i.label || _('Caméra'), `${i.width}×${i.height}`, i.fps ? `${i.fps} ${_('i/s')}` : ''].filter(Boolean).join(' · ');
    cls = 'ok';
  } else if (i.error) { text = _('Erreur'); cls = 'err'; } else text = state.source === 'phone' ? _("En attente de l'iPhone") : _('Ouverture…');
  chip.className = `chip ${cls}`;
  $('#chip-text').textContent = text;
  refreshWait();
}

function refreshWait() {
  const w = $('#wait');
  w.hidden = !!info.live;
  if (info.live) return;
  let title, text;
  let retry = false;
  if (state.source === 'device') {
    if (info.error) { title = _('Caméra indisponible'); text = info.error; retry = true; } else { title = _('Ouverture de la caméra…'); text = ''; }
  } else if (srv && srv.error) {
    title = _('Le serveur ne démarre pas'); text = srv.error;
  } else if (srv && srv.phone && srv.phone.connected) {
    title = _("Connexion à l'iPhone…");
    text = LINUX ? _('Si rien ne vient, vérifie que le pare-feu laisse passer le port {port}.', { port: srv.port })
      : _('Si rien ne vient, vérifie que Windows autorise SceneCue sur les réseaux privés.');
  } else {
    title = _("En attente de l'iPhone"); text = _("Scanne le QR code ci-dessous avec l'appareil photo de l'iPhone.");
  }
  $('#wait-title').textContent = title;
  $('#wait-text').textContent = text;
  $('#retry').hidden = !retry;
}
$('#retry').addEventListener('click', () => view.retry());

let toastTimer = null;
function toast(msg, ok = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  t.classList.toggle('ok', ok);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ok ? 1800 : 4500);
}

$('#replay').addEventListener('click', () => view.replay());

// ---------- sections repliables ----------
function setupSections() {
  const collapsed = storage.get('cam-collapsed', []);
  for (const sec of $$('.sec')) {
    if (collapsed.includes(sec.dataset.sec)) sec.classList.add('collapsed');
    $('.sec-head', sec).addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      sec.classList.toggle('collapsed');
      storage.set('cam-collapsed', $$('.sec.collapsed').map((s) => s.dataset.sec));
    });
  }
}

// ---------- démarrage ----------
(async function start() {
  const init = await api.init();
  state = C.clone(C.merge(C.DEFAULT_STATE, init.state || {}));
  displays = init.displays || [];

  // Dans SceneCue : les autres calques de la scène s'affichent sous et sur l'aperçu
  if (init.backdrop) {
    for (const [where, url] of [['below', init.backdrop.below], ['above', init.backdrop.above]]) {
      if (!url) continue;
      const f = el('iframe', `backdrop backdrop--${where}`);
      f.src = url;
      f.tabIndex = -1;
      frame.append(f);
    }
  }
  view = new C.View(frame, { bridge: api, output: false, onInfo });
  const above = $('.backdrop--above', frame);
  if (above) frame.append(above);
  frame.append($('#guide-v'), $('#guide-h'));
  view.box.append(handle);

  $$('.ctl.range').forEach(buildRange);
  $$('.seg[data-bind], .grid-pick[data-bind]').forEach(buildChoice);
  $$('.switch[data-bind], .chip-toggle[data-bind]').forEach(buildToggle);
  buildColor();
  buildPad();
  setupSections();
  setupDrag();

  layoutStage();
  new ResizeObserver(layoutStage).observe(stage);
  sync();
  commit();
  view.show();
  refreshPad();

  api.on('status', renderStatus);
  api.on('displays', (d) => { displays = d; layoutStage(); refreshPad(); });
  if (state.source === 'phone') onSource();
  else loadDevices();
  try { renderStatus(await api.call('status')); } catch { /* pas de backend */ }
})();
