'use strict';
/* Musique en cours — éditeur d'un calque : disposition, contenu, couleurs, comportement en pause */

const M = window.Music;
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
  return {
    init: async () => ({ state: null, displays: [{ id: 1, index: 1, primary: true, width: 1920, height: 1080, pxW: 1920, pxH: 1080 }] }),
    saveState() {}, saveShared() {}, setLive() {}, resetTimer() {}, suggestName() {},
    call: async () => ({ ok: false, error: _('Spotify inaccessible hors de SceneCue'), track: null }),
    on() {},
  };
}

// ---------- utilitaires ----------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const { clamp } = M;
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
let info = { ok: false, error: null, track: null }; // Spotify, d'après le backend du module
let displays = [];
let view;
const frame = $('#frame');
const stage = $('#stage');
const handle = el('div', 'mu-handle');
const binders = [];

let sendQueued = false;
let pendingInside = false; // disposition changée : la carte doit rester dans l'écran
function commit() {
  view.update(state);
  if (pendingInside) {
    pendingInside = false;
    if (keepInside()) view.update(state);
  }
  refreshVisibility();
  refreshPad();
  if (!sendQueued) {
    sendQueued = true;
    requestAnimationFrame(() => { sendQueued = false; api.saveState(M.clone(state)); });
  }
}

function edited(key) {
  if (key === 'entrance') view.replay();
  if (key === 'layout') pendingInside = true;
}

// ramène la carte entière dans l'écran (une carte « Pochette » est bien plus haute qu'une carte « Compacte »)
function keepInside() {
  const r = view.rect;
  if (!r || !r.w) return false;
  const mx = Math.min(0.5, (r.w / 2 + 20) / view.cw), my = Math.min(0.5, (r.h / 2 + 20) / view.ch);
  const x = +clamp(state.x, mx, 1 - mx).toFixed(4), y = +clamp(state.y, my, 1 - my).toFixed(4);
  if (x === state.x && y === state.y) return false;
  state.x = x;
  state.y = y;
  return true;
}

const sync = (key) => binders.forEach((f) => (!key || f.key === key) && f());

// ---------- affichage conditionnel ----------
const WHEN = {
  'not-cover': () => state.layout !== 'cover',
  'not-compact': () => state.layout !== 'compact',
  'accent-custom': () => state.accentMode === 'custom',
};
function refreshVisibility() {
  for (const e of $$('[data-when]')) e.hidden = !WHEN[e.dataset.when]();
}

// ---------- contrôles liés à l'état ----------
function fmtValue(v, fmt, unit, step) {
  if (fmt === 'pct') return `${Math.round(v * 100)}%`;
  const dec = step < 0.1 ? 2 : step < 1 ? 1 : 0;
  return `${Number(v).toFixed(dec)}${unit || ''}`;
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
  input.addEventListener('dblclick', () => put(M.DEFAULT_STATE[key] ?? min));
  val.addEventListener('focus', () => val.select());
  val.addEventListener('change', () => {
    let v = parseFloat(val.value.replace(',', '.'));
    if (Number.isNaN(v)) { show(state[key]); return; }
    if (format === 'pct') v /= 100;
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
  const titles = (host.dataset.titles || '').split('|');
  host.dataset.options.split(',').forEach((part, i) => {
    const [v, ...rest] = part.split(':');
    const b = el('button', '', rest.join(':'));
    b.type = 'button';
    b.dataset.v = v;
    b.title = titles[i] || rest.join(':');
    b.addEventListener('click', () => {
      if (String(state[key]) === v) return;
      state[key] = v;
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

function buildColor(input) {
  const key = input.dataset.color;
  const hex = input.parentElement.querySelector('.hex');
  const f = () => { input.value = state[key]; hex.textContent = String(state[key]).toUpperCase(); };
  f.key = key;
  input.addEventListener('input', () => { state[key] = input.value.toUpperCase(); f(); commit(); });
  binders.push(f);
}

// ---------- aperçu ----------
function currentDisplay() {
  return displays.find((d) => d.primary) || displays[0] || { width: 1920, height: 1080, pxW: 1920, pxH: 1080 };
}

function layoutStage() {
  const d = currentDisplay();
  const cw = M.CANVAS_W, ch = Math.round((cw * d.height) / d.width);
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

// coins et milieux de l'écran, à 40 px du bord
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
    if (e.button !== 0) return;
    e.preventDefault();
    const resizing = e.target === handle;
    const fr = frame.getBoundingClientRect();
    const sx = e.clientX, sy = e.clientY, ox = state.x, oy = state.y, os = state.scale;
    const cx = fr.left + ox * fr.width, cy = fr.top + oy * fr.height;
    const d0 = Math.max(6, Math.hypot(sx - cx, sy - cy));
    box.setPointerCapture(e.pointerId);
    frame.classList.add(resizing ? 'resizing' : 'dragging');
    const move = (ev) => {
      if (resizing) {
        state.scale = +clamp((os * Math.hypot(ev.clientX - cx, ev.clientY - cy)) / d0, 0.4, 3).toFixed(3);
        sync('scale');
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

// ---------- Spotify ----------
function onInfo(i) {
  const was = info;
  info = i || { ok: false, error: null, track: null };
  if (info.error && info.error !== was.error) toast(info.error);
  const t = info.track;
  const chip = $('#chip');
  let text, cls;
  if (info.error) { text = _('Spotify inaccessible'); cls = 'err'; }
  else if (t) { text = t.playing ? _('Spotify · en lecture') : _('Spotify · en pause'); cls = t.playing ? 'ok' : ''; }
  else { text = _("Spotify n'est pas ouvert · exemple"); cls = ''; }
  chip.className = `chip ${cls}`;
  $('#chip-text').textContent = text;

  $('#np-title').textContent = t ? t.title || _('Titre inconnu') : _('Rien en cours');
  $('#np-sub').textContent = t ? [t.artist, t.album].filter(Boolean).join(' — ')
    : _('Ouvre Spotify sur ce PC et lance un morceau.');
  const img = $('#np-img');
  if (t && t.cover) { if (img.getAttribute('src') !== t.cover) img.src = t.cover; img.hidden = false; } else { img.hidden = true; img.removeAttribute('src'); }
  const err = $('#np-error');
  err.hidden = !info.error;
  err.textContent = info.error || '';
  tickNote();
}

// position du morceau, à côté du titre de la carte « Spotify »
function tickNote() {
  const t = info.track;
  let text = '';
  if (t) text = t.duration > 0 ? `${M.fmtTime(M.positionOf(t))} / ${M.fmtTime(t.duration)}` : M.fmtTime(M.positionOf(t));
  const note = $('#np-note');
  if (note.textContent !== text) note.textContent = text;
}
setInterval(tickNote, 500);

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
  const collapsed = storage.get('music-collapsed', []);
  for (const sec of $$('.sec')) {
    if (collapsed.includes(sec.dataset.sec)) sec.classList.add('collapsed');
    $('.sec-head', sec).addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      sec.classList.toggle('collapsed');
      storage.set('music-collapsed', $$('.sec.collapsed').map((s) => s.dataset.sec));
    });
  }
}

// ---------- démarrage ----------
(async function start() {
  const init = await api.init();
  state = M.clone(M.merge(M.DEFAULT_STATE, init.state || {}));
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
  view = new M.View(frame, { bridge: api, output: false, onInfo });
  const above = $('.backdrop--above', frame);
  if (above) frame.append(above);
  frame.append($('#guide-v'), $('#guide-h'));
  view.box.append(handle);

  $$('.ctl.range').forEach(buildRange);
  $$('.seg[data-bind], .grid-pick[data-bind]').forEach(buildChoice);
  $$('.switch[data-bind], .chip-toggle[data-bind]').forEach(buildToggle);
  $$('input[data-color]').forEach(buildColor);
  buildPad();
  setupSections();
  setupDrag();

  layoutStage();
  new ResizeObserver(layoutStage).observe(stage);
  sync();
  commit();
  view.show();
  onInfo(view.info);
  if (document.fonts) document.fonts.ready.then(refreshPad).catch(() => {});

  api.on('displays', (d) => { displays = d; layoutStage(); refreshPad(); });
})();
