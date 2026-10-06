'use strict';
/* Média — éditeur d'un calque image / GIF / vidéo */

const M = window.Media;
const _ = I18N.t; // traduction (voir i18n.js et en.js)
I18N.apply();
// virgule décimale en français, point en anglais
const dec = (v) => (I18N.lang === 'fr' ? String(v).replace('.', ',') : String(v));
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
  const lib = [];
  const input = document.getElementById('file-input');
  const fromFile = (file) => {
    const m = {
      id: `b${Date.now().toString(36)}`, file: file.name, name: file.name, size: file.size,
      kind: (file.type || '').startsWith('video/') ? 'video' : 'image', url: URL.createObjectURL(file),
    };
    lib.unshift(m);
    return m;
  };
  return {
    init: async () => ({ state: null, shared: {}, live: false, displays: [{ id: 1, index: 1, primary: true, width: 1920, height: 1080, pxW: 1920, pxH: 1080 }] }),
    saveState() {}, saveShared() {}, setLive() {}, resetTimer() {}, suggestName() {},
    pickMedia: () => new Promise((resolve) => {
      input.onchange = () => { const f = input.files[0]; input.value = ''; resolve(f ? fromFile(f) : null); };
      input.click();
    }),
    importMedia: async (file) => fromFile(file),
    listMedia: async () => lib.slice(),
    removeMedia: async (id) => { const i = lib.findIndex((m) => m.id === id); if (i >= 0) lib.splice(i, 1); return { ok: true }; },
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
const round2 = (v) => Math.round(v * 100) / 100;
const baseName = (name) => String(name || '').replace(/\.[^.]+$/, '');
function fmtBytes(b) {
  if (!b) return '';
  if (b < 1024 * 1024) return `${Math.max(1, Math.round(b / 1024))} ${_('Ko')}`;
  return `${dec((b / 1024 / 1024).toFixed(1))} ${_('Mo')}`;
}

// ---------- état ----------
let state;
let info = { loading: false, error: null, kind: null, w: 0, h: 0, duration: 0, frames: 0 };
let displays = [];
let lib = [];
let player;
let fitPending = false;
let listen = false;
const frame = $('#frame');
const stage = $('#stage');
const handle = el('div', 'md-handle');
const binders = [];

let sendQueued = false;
function commit() {
  player.update(state);
  refreshVisibility();
  refreshTrim();
  refreshHint();
  if (!sendQueued) {
    sendQueued = true;
    requestAnimationFrame(() => { sendQueued = false; api.saveState(M.clone(state)); });
  }
}

function edited(key) {
  if (key === 'entrance') player.replay();
}

const sync = (key) => binders.forEach((f) => (!key || f.key === key) && f());

// ---------- affichage conditionnel ----------
const kind = () => (state.media ? info.kind || (state.media.kind === 'video' ? 'video' : null) : null);
const isTimed = () => kind() === 'video' || kind() === 'anim';
const WHEN = {
  none: () => !state.media,
  media: () => !!state.media,
  timed: isTimed,
  still: () => kind() === 'image',
  video: () => kind() === 'video',
  repeatable: () => state.mode !== 'once',
  finite: () => state.mode === 'once' || state.repeat > 0,
  sound: () => !!state.sound,
  free: () => state.fit === 'free' && !!state.media,
  'bounce-long': () => state.mode === 'bounce' && kind() === 'video' && trimLen() > 10,
  'bounce-sound': () => state.mode === 'bounce' && !!state.sound,
};
function refreshVisibility() {
  for (const e of $$('[data-when]')) e.hidden = !WHEN[e.dataset.when]();
  $('#pick').hidden = !!state.media;
  handle.hidden = !state.media || state.fit !== 'free';
  frame.classList.toggle('editable', !!state.media && state.fit === 'free');
}

function refreshHint() {
  let text = '';
  if (state.media && state.fit === 'free') text = _('Glisse le média pour le placer · tire le coin pour le redimensionner · Alt : sans aimant');
  else if (state.media) text = _('Cadrage plein écran · passe en « Libre » pour déplacer le média');
  $('#stage-hint').textContent = text;
}

// ---------- contrôles liés à l'état ----------
function fmtValue(v, fmt, unit, step) {
  if (fmt === 'pct') return `${Math.round(v * 100)}%`;
  if (fmt === 'count') return v ? `${v}×` : '∞';
  if (fmt === 's0') return v ? `${v} s` : '∞';
  if (fmt === 's') return `${dec(round2(v))} s`;
  const digits = step < 0.1 ? 2 : step < 1 ? 1 : 0;
  const s = Number(v).toFixed(digits);
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
  player.resize(w, h);
  frame.style.setProperty('--px', `${1 / player.k}px`); // 1 px à l'écran, dans le canevas mis à l'échelle
  $('#scale-note').textContent = `${Math.round((w / d.pxW) * 100)}%`;
}

function padPositions() {
  const r = player.rect || { w: 0, h: 0 };
  const m = 48;
  const ex = clamp((r.w / 2 + m) / player.cw, 0, 0.5);
  const ey = clamp((r.h / 2 + m) / player.ch, 0, 0.5);
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
  const box = player.box;
  const gv = $('#guide-v'), gh = $('#guide-h');
  box.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !state.media || state.fit !== 'free') return;
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
        state.size = +clamp((os * Math.hypot(ev.clientX - cx, ev.clientY - cy)) / d0, 0.03, 1).toFixed(3);
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

// ---------- découpe ----------
function trimRange() {
  const D = info.duration || 0;
  const a = clamp(state.trimA || 0, 0, D);
  const b = state.trimB == null ? D : clamp(state.trimB, a, D);
  return [a, b, D];
}
const trimLen = () => { const [a, b] = trimRange(); return b - a; };

function refreshTrim() {
  const [a, b, D] = trimRange();
  const pct = (t) => `${D ? (t / D) * 100 : 0}%`;
  $('#trim-a').style.left = pct(a);
  $('#trim-b').style.left = pct(b);
  $('#trim-sel').style.left = pct(a);
  $('#trim-sel').style.width = D ? `${((b - a) / D) * 100}%` : '0';
  $('#trim-note').textContent = D ? `${M.fmtTime(a)} → ${M.fmtTime(b)} · ${dec((b - a).toFixed(1))} s` : '';
  $('#trim-reset').disabled = !(state.trimA > 0 || state.trimB != null);
}

function setupTrim() {
  for (const [sel, which] of [['#trim-a', 'a'], ['#trim-b', 'b']]) {
    const h = $(sel);
    h.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !info.duration) return;
      e.preventDefault();
      h.setPointerCapture(e.pointerId);
      const track = $('#trim-track').getBoundingClientRect();
      const move = (ev) => {
        const D = info.duration;
        const [a, b] = trimRange();
        const minGap = Math.min(0.1, D / 4);
        let t = clamp((ev.clientX - track.left) / track.width, 0, 1) * D;
        if (which === 'a') {
          t = clamp(t, 0, b - minGap);
          state.trimA = round2(t);
        } else {
          t = clamp(t, a + minGap, D);
          state.trimB = D - t < 0.02 ? null : round2(t);
        }
        player.scrub(t);
        commit();
      };
      const up = () => {
        h.removeEventListener('pointermove', move);
        h.removeEventListener('pointerup', up);
        h.removeEventListener('pointercancel', up);
        h.removeEventListener('lostpointercapture', up);
        h.classList.remove('active');
        player.endScrub();
      };
      h.classList.add('active');
      h.addEventListener('pointermove', move);
      h.addEventListener('pointerup', up);
      h.addEventListener('pointercancel', up);
      h.addEventListener('lostpointercapture', up);
    });
  }
  $('#trim-reset').addEventListener('click', () => { state.trimA = 0; state.trimB = null; commit(); });
}

// horloge et tête de lecture
let lastClock = '';
function frameLoop() {
  const t = player.currentTime();
  const D = info.duration;
  if (D && t != null) {
    const txt = `${M.fmtTime(t)} / ${M.fmtTime(D)}`;
    if (txt !== lastClock) { $('#clock').textContent = txt; lastClock = txt; }
    $('#trim-play').style.left = `${clamp(t / D, 0, 1) * 100}%`;
  }
  requestAnimationFrame(frameLoop);
}

// ---------- média et bibliothèque ----------
function thumbOf(m) {
  if (m.kind === 'video') {
    const v = el('video');
    v.muted = true;
    v.preload = 'metadata';
    v.src = `${m.url}#t=0.4`;
    return v;
  }
  const img = el('img');
  img.loading = 'lazy';
  img.draggable = false;
  img.alt = '';
  img.src = m.url;
  return img;
}

function kindLabel() {
  const ext = M.extOf((state.media && (state.media.file || state.media.name)) || '').toUpperCase();
  if (info.kind === 'video') return _('Vidéo');
  if (info.kind === 'anim') return _('{ext} animé', { ext: ext === 'APNG' ? 'PNG' : ext });
  if (info.kind === 'image') return _('Image fixe');
  return state.media && state.media.kind === 'video' ? _('Vidéo') : _('Image');
}

let thumbUrl = null;
function refreshMedia() {
  const m = state.media;
  $('#replace-text').textContent = m ? _('Remplacer…') : _('Choisir…');
  $('#media-name').textContent = m ? m.name : _('Aucun média');
  const infoEl = $('#media-info');
  infoEl.classList.toggle('error', !!info.error);
  if (!m) infoEl.textContent = _('Importe un fichier ou choisis-en un dans la bibliothèque.');
  else if (info.error) infoEl.textContent = info.error;
  else if (info.loading) infoEl.textContent = _('Chargement…');
  else {
    const parts = [kindLabel(), info.w ? `${info.w}×${info.h}` : ''];
    if (info.kind === 'anim') parts.push(_('{n} images', { n: info.frames }));
    if (info.duration) parts.push(`${dec(info.duration.toFixed(1))} s`);
    parts.push(fmtBytes(m.size));
    infoEl.textContent = parts.filter(Boolean).join(' · ');
  }
  $('#play-note').textContent = m && !info.loading && !info.error ? kindLabel() : '';
  const url = m ? m.url : null;
  if (url !== thumbUrl) {
    thumbUrl = url;
    $('#thumb').replaceChildren(...(m ? [thumbOf(m)] : []));
  }
}

async function loadLib() {
  try { lib = await api.listMedia(); } catch { lib = []; }
  renderLib();
}

function renderLib() {
  const box = $('#lib');
  box.replaceChildren();
  for (const m of lib.slice(0, 60)) {
    const t = el('div', 'lib-item');
    t.tabIndex = 0;
    t.title = m.name;
    t.classList.toggle('on', !!state.media && state.media.id === m.id);
    t.append(thumbOf(m));
    const ext = M.extOf(m.file || m.name);
    t.append(el('span', 'lib-tag', m.kind === 'video' ? 'VID' : ext.toUpperCase()));
    const del = el('button', 'lib-del');
    del.type = 'button';
    del.title = _('Retirer de la bibliothèque');
    del.innerHTML = '<svg viewBox="0 0 10 10"><path d="M2 2l6 6M8 2l-6 6"/></svg>';
    del.addEventListener('click', (e) => { e.stopPropagation(); removeFromLib(m, t, del); });
    t.append(del);
    t.addEventListener('click', () => useMedia(m));
    t.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); useMedia(m); } });
    box.append(t);
  }
  $('#lib-empty').hidden = lib.length > 0;
  $('#lib-count').textContent = lib.length ? _(lib.length > 1 ? '{n} fichiers' : '{n} fichier', { n: lib.length }) : '';
}

// suppression en deux temps
async function removeFromLib(m, tile, del) {
  if (!tile.classList.contains('armed')) {
    tile.classList.add('armed');
    del.title = _('Cliquer encore pour supprimer');
    setTimeout(() => tile.classList.remove('armed'), 2600);
    return;
  }
  try {
    const r = await api.removeMedia(m.id);
    if (!r.ok) toast(_(r.used > 1 ? "Utilisé par {n} calques : retire-le de la scène d'abord." : "Utilisé par {n} calque : retire-le de la scène d'abord.", { n: r.used }));
  } catch (e) { toast(e.message || String(e)); }
  loadLib();
}

function useMedia(m) {
  if (!m) return;
  const same = !!state.media && state.media.id === m.id;
  state.media = { id: m.id, file: m.file, url: m.url, name: m.name, kind: m.kind, size: m.size };
  if (!same) {
    state.trimA = 0;
    state.trimB = null;
    fitPending = true;
  }
  api.suggestName(baseName(m.name));
  commit();
  renderLib();
  refreshMedia();
}

async function importWith(promise) {
  document.body.classList.add('busy');
  try {
    const m = await promise;
    if (m) {
      await loadLib();
      useMedia(m);
    }
  } catch (e) {
    toast((e && e.message) || String(e));
  } finally {
    document.body.classList.remove('busy');
  }
}
const pick = () => importWith(api.pickMedia());
$('#pick-btn').addEventListener('click', pick);
$('#replace').addEventListener('click', pick);

// glisser-déposer un fichier n'importe où dans l'éditeur
let dragDepth = 0;
const hasFiles = (e) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
document.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  document.body.classList.add('dragover');
});
document.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
document.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) document.body.classList.remove('dragover');
});
document.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragover');
  const f = e.dataTransfer.files[0];
  if (f) importWith(api.importMedia(f));
});

let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4500);
}

// le lecteur signale ce qu'il a chargé (taille, durée, erreur)
function onInfo(i) {
  const prevError = info.error;
  info = i;
  if (i.error && i.error !== prevError) toast(i.error);
  if (fitPending && i.w && i.h) {
    fitPending = false;
    // un média haut ou petit ne doit pas déborder ni être trop agrandi
    const d = currentDisplay();
    const maxH = (0.8 * player.ch * i.w) / i.h / player.cw;
    const sharp = Math.max(0.1, (2 * i.w) / (d.pxW || 1920));
    const size = Math.min(state.size, maxH, sharp);
    if (size < state.size) { state.size = +size.toFixed(3); sync('size'); }
    if (state.fit === 'free') commit();
  }
  refreshMedia();
  refreshVisibility();
  refreshTrim();
  refreshPad();
}

// ---------- transport de l'aperçu ----------
$('#replay').addEventListener('click', () => player.replay());
$('#listen').addEventListener('click', () => {
  listen = !listen;
  $('#listen').classList.toggle('on', listen);
  player.setAudio(listen);
});

// ---------- sections repliables ----------
function setupSections() {
  const collapsed = storage.get('media-collapsed', []);
  for (const sec of $$('.sec')) {
    if (collapsed.includes(sec.dataset.sec)) sec.classList.add('collapsed');
    $('.sec-head', sec).addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      sec.classList.toggle('collapsed');
      storage.set('media-collapsed', $$('.sec.collapsed').map((s) => s.dataset.sec));
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
  player = new M.Player(frame, { onInfo });
  const above = $('.backdrop--above', frame);
  if (above) frame.append(above);
  frame.append($('#guide-v'), $('#guide-h'));
  player.box.append(handle);

  $$('.ctl.range').forEach(buildRange);
  $$('.seg[data-bind], .grid-pick[data-bind]').forEach(buildChoice);
  $$('.switch[data-bind], .chip-toggle[data-bind]').forEach(buildToggle);
  buildPad();
  setupSections();
  setupDrag();
  setupTrim();

  layoutStage();
  new ResizeObserver(layoutStage).observe(stage);
  sync();
  refreshMedia();
  commit();
  player.show();
  loadLib();

  api.on('displays', (d) => { displays = d; layoutStage(); refreshPad(); });
  requestAnimationFrame(frameLoop);
})();
