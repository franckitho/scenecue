'use strict';
/* SceneCue — fenêtre principale : scènes, calques, édition des modules, mise à l'écran */

const _ = I18N.t; // traduction (voir i18n.js)
const LANG = I18N.lang;
I18N.apply();

// ---------- utilitaires ----------
const $ = (s, r = document) => r.querySelector(s);
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
const uid = (p) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const clone = (v) => JSON.parse(JSON.stringify(v ?? null));
// erreurs du processus principal sans le préfixe ajouté par Electron
const viaHost = (p) => p.catch((e) => {
  throw new Error(String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
});
function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}

const ICONS = {
  eye: '<path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>',
  eyeOff: '<path d="M6.6 3.7A6.6 6.6 0 0 1 8 3.5c4.1 0 6.5 4.5 6.5 4.5a11 11 0 0 1-1.6 2.1M4.2 4.9A11 11 0 0 0 1.5 8s2.4 4.5 6.5 4.5a6.4 6.4 0 0 0 3.2-.9M2 2l12 12"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5"/>',
  trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/>',
};
function iconBtn(icon, title, onClick, cls = '') {
  const b = el('button', `icon-btn ${cls}`);
  b.type = 'button';
  b.title = title;
  b.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${ICONS[icon]}</svg>`;
  b.addEventListener('click', (e) => { e.stopPropagation(); onClick(b, e); });
  return b;
}
// suppression en deux temps : le premier clic arme le bouton
function deleteBtn(title, onConfirm) {
  return iconBtn('trash', title, (b) => {
    const row = b.closest('.row');
    if (b.classList.contains('armed')) { onConfirm(); return; }
    b.classList.add('armed', 'danger');
    b.textContent = _('Supprimer ?');
    row.classList.add('confirm');
    setTimeout(() => {
      if (!b.isConnected) return;
      b.classList.remove('armed');
      b.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${ICONS.trash}</svg>`;
      row.classList.remove('confirm');
    }, 2600);
  }, 'danger');
}

// ---------- état ----------
let ORIGIN = '';
let modules = [];
let modById = new Map();
let scenes = [];
let selected = { scene: null, layer: null };
let shared = {};
let displays = [];
let displayId = null;
let live = { scene: null, since: null };
let hotkeys = {};
let panel = null; // { sceneId, layerId, module, bridge }
const lastLayer = {};

const sceneById = (id) => scenes.find((s) => s.id === id) || null;
const selScene = () => sceneById(selected.scene);
const findLayer = (sceneId, layerId) => { const s = sceneById(sceneId); return s ? s.layers.find((l) => l.id === layerId) || null : null; };
const currentDisplay = () => displays.find((d) => d.id === displayId) || displays.find((d) => d.primary) || displays[0]
  || { id: 0, index: 1, primary: true, width: 1920, height: 1080, pxW: 1920, pxH: 1080 };
const compositorUrl = (q) => `${ORIGIN}/src/renderer/compositor.html?${new URLSearchParams({ ...q, lang: LANG })}`;

function saveStructure() {
  host.saveScenes(clone(scenes), selected);
  pushAll();
}

// ---------- flux vers les compositeurs intégrés (vignette, arrière-plans des éditeurs) ----------
const feeds = new Set();
window.sceneCueFeed = {
  attach(c) { feeds.add(c); pushTo(c); },
  detach(c) { feeds.delete(c); },
  call: (module, method, args) => viaHost(host.callModule(module, method, args)),
};

// événement d'un backend : vers l'éditeur ouvert et les calques des aperçus de ce module
function onModuleEvent({ module, channel, payload }) {
  if (panel && panel.module === module) panel.bridge.emit(channel, clone(payload));
  for (const c of feeds) {
    try { c.moduleEvent(module, channel, clone(payload)); } catch { feeds.delete(c); }
  }
}

function feedLayers(c) {
  const p = c.params;
  const sceneId = p.get('scene') === '@selected' ? selected.scene : p.get('scene');
  const scene = sceneById(sceneId);
  let layers = scene ? scene.layers : [];
  const ref = p.get('ref');
  if (ref) {
    const i = layers.findIndex((l) => l.id === ref);
    const only = p.get('only');
    if (i < 0) layers = only === 'above' ? [] : layers;
    else if (only === 'below') layers = layers.slice(0, i);
    else if (only === 'above') layers = layers.slice(i + 1);
    else layers = layers.filter((l) => l.id !== ref);
  }
  return { sceneId, layers };
}

function pushTo(c) {
  try {
    const { sceneId, layers } = feedLayers(c);
    const on = !!sceneId && live.scene === sceneId;
    c.setModules(modules);
    c.setLive({ live: on, since: on ? live.since : null });
    c.setLayers(clone(layers));
  } catch {
    feeds.delete(c); // compositeur déchargé
  }
}
const pushAll = () => { feeds.forEach(pushTo); refreshMonitor(); };
function pushLayerState(layerId, state) {
  for (const c of feeds) {
    try { c.setLayerState(layerId, clone(state)); } catch { feeds.delete(c); }
  }
}

// ---------- éditeur du calque (page « panel » du module) ----------
const panelFrame = $('#panel');

window.sceneCueBridge = (win) => (panel && panelFrame.contentWindow === win ? panel.bridge : null);

function makePanelBridge(sceneId, layerId, moduleId) {
  const listeners = {};
  return {
    embedded: true,
    init: async () => {
      const L = findLayer(sceneId, layerId);
      const on = live.scene === sceneId;
      return {
        state: L ? clone(L.state) : null,
        shared: clone(shared[moduleId] || {}),
        displays: [{ ...currentDisplay(), primary: true }],
        live: on,
        since: on ? live.since : null,
        hotkey: hotkeys.toggle ? 'Ctrl+Alt+B' : null,
        embedded: true,
        backdrop: {
          below: compositorUrl({ scene: sceneId, ref: layerId, only: 'below' }),
          above: compositorUrl({ scene: sceneId, ref: layerId, only: 'above' }),
        },
      };
    },
    saveState: (state) => {
      const L = findLayer(sceneId, layerId);
      if (!L) return;
      L.state = clone(state);
      host.layerState(sceneId, layerId, L.state);
      pushLayerState(layerId, L.state);
    },
    saveShared: (data) => {
      shared[moduleId] = clone(data);
      host.saveShared(moduleId, shared[moduleId]);
    },
    setLive: (v) => setLive(v ? sceneId : null),
    resetTimer: () => host.resetTimer(),
    call: (method, ...args) => viaHost(host.callModule(moduleId, method, args)),
    // médiathèque commune à tous les modules
    pickMedia: () => viaHost(host.pickMedia()),
    importMedia: async (file) => {
      let p = '';
      try { p = host.pathForFile(file); } catch { /* fichier sans chemin (glissé depuis un navigateur…) */ }
      return viaHost(p ? host.importMedia(p) : host.importMediaData(file.name, await file.arrayBuffer()));
    },
    listMedia: () => viaHost(host.listMedia()),
    removeMedia: (id) => viaHost(host.removeMedia(id)),
    // renomme le calque, sauf si l'utilisateur lui a déjà donné un nom
    suggestName: (name) => {
      const s = sceneById(sceneId);
      const L = findLayer(sceneId, layerId);
      const mod = modById.get(moduleId);
      name = String(name || '').trim().slice(0, 40);
      if (!s || !L || !mod || !name) return;
      // nom automatique : « Caméra », « Caméra 2 »… dans l'une ou l'autre langue
      const auto = L.name === L.autoName || (mod.names || [mod.name]).some((n) => L.name === n
        || (L.name.startsWith(`${n} `) && /^\d+$/.test(L.name.slice(n.length + 1))));
      if (!auto) return;
      const next = uniqueName(name, s.layers.filter((x) => x !== L).map((x) => x.name));
      if (next === L.name) return;
      L.name = next;
      L.autoName = next;
      saveStructure();
      renderLayers();
    },
    on: (ch, fn) => { (listeners[ch] = listeners[ch] || []).push(fn); },
    emit: (ch, payload) => {
      for (const fn of listeners[ch] || []) { try { fn(payload); } catch (e) { console.error(e); } }
    },
  };
}

function openPanel() {
  const s = selScene();
  const empty = $('#empty');
  if (!s || !s.layers.length) {
    panel = null;
    panelFrame.hidden = true;
    panelFrame.removeAttribute('src');
    showEmpty(s);
    return;
  }
  let L = s.layers.find((l) => l.id === selected.layer);
  if (!L) {
    L = s.layers[s.layers.length - 1];
    selected.layer = L.id;
    host.saveSelected(selected);
    renderLayers();
  }
  if (panel && panel.sceneId === s.id && panel.layerId === L.id) return;
  const mod = modById.get(L.module);
  if (!mod) {
    panel = null;
    panelFrame.hidden = true;
    showEmpty(s, _('Le module « {name} » est introuvable', { name: L.module }));
    return;
  }
  empty.hidden = true;
  panel = { sceneId: s.id, layerId: L.id, module: L.module, bridge: makePanelBridge(s.id, L.id, L.module) };
  panelFrame.hidden = false;
  panelFrame.src = `${mod.panelUrl}?embed=1&lang=${LANG}&layer=${encodeURIComponent(L.id)}`;
}

function modCard(m, onClick) {
  const b = el('button', 'mod-card');
  b.type = 'button';
  if (m.icon) { const img = el('img'); img.src = m.icon; img.alt = ''; b.append(img); } else b.append(el('span', 'mod-ph'));
  const t = el('span');
  t.append(el('b', '', m.name));
  if (m.description) t.append(el('span', '', m.description));
  b.append(t);
  b.addEventListener('click', onClick);
  return b;
}

function showEmpty(scene, title) {
  const empty = $('#empty');
  empty.hidden = false;
  $('#empty-title').textContent = title || (scene ? _("« {name} » n'a encore aucun calque", { name: scene.name }) : _('Crée une scène pour commencer'));
  const cat = $('#catalog');
  cat.replaceChildren();
  if (!scene) return;
  if (!modules.length) {
    cat.append(el('p', 'empty-text', _('Aucun module trouvé. Un module est un dossier avec un module.json, placé à côté de SceneCue.')));
    return;
  }
  for (const m of modules) cat.append(modCard(m, () => addLayer(m.id)));
}

// ---------- scènes ----------
function selectScene(id) {
  if (selected.scene) lastLayer[selected.scene] = selected.layer;
  selected = { scene: id, layer: lastLayer[id] || null };
  const s = selScene();
  if (s && !s.layers.some((l) => l.id === selected.layer)) selected.layer = s.layers.length ? s.layers[s.layers.length - 1].id : null;
  host.saveSelected(selected);
  renderAll();
  openPanel();
  pushAll();
}

function uniqueName(base, taken) {
  if (!taken.includes(base)) return base;
  let n = 2;
  while (taken.includes(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

function addScene() {
  const s = { id: uid('s'), name: uniqueName(_('Nouvelle scène'), scenes.map((x) => x.name)), layers: [] };
  scenes.push(s);
  saveStructure();
  selectScene(s.id);
  const row = $(`#scenes .row[data-id="${s.id}"]`);
  if (row) startRename(row, s, () => renderScenes());
}

function duplicateScene(id) {
  const src = sceneById(id);
  if (!src) return;
  const copy = clone(src);
  copy.id = uid('s');
  copy.name = uniqueName(_('{name} (copie)', { name: src.name }), scenes.map((x) => x.name));
  copy.layers.forEach((l) => { l.id = uid('l'); });
  scenes.splice(scenes.indexOf(src) + 1, 0, copy);
  saveStructure();
  selectScene(copy.id);
}

function deleteScene(id) {
  const i = scenes.findIndex((s) => s.id === id);
  if (i < 0) return;
  scenes.splice(i, 1);
  if (selected.scene === id) {
    const next = scenes[Math.min(i, scenes.length - 1)];
    selected = { scene: next ? next.id : null, layer: null };
  }
  saveStructure();
  selectScene(selected.scene);
}

// ---------- calques ----------
function selectLayer(id) {
  selected.layer = id;
  host.saveSelected(selected);
  renderLayers();
  openPanel();
}

function addLayer(moduleId) {
  const s = selScene();
  const m = modById.get(moduleId);
  if (!s || !m) return;
  const layer = { id: uid('l'), module: m.id, name: uniqueName(m.name, s.layers.map((l) => l.name)), visible: true, state: null };
  s.layers.push(layer);
  selected.layer = layer.id;
  saveStructure();
  renderAll();
  openPanel();
}

function duplicateLayer(id) {
  const s = selScene();
  const i = s ? s.layers.findIndex((l) => l.id === id) : -1;
  if (i < 0) return;
  const copy = clone(s.layers[i]);
  copy.id = uid('l');
  copy.name = uniqueName(_('{name} (copie)', { name: s.layers[i].name }), s.layers.map((l) => l.name));
  s.layers.splice(i + 1, 0, copy);
  selected.layer = copy.id;
  saveStructure();
  renderAll();
  openPanel();
}

function deleteLayer(id) {
  const s = selScene();
  const i = s ? s.layers.findIndex((l) => l.id === id) : -1;
  if (i < 0) return;
  s.layers.splice(i, 1);
  if (selected.layer === id) {
    const next = s.layers[Math.min(i, s.layers.length - 1)];
    selected.layer = next ? next.id : null;
  }
  saveStructure();
  renderAll();
  openPanel();
}

function toggleLayer(id) {
  const L = findLayer(selected.scene, id);
  if (!L) return;
  L.visible = L.visible === false;
  saveStructure();
  renderLayers();
}

// ---------- renommage en place ----------
function startRename(row, item, done) {
  const name = row.querySelector('.row-name');
  if (!name) return;
  const input = el('input', 'row-input');
  input.value = item.name;
  input.maxLength = 40;
  row.draggable = false;
  name.replaceWith(input);
  input.focus();
  input.select();
  let finished = false;
  const finish = (ok) => {
    if (finished) return;
    finished = true;
    const v = input.value.trim();
    if (ok && v && v !== item.name) { item.name = v; saveStructure(); }
    done();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
    e.stopPropagation();
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
}

// ---------- glisser-déposer pour réordonner ----------
let drag = null;
function clearDrop() { document.querySelectorAll('.drop-before, .drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after')); }
function makeDraggable(li, kind, onDrop) {
  li.draggable = true;
  li.addEventListener('dragstart', (e) => {
    drag = { kind, id: li.dataset.id };
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', li.dataset.id);
  });
  li.addEventListener('dragend', () => { li.classList.remove('dragging'); clearDrop(); drag = null; });
  li.addEventListener('dragover', (e) => {
    if (!drag || drag.kind !== kind || drag.id === li.dataset.id) return;
    e.preventDefault();
    const r = li.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    clearDrop();
    li.classList.add(after ? 'drop-after' : 'drop-before');
  });
  li.addEventListener('drop', (e) => {
    if (!drag || drag.kind !== kind) return;
    e.preventDefault();
    const after = li.classList.contains('drop-after');
    clearDrop();
    onDrop(drag.id, li.dataset.id, after);
  });
}
function moveItem(list, fromId, toId, before) {
  const from = list.findIndex((x) => x.id === fromId);
  if (from < 0) return false;
  const [item] = list.splice(from, 1);
  let to = list.findIndex((x) => x.id === toId);
  if (to < 0) { list.splice(from, 0, item); return false; }
  if (!before) to += 1;
  list.splice(to, 0, item);
  return true;
}

// ---------- rendu des listes ----------
function renderScenes() {
  const ol = $('#scenes');
  ol.replaceChildren();
  scenes.forEach((s, i) => {
    const li = el('li', 'row');
    li.dataset.id = s.id;
    li.classList.toggle('on', s.id === selected.scene);
    li.classList.toggle('live', s.id === live.scene);
    li.append(el('span', 'tally'), el('span', 'row-name', s.name));
    if (i < 9) {
      const k = el('span', 'key', String(i + 1));
      k.title = `Ctrl+Alt+${i + 1}`;
      li.append(k);
    }
    const acts = el('span', 'acts');
    acts.append(
      iconBtn('copy', _('Dupliquer la scène'), () => duplicateScene(s.id)),
      deleteBtn(_('Supprimer la scène'), () => deleteScene(s.id)),
    );
    li.append(acts);
    li.addEventListener('click', () => { if (s.id !== selected.scene) selectScene(s.id); });
    li.addEventListener('dblclick', () => startRename(li, s, () => renderScenes()));
    makeDraggable(li, 'scene', (from, to, after) => {
      if (moveItem(scenes, from, to, !after)) { saveStructure(); renderScenes(); }
    });
    ol.append(li);
  });
}

function renderLayers() {
  const ol = $('#layers');
  ol.replaceChildren();
  const s = selScene();
  $('#add-layer').disabled = !s;
  $('#layers-note').hidden = !s || s.layers.length < 2;
  if (!s) return;
  // affichage du haut vers le bas : le dernier du tableau est devant
  [...s.layers].reverse().forEach((l) => {
    const m = modById.get(l.module);
    const li = el('li', 'row');
    li.dataset.id = l.id;
    li.classList.toggle('on', l.id === selected.layer);
    li.classList.toggle('hidden-layer', l.visible === false);
    li.append(iconBtn(l.visible === false ? 'eyeOff' : 'eye', _(l.visible === false ? 'Afficher le calque' : 'Masquer le calque'), () => toggleLayer(l.id), `eye ${l.visible === false ? 'off' : ''}`));
    if (m && m.icon) { const img = el('img', 'row-icon'); img.src = m.icon; img.alt = ''; li.append(img); } else li.append(el('span', 'row-icon'));
    li.append(el('span', 'row-name', l.name));
    const acts = el('span', 'acts');
    acts.append(
      iconBtn('copy', _('Dupliquer le calque'), () => duplicateLayer(l.id)),
      deleteBtn(_('Supprimer le calque'), () => deleteLayer(l.id)),
    );
    li.append(acts);
    li.addEventListener('click', () => { if (l.id !== selected.layer) selectLayer(l.id); });
    li.addEventListener('dblclick', () => startRename(li, l, () => renderLayers()));
    // la liste est inversée : « après » à l'écran = « avant » dans le tableau
    makeDraggable(li, 'layer', (from, to, after) => {
      if (moveItem(s.layers, from, to, after)) { saveStructure(); renderLayers(); }
    });
    ol.append(li);
  });
}

function refreshMonitor() {
  const s = selScene();
  const d = currentDisplay();
  $('#monitor').style.setProperty('--ar', `${d.width} / ${d.height}`);
  $('#monitor-empty').hidden = !!(s && s.layers.some((l) => l.visible !== false));
  $('#monitor-empty').textContent = _(s ? 'Scène vide' : 'Aucune scène');
}

function renderAll() {
  renderScenes();
  renderLayers();
  refreshMonitor();
  updateTransport();
}

// ---------- antenne ----------
function setLive(sceneId) { host.setLive(sceneId); }

function updateTransport() {
  const sel = selScene();
  const cur = sceneById(live.scene);
  const btn = $('#onair');
  const time = cur && live.since ? fmtTime((Date.now() - live.since) / 1000) : '';
  btn.disabled = !sel && !cur;
  btn.classList.toggle('on', !!cur && !!sel && cur.id === sel.id);
  btn.classList.toggle('switch', !!cur && !!sel && cur.id !== sel.id);
  let title, sub;
  if (!sel && !cur) { title = _('Aucune scène'); sub = _('Hors antenne'); }
  else if (!cur) { title = _("Mettre « {name} » à l'écran", { name: sel.name }); sub = _('Hors antenne'); }
  else if (!sel || cur.id === sel.id) { title = _('Couper « {name} »', { name: cur.name }); sub = `${_("À l'écran")} · ${time}`; }
  else { title = _('Passer à « {name} »', { name: sel.name }); sub = `${_("À l'écran : {name}", { name: cur.name })} · ${time}`; }
  $('#onair-title').textContent = title;
  $('#onair-sub').textContent = sub;
  $('#cut').hidden = !(cur && sel && cur.id !== sel.id);
  $('#tb-status-text').textContent = cur ? `${_("À l'écran")} · ${cur.name}` : _('Hors antenne');
  document.body.classList.toggle('is-live', !!cur);
  const selLive = !!cur && !!sel && cur.id === sel.id;
  document.body.classList.toggle('is-on-air', selLive);
  $('#monitor-label').textContent = _(selLive ? "À l'écran" : 'Aperçu');
  $('#monitor-meta').textContent = sel ? sel.name : '';
}

$('#onair').addEventListener('click', () => {
  const sel = selScene();
  const cur = sceneById(live.scene);
  if (!cur) { if (sel) setLive(sel.id); }
  else if (!sel || cur.id === sel.id) setLive(null);
  else setLive(sel.id);
});
$('#cut').addEventListener('click', () => setLive(null));

function onLive(l) {
  live = l;
  renderScenes();
  updateTransport();
  pushAll();
  if (panel) {
    const on = live.scene === panel.sceneId;
    panel.bridge.emit('live', { live: on, since: on ? live.since : null });
  }
}

// ---------- sortie (écran) ----------
function buildDisplays() {
  const sel = $('#display');
  sel.replaceChildren();
  for (const d of displays) {
    const o = el('option', '', `${_('Écran {n}', { n: d.index })} · ${d.pxW}×${d.pxH}`);
    o.value = d.id;
    if (d.primary) o.title = _('Écran principal');
    sel.append(o);
  }
  sel.value = currentDisplay().id;
}
function displayChanged() {
  refreshMonitor();
  if (panel) panel.bridge.emit('displays', [{ ...currentDisplay(), primary: true }]);
}
$('#display').addEventListener('change', (e) => {
  displayId = Number(e.target.value);
  host.setDisplay(displayId);
  displayChanged();
});

// ---------- menu des modules ----------
const menu = $('#module-menu');
function openMenu(anchor) {
  menu.replaceChildren();
  if (!modules.length) menu.append(el('p', 'side-note', _('Aucun module trouvé.')));
  for (const m of modules) menu.append(modCard(m, () => { closeMenu(); addLayer(m.id); }));
  menu.hidden = false;
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${Math.min(r.left, innerWidth - menu.offsetWidth - 8)}px`;
  menu.style.top = `${Math.min(r.bottom + 6, innerHeight - menu.offsetHeight - 8)}px`;
}
function closeMenu() { menu.hidden = true; }
$('#add-layer').addEventListener('click', (e) => { e.stopPropagation(); if (menu.hidden) openMenu(e.currentTarget); else closeMenu(); });
document.addEventListener('pointerdown', (e) => { if (!menu.hidden && !menu.contains(e.target) && !e.target.closest('#add-layer')) closeMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
$('#add-scene').addEventListener('click', addScene);

// langue de l'interface : SceneCue recharge sa fenêtre dans la langue choisie
for (const b of $('#lang').children) {
  b.classList.toggle('on', b.dataset.v === LANG);
  b.addEventListener('click', () => { if (b.dataset.v !== LANG) host.setLang(b.dataset.v); });
}
// un fichier lâché hors de l'éditeur d'un module ne doit pas remplacer la page de SceneCue
for (const t of ['dragover', 'drop']) document.addEventListener(t, (e) => e.preventDefault());

// ---------- démarrage ----------
(async function start() {
  const init = await host.init();
  ORIGIN = init.origin;
  modules = init.modules || [];
  modById = new Map(modules.map((m) => [m.id, m]));
  scenes = init.store.scenes || [];
  selected = init.store.selected || { scene: null, layer: null };
  shared = init.store.shared || {};
  displays = init.displays || [];
  displayId = init.store.display;
  live = init.live || { scene: null, since: null };
  hotkeys = init.hotkeys || {};

  if (!sceneById(selected.scene)) selected = { scene: scenes[0] ? scenes[0].id : null, layer: null };

  buildDisplays();
  renderAll();
  openPanel();
  $('#monitor-frame').src = compositorUrl({ scene: '@selected' });

  if (!hotkeys.toggle) $('#hotkeys .hk').classList.add('off');
  if (!hotkeys.scenes) $('#hk-scenes').classList.add('off');

  host.on('live', onLive);
  host.on('module-event', onModuleEvent);
  host.on('displays', (d) => { displays = d; buildDisplays(); displayChanged(); });
  setInterval(updateTransport, 500);
})();
