'use strict';
/* Pancarte — logique de la fenêtre de contrôle */

const P = window.Pancarte;
const _ = I18N.t; // traduction (voir i18n.js et en.js)
I18N.apply();
// Le bridge vient du preload en solo, ou de Régie quand le module est chargé dans une scène.
const api = window.bridge || hostBridge() || stubBridge();
document.body.classList.toggle('embed', !!api.embedded);

function hostBridge() {
  try {
    return window.parent !== window && typeof window.parent.regieBridge === 'function'
      ? window.parent.regieBridge(window)
      : null;
  } catch { return null; }
}

// Permet d'ouvrir index.html dans un navigateur classique (sans Electron) pour travailler l'interface.
function stubBridge() {
  const fns = {};
  return {
    init: async () => ({
      state: null, shared: {}, live: false, since: null, hotkey: 'Ctrl+Alt+B',
      displays: [{ id: 1, index: 1, primary: true, width: 1920, height: 1080, pxW: 1920, pxH: 1080 }],
    }),
    saveState() {}, saveShared() {}, resetTimer() {},
    setLive(v) { (fns.live || []).forEach((f) => f({ live: v, since: v ? Date.now() : null })); },
    on(ch, fn) { (fns[ch] = fns[ch] || []).push(fn); },
  };
}

// ---------- utilitaires ----------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
function setPath(o, p, v) {
  const ks = p.split('.');
  let a = o;
  for (const k of ks.slice(0, -1)) { if (a[k] == null || typeof a[k] !== 'object') a[k] = {}; a = a[k]; }
  a[ks[ks.length - 1]] = v;
}
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

const QUICK = ['BRB', 'Je reviens', 'Sous la douche', 'À table', 'Pause', 'AFK', '2 minutes', 'Ne partez pas'].map((q) => _(q));
const PALETTE = [
  '#FFFFFF', '#F4EDE1', '#FFE14D', '#FFC21A', '#FF9F1C', '#FF5A1F', '#E8174B',
  '#FF4FA3', '#B65CFF', '#5B6CFF', '#2EC6FF', '#7FD8FF', '#3EE07A', '#B8F25A',
  '#A88A66', '#5C3A21', '#9AA3AE', '#3A3F47', '#1B0F08', '#111111',
];

// ---------- état ----------
let state;
let styles = [];
let displays = [];
let live = false;
let since = null;
let activeLook = null;
let preview;
let scaleK = 1;
const binders = [];

const normalize = (saved) => P.clone(P.merge(P.DEFAULT_STATE, saved || {}));

let sendQueued = false;
function commit() {
  preview.update(state);
  refreshVisibility();
  refreshMeta();
  if (!sendQueued) {
    sendQueued = true;
    requestAnimationFrame(() => { sendQueued = false; api.saveState(P.clone(state)); });
  }
}

function edited(path) {
  if (path.startsWith('style.')) { activeLook = null; refreshTiles(); }
  if (path === 'style.entrance') preview.enter();
  if (path === 'style.font') refreshFonts();
  if (path === 'display') layoutStage();
}

function syncAll() {
  binders.forEach((b) => b());
  refreshVisibility();
  refreshFonts();
  refreshTiles();
  refreshMeta();
}

function cond(expr) {
  const [p, vals] = expr.split('=');
  return vals.split(',').includes(String(getPath(state, p)));
}
function refreshVisibility() {
  for (const e of $$('[data-show],[data-hide]')) {
    const show = e.dataset.show ? cond(e.dataset.show) : true;
    const hide = e.dataset.hide ? cond(e.dataset.hide) : false;
    e.hidden = !show || hide;
  }
}

function refreshMeta() {
  const n = [...(state.text || '')].length;
  $('#count').textContent = _('{n} car.', { n });
  const pos = padPositions();
  $$('#pad button').forEach((b, i) => {
    const [x, y] = pos[i];
    b.classList.toggle('on', Math.abs(state.x - x) < 0.004 && Math.abs(state.y - y) < 0.004);
  });
}

// ---------- contrôles liés à l'état ----------
function fmtValue(v, fmt, unit, step) {
  if (fmt === 'pct') return `${Math.round(v * 100)}%`;
  const dec = step < 0.1 ? 2 : step < 1 ? 1 : 0;
  const s = Number(v).toFixed(dec);
  return fmt === 'x' ? `${s}×` : `${s}${unit || ''}`;
}
function setPct(input) {
  const min = +input.min, max = +input.max;
  input.style.setProperty('--pct', `${((+input.value - min) / (max - min)) * 100}%`);
}

function buildRange(host) {
  const path = host.dataset.bind;
  const min = +host.dataset.min, max = +host.dataset.max, step = +host.dataset.step;
  const { format, unit } = host.dataset;
  const input = el('input');
  Object.assign(input, { type: 'range', min, max, step });
  const val = el('input', 'ctl-value');
  val.spellcheck = false;
  host.replaceChildren(el('span', 'ctl-label', host.dataset.label), input, val);

  const show = (v) => { input.value = v; setPct(input); val.value = fmtValue(v, format, unit, step); };
  const put = (v) => { setPath(state, path, v); show(v); edited(path); commit(); };

  input.addEventListener('input', () => put(+input.value));
  input.addEventListener('dblclick', () => put(getPath(P.DEFAULT_STATE, path) ?? min));
  val.addEventListener('focus', () => val.select());
  val.addEventListener('change', () => {
    let v = parseFloat(val.value.replace(',', '.'));
    if (Number.isNaN(v)) { show(getPath(state, path)); return; }
    if (format === 'pct') v /= 100;
    put(clamp(v, min, max));
  });
  val.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') val.blur();
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const k = (e.shiftKey ? 10 : 1) * step * (e.key === 'ArrowUp' ? 1 : -1);
      put(clamp(+(getPath(state, path) + k).toFixed(4), min, max));
    }
  });
  binders.push(() => show(getPath(state, path)));
}

function buildPlainRange(input) {
  const path = input.dataset.bind;
  const readout = $(`[data-readout="${path}"]`);
  const show = (v) => {
    input.value = v; setPct(input);
    if (readout) readout.textContent = fmtValue(v, readout.dataset.format, '', +input.step);
  };
  input.addEventListener('input', () => { setPath(state, path, +input.value); show(+input.value); edited(path); commit(); });
  binders.push(() => show(getPath(state, path)));
}

function buildChoice(host) {
  const path = host.dataset.bind;
  for (const part of host.dataset.options.split(',')) {
    const [v, ...rest] = part.split(':');
    const b = el('button', '', rest.join(':'));
    b.type = 'button';
    b.dataset.v = v;
    b.title = rest.join(':');
    b.addEventListener('click', () => {
      setPath(state, path, v);
      binders.forEach((f) => f.path === path && f());
      edited(path);
      commit();
    });
    host.append(b);
  }
  const f = () => { const cur = String(getPath(state, path)); for (const b of host.children) b.classList.toggle('on', b.dataset.v === cur); };
  f.path = path;
  binders.push(f);
}

function buildToggle(btn) {
  const path = btn.dataset.bind;
  btn.type = 'button';
  btn.setAttribute('role', 'switch');
  const f = () => { const on = !!getPath(state, path); btn.classList.toggle('on', on); btn.setAttribute('aria-checked', on); };
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    setPath(state, path, !getPath(state, path));
    f(); edited(path); commit();
  });
  binders.push(f);
}

function buildField(input) {
  const path = input.dataset.bind;
  const isNum = input.type === 'number';
  input.addEventListener('input', () => {
    let v = input.value;
    if (isNum) {
      v = parseInt(v, 10);
      if (Number.isNaN(v)) return;
      v = clamp(v, +input.min || 0, +input.max || 9999);
    }
    setPath(state, path, v);
    edited(path);
    commit();
  });
  if (isNum) input.addEventListener('blur', () => { input.value = getPath(state, path); });
  binders.push(() => { if (document.activeElement !== input) input.value = getPath(state, path) ?? ''; });
}

function buildColor(host) {
  const path = host.dataset.bind;
  const allowNone = host.hasAttribute('data-none');
  const btn = el('button', 'swatch-btn');
  btn.type = 'button';
  const sw = el('span', 'sw');
  const hex = el('span', 'hex');
  btn.append(sw, hex);
  if (host.dataset.label) btn.append(el('span', 'idx', host.dataset.label));
  host.replaceChildren(btn);
  btn.addEventListener('click', (e) => { e.stopPropagation(); openPop(btn, path, allowNone); });
  binders.push(() => {
    const v = getPath(state, path);
    sw.classList.toggle('none', !v);
    sw.style.background = v || '';
    hex.textContent = v ? v.toUpperCase() : _('Aucune');
  });
}

// ---------- sélecteur de couleur ----------
const pop = $('#pop');
let popCtx = null;

function openPop(anchor, path, allowNone) {
  popCtx = { path, anchor };
  const cur = getPath(state, path) || '';
  const grid = $('#pop-swatches');
  grid.replaceChildren();
  for (const c of [...PALETTE, allowNone ? '' : '#000000']) {
    const b = el('button', c ? '' : 'none');
    b.type = 'button';
    b.title = c || _('Aucune');
    if (c) b.style.background = c;
    b.classList.toggle('on', c.toUpperCase() === cur.toUpperCase());
    b.addEventListener('click', () => { applyColor(c); closePop(); });
    grid.append(b);
  }
  $('#pop-hex').value = cur ? cur.toUpperCase() : '';
  $('#pop-preview').style.background = cur || 'transparent';
  $('#pop-native').value = /^#[0-9a-f]{6}$/i.test(cur) ? cur.toLowerCase() : '#ffffff';

  pop.hidden = false;
  const r = anchor.getBoundingClientRect();
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  let x = r.left, y = r.bottom + 6;
  if (y + ph > innerHeight - 8) y = r.top - ph - 6;
  x = clamp(x, 8, innerWidth - pw - 8);
  pop.style.left = `${x}px`;
  pop.style.top = `${Math.max(8, y)}px`;
}
function closePop() { pop.hidden = true; popCtx = null; }
function applyColor(c) {
  if (!popCtx) return;
  setPath(state, popCtx.path, c);
  $('#pop-preview').style.background = c || 'transparent';
  binders.forEach((f) => f());
  edited(popCtx.path);
  commit();
}
function normHex(v) {
  v = v.trim().replace(/^#?/, '#');
  if (/^#[0-9a-f]{3}$/i.test(v)) v = `#${v.slice(1).split('').map((c) => c + c).join('')}`;
  return /^#[0-9a-f]{6}$/i.test(v) ? v.toUpperCase() : null;
}
$('#pop-hex').addEventListener('input', (e) => { const h = normHex(e.target.value); if (h) applyColor(h); });
$('#pop-hex').addEventListener('keydown', (e) => { if (e.key === 'Enter') closePop(); });
$('#pop-native').addEventListener('input', (e) => { const h = e.target.value.toUpperCase(); $('#pop-hex').value = h; applyColor(h); });
document.addEventListener('pointerdown', (e) => { if (!pop.hidden && !pop.contains(e.target)) closePop(); });

// ---------- polices ----------
function buildFonts() {
  const list = $('#fonts');
  for (const f of P.FONTS) {
    const b = el('button', 'font-item');
    b.type = 'button';
    b.dataset.id = f.id;
    const name = el('span', 'fname', f.name);
    name.style.fontFamily = `"${f.family}"`;
    name.style.fontWeight = f.weight || 400;
    b.append(name);
    if (f.system) b.append(el('span', 'ftag', 'Windows'));
    b.addEventListener('click', () => { state.style.font = f.id; edited('style.font'); commit(); });
    list.append(b);
  }
  const c = el('button', 'font-item custom');
  c.type = 'button';
  c.dataset.id = 'custom';
  c.append(el('span', 'fname', _('Autre police installée…')));
  c.addEventListener('click', () => {
    state.style.font = 'custom';
    edited('style.font');
    commit();
    $('.custom-font').focus();
  });
  list.append(c);
}
function refreshFonts({ reveal = false } = {}) {
  for (const b of $$('.font-item')) b.classList.toggle('on', b.dataset.id === state.style.font);
  const on = $('.font-item.on');
  const list = $('#fonts');
  if (reveal && on && list.clientHeight) {
    const top = on.offsetTop, bottom = top + on.offsetHeight;
    if (top < list.scrollTop || bottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = top - (list.clientHeight - on.offsetHeight) / 2;
    }
  }
}

// ---------- galerie ----------
const TILE_W = 900;
const tiles = [];

function makeTile(container, name, style, onClick, onDelete) {
  const t = el('div', 'tile');
  t.title = name;
  const host = el('div', 'tile-host');
  t.append(host);
  container.append(t);
  const r = new P.Renderer(host, { fit: true });
  r.update({
    text: name, x: 0.5, y: 0.5, dim: 0,
    style: P.merge(P.merge(P.DEFAULT_STYLE, style), { entrance: 'none' }),
    sub: { on: false, text: '' }, timer: { mode: 'off' },
  });
  r.show();
  const fit = () => {
    const w = t.clientWidth, h = t.clientHeight;
    if (!w) return;
    const k = w / TILE_W;
    r.setSize(TILE_W, Math.round(h / k));
    r.canvas.style.transform = `scale(${k})`;
  };
  new ResizeObserver(fit).observe(t);
  t.addEventListener('click', onClick);
  if (onDelete) {
    const d = el('button', 'tile-del');
    d.type = 'button';
    d.title = _('Supprimer ce style');
    d.innerHTML = '<svg viewBox="0 0 10 10"><path d="M2 2l6 6M8 2l-6 6"/></svg>';
    d.addEventListener('click', (e) => { e.stopPropagation(); onDelete(); });
    t.append(d);
  }
  return { el: t, r };
}

function applyStyle(style, id) {
  state.style = P.clone(P.merge(P.DEFAULT_STYLE, style));
  activeLook = id;
  syncAll();
  refreshFonts({ reveal: true });
  commit();
  preview.enter();
}

function buildLooks() {
  const box = $('#looks');
  for (const look of P.LOOKS) {
    const t = makeTile(box, look.name, look.style, () => applyStyle(look.style, look.id));
    t.id = look.id;
    tiles.push(t);
  }
}

let mineTiles = [];
function buildMine() {
  const box = $('#mine');
  mineTiles.forEach((t) => t.r.destroy());
  box.replaceChildren();
  mineTiles = styles.map((s) => {
    const t = makeTile(box, s.name, s.style, () => applyStyle(s.style, s.id), () => {
      styles = styles.filter((x) => x.id !== s.id);
      api.saveShared({ styles });
      buildMine();
    });
    t.id = s.id;
    return t;
  });
  $('#mine-empty').hidden = styles.length > 0;
  refreshTiles();
}

function refreshTiles() {
  for (const t of [...tiles, ...mineTiles]) t.el.classList.toggle('on', t.id === activeLook);
}

$('#save-style').addEventListener('click', () => {
  const row = $('#save-row');
  row.hidden = !row.hidden;
  if (!row.hidden) { $('#save-name').value = ''; $('#save-name').focus(); }
});
$('#save-row').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('#save-name').value.trim() || _('Style {n}', { n: styles.length + 1 });
  const id = `u${Date.now().toString(36)}`;
  styles = [...styles, { id, name, style: P.clone(state.style) }];
  api.saveShared({ styles });
  $('#save-row').hidden = true;
  activeLook = id;
  buildMine();
});
$('#save-name').addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#save-row').hidden = true; });

// ---------- scène / aperçu ----------
const frame = $('#frame');
const stage = $('#stage');

function currentDisplay() {
  return displays.find((d) => d.id === state.display)
    || displays.find((d) => d.primary)
    || displays[0]
    || { id: null, index: 1, width: 1920, height: 1080, pxW: 1920, pxH: 1080 };
}

function layoutStage() {
  const d = currentDisplay();
  const cw = P.CANVAS_W, ch = Math.round((cw * d.height) / d.width);
  const cs = getComputedStyle(stage);
  const aw = stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const ah = stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const k = Math.max(0.05, Math.min(aw / cw, ah / ch));
  scaleK = k;
  frame.style.width = `${Math.round(cw * k)}px`;
  frame.style.height = `${Math.round(ch * k)}px`;
  preview.setSize(cw, ch);
  preview.canvas.style.transform = `scale(${k})`;
  $('#scale-note').textContent = `${Math.round(((cw * k) / d.pxW) * 100)}%`;
  refreshMeta();
}

function buildDisplays() {
  const sel = $('#display');
  sel.replaceChildren();
  for (const d of displays) {
    const o = el('option', '', `${_('Écran {n}', { n: d.index })} — ${d.pxW}×${d.pxH}${d.primary ? ` · ${_('principal')}` : ''}`);
    o.value = d.id;
    sel.append(o);
  }
  sel.value = currentDisplay().id;
}
$('#display').addEventListener('change', (e) => {
  state.display = Number(e.target.value);
  edited('display');
  commit();
});

function padPositions() {
  if (!preview) return [];
  const { w, h } = preview.blockRect();
  const m = 64;
  const ex = clamp((w / 2 + m) / preview.cw, 0, 0.5);
  const ey = clamp((h / 2 + m) / preview.ch, 0, 0.5);
  const xs = [ex, 0.5, 1 - ex], ys = [ey, 0.5, 1 - ey];
  const out = [];
  for (const y of ys) for (const x of xs) out.push([x, y]);
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
    });
    pad.append(b);
  }
}

function setupDrag() {
  const gv = $('#guide-v'), gh = $('#guide-h');
  const block = preview.block;
  block.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY, ox = state.x, oy = state.y;
    const fw = frame.clientWidth, fh = frame.clientHeight;
    block.setPointerCapture(e.pointerId);
    frame.classList.add('dragging');
    const move = (ev) => {
      let x = ox + (ev.clientX - sx) / fw;
      let y = oy + (ev.clientY - sy) / fh;
      const snapX = !ev.altKey && Math.abs(x - 0.5) < 8 / fw;
      const snapY = !ev.altKey && Math.abs(y - 0.5) < 8 / fh;
      if (snapX) x = 0.5;
      if (snapY) y = 0.5;
      state.x = +clamp(x, 0, 1).toFixed(4);
      state.y = +clamp(y, 0, 1).toFixed(4);
      gv.classList.toggle('on', snapX);
      gh.classList.toggle('on', snapY);
      commit();
    };
    const up = () => {
      block.removeEventListener('pointermove', move);
      block.removeEventListener('pointerup', up);
      block.removeEventListener('pointercancel', up);
      frame.classList.remove('dragging');
      gv.classList.remove('on');
      gh.classList.remove('on');
    };
    block.addEventListener('pointermove', move);
    block.addEventListener('pointerup', up);
    block.addEventListener('pointercancel', up);
  });
}

// ---------- texte rapide ----------
function buildChips() {
  const box = $('#chips');
  for (const q of QUICK) {
    const b = el('button', 'chip', q);
    b.type = 'button';
    b.addEventListener('click', () => {
      state.text = q;
      binders.forEach((f) => f());
      commit();
    });
    box.append(b);
  }
}

// ---------- antenne ----------
function updateOnAir() {
  document.body.classList.toggle('is-live', live);
  $('#onair-title').textContent = _(live ? 'Masquer la pancarte' : 'Afficher la pancarte');
  $('#onair-sub').textContent = live && since ? `${_("À l'écran")} · ${P.fmtTime((Date.now() - since) / 1000)}` : _('Hors antenne');
  $('#tb-status-text').textContent = _(live ? "À l'écran" : 'Hors antenne');
}
$('#onair').addEventListener('click', () => api.setLive(!live));
$('#replay').addEventListener('click', () => preview.enter());
$('#timer-reset').addEventListener('click', () => api.resetTimer());

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !pop.hidden) closePop();
  if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); api.setLive(!live); }
});

// ---------- sections repliables ----------
function setupSections() {
  const collapsed = storage.get('collapsed', []);
  for (const sec of $$('.sec')) {
    if (collapsed.includes(sec.dataset.sec)) sec.classList.add('collapsed');
    $('.sec-head', sec).addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      sec.classList.toggle('collapsed');
      storage.set('collapsed', $$('.sec.collapsed').map((s) => s.dataset.sec));
    });
  }
}

// ---------- démarrage ----------
(async function start() {
  const init = await api.init();
  state = normalize(init.state);
  const shared = init.shared || {};
  styles = Array.isArray(shared.styles) ? shared.styles : [];
  displays = init.displays || [];
  live = !!init.live;
  since = init.since;

  // Dans Régie : les autres calques de la scène s'affichent sous et sur l'aperçu
  if (init.backdrop) {
    for (const [where, url] of [['below', init.backdrop.below], ['above', init.backdrop.above]]) {
      if (!url) continue;
      const f = el('iframe', `backdrop backdrop--${where}`);
      f.src = url;
      f.tabIndex = -1;
      frame.append(f);
    }
  }

  preview = new P.Renderer(frame);
  preview.show();
  preview.setSince(live ? since : null);
  const above = $('.backdrop--above', frame);
  if (above) frame.append(above);

  $$('.ctl.range').forEach(buildRange);
  $$('input[type=range][data-bind]').forEach((i) => { if (!i.closest('.ctl')) buildPlainRange(i); });
  $$('.seg[data-bind], .grid-pick[data-bind]').forEach(buildChoice);
  $$('.switch[data-bind], .chip-toggle[data-bind]').forEach(buildToggle);
  $$('input.input[data-bind], textarea[data-bind]').forEach(buildField);
  $$('.color-field[data-bind]').forEach(buildColor);

  const subSel = $('#sub-font');
  for (const f of P.SUB_FONTS) { const o = el('option', '', f.name); o.value = f.id; subSel.append(o); }
  subSel.addEventListener('change', () => { state.sub.font = subSel.value; commit(); });
  binders.push(() => { subSel.value = state.sub.font; });

  buildFonts();
  buildLooks();
  buildMine();
  buildChips();
  buildPad();
  buildDisplays();
  setupSections();
  setupDrag();

  syncAll();
  layoutStage();
  commit();
  new ResizeObserver(layoutStage).observe(stage);

  if (!init.hotkey) {
    $('#hotkey').classList.add('off');
    $('#hotkey span').textContent = _('raccourci déjà pris par une autre app');
  }

  api.on('live', (p) => {
    live = p.live;
    since = p.since;
    preview.setSince(live ? since : null);
    updateOnAir();
  });
  api.on('displays', (d) => { displays = d; buildDisplays(); layoutStage(); });

  updateOnAir();
  setInterval(updateOnAir, 500);
})();
