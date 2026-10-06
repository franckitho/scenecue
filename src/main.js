const { app, BrowserWindow, ipcMain, screen, globalShortcut, Tray, Menu, nativeImage, protocol, net, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');
const { pathToFileURL } = require('url');

// Tout (Régie, compositeur, modules) est servi par regie://app pour partager la même origine :
// les pages des modules, chargées en iframe, récupèrent ainsi leur bridge auprès de la page parente.
const ROOT = path.join(__dirname, '..'); // dossier de Régie (ou app.asar une fois packagée)
const ORIGIN = 'regie://app';
const ASSETS = path.join(ROOT, 'assets');
const PRELOAD = path.join(__dirname, 'preload.js');
const HOTKEY_TOGGLE = 'Control+Alt+B';
const MEDIA_TYPES = {
  png: 'image/png', apng: 'image/apng', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', ogv: 'video/ogg',
};

protocol.registerSchemesAsPrivileged([
  { scheme: 'regie', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);
// WebRTC sur le réseau local (module Caméra) : annoncer les vraies adresses IP plutôt que des noms mDNS,
// que Windows ou le téléphone ne savent pas toujours résoudre.
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');

let win = null;
let overlay = null;
let tray = null;
let modules = [];
const backendFiles = new Map(); // id du module -> script Node déclaré par "main" dans module.json
const backends = new Map(); // id du module -> méthodes exposées par ce script
let store = null;
let live = { scene: null, since: null };
let hotkeys = { toggle: false, scenes: false };
let saveTimer = null;
let hideTimer = null;
let topTimer = null;
let quitting = false;
let trayHinted = false;

const uid = (p) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
// langue de l'interface : choisie dans Régie, sinon celle du système (français ou anglais)
const lang = () => (store && (store.lang === 'fr' || store.lang === 'en') ? store.lang
  : app.getLocale().toLowerCase().startsWith('fr') ? 'fr' : 'en');
const L = (fr, en) => (lang() === 'en' ? en : fr);
const pageUrl = (page, query = '') => `${ORIGIN}/src/renderer/${page}?${query}${query ? '&' : ''}lang=${lang()}`;
const urlFor = (rel) => `${ORIGIN}/${rel.split(path.sep).join('/').split('/').map(encodeURIComponent).join('/')}`;

// ---------- modules ----------
function discoverModules() {
  const found = [];
  const seen = new Set();
  for (const base of [ROOT, path.join(ROOT, 'modules')]) {
    let entries = [];
    try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const dir = path.join(base, e.name);
      const manifest = path.join(dir, 'module.json');
      if (!fs.existsSync(manifest)) continue;
      try {
        const m = JSON.parse(fs.readFileSync(manifest, 'utf8'));
        const id = m.id || e.name;
        if (seen.has(id) || !m.panel || !m.layer) continue;
        seen.add(id);
        const rel = path.relative(ROOT, dir);
        if (m.main) backendFiles.set(id, path.join(dir, m.main));
        found.push({
          id,
          name: m.name || id,
          description: m.description || '',
          en: m.en || {}, // { name, description } en anglais
          version: m.version || '',
          icon: m.icon ? urlFor(path.join(rel, m.icon)) : null,
          panelUrl: urlFor(path.join(rel, m.panel)),
          layerUrl: urlFor(path.join(rel, m.layer)),
        });
      } catch (err) {
        console.error(`module.json illisible : ${manifest}`, err);
      }
    }
  }
  return found;
}

// modules dans la langue de l'interface (names : leurs noms dans toutes les langues, pour reconnaître un nom de calque automatique)
const localModules = () => modules.map(({ en, ...m }) => ({
  ...m,
  name: L(m.name, en.name || m.name),
  description: L(m.description, en.description || m.description),
  names: [...new Set([m.name, en.name].filter(Boolean))],
}));

// Backend d'un module : script Node chargé dans le processus principal (serveur, accès disque…).
// Il exporte une fonction (ctx) => { méthode(...args) {…}, dispose() {…} } ; ses pages appellent
// bridge.call('méthode', ...args) et reçoivent ses événements ctx.emit(canal, données) par bridge.on(canal).
function loadBackends() {
  for (const [id, file] of backendFiles) {
    const ctx = {
      id,
      dataDir: path.join(app.getPath('userData'), 'modules', id),
      emit: (channel, payload) => {
        for (const w of [win, overlay]) if (w && !w.isDestroyed()) w.webContents.send('module-event', { module: id, channel, payload });
      },
      log: (...args) => console.log(`[${id}]`, ...args),
      lang, // langue de l'interface : 'fr' ou 'en'
    };
    try {
      fs.mkdirSync(ctx.dataDir, { recursive: true });
      backends.set(id, require(file)(ctx) || {});
    } catch (err) {
      console.error(`backend du module ${id} illisible : ${file}`, err);
    }
  }
}

// ---------- persistance ----------
const storeFile = () => path.join(app.getPath('userData'), 'regie.json');

// Au premier lancement, reprend le texte et les styles déjà réglés dans Pancarte (text-animated en solo).
function importPancarte() {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(app.getPath('appData'), 'Pancarte', 'pancarte.json'), 'utf8'));
    return { state: p.state || null, styles: (p.shared && p.shared.styles) || p.styles || [] };
  } catch { return null; }
}

function defaultStore() {
  const s = { version: 1, scenes: [], selected: { scene: null, layer: null }, display: null, shared: {}, media: [] };
  const text = localModules().find((m) => m.id === 'text-animated');
  const old = importPancarte();
  const add = (name, state) => {
    const scene = { id: uid('s'), name, layers: [] };
    if (text) scene.layers.push({ id: uid('l'), module: text.id, name: text.name, visible: true, state });
    s.scenes.push(scene);
    return scene;
  };
  const first = add(L('Douche', 'Shower'), old ? old.state : null);
  add('BRB', null);
  if (text && old) s.shared[text.id] = { styles: old.styles };
  s.selected = { scene: first.id, layer: first.layers[0] ? first.layers[0].id : null };
  return s;
}

function loadStore() {
  try {
    store = JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
    if (!Array.isArray(store.scenes)) throw new Error('format');
    store.shared = store.shared || {};
    store.selected = store.selected || { scene: null, layer: null };
    store.media = Array.isArray(store.media) ? store.media : [];
  } catch {
    store = defaultStore();
    saveStore();
  }
}

function saveStore(now = false) {
  clearTimeout(saveTimer);
  const write = () => { try { fs.writeFileSync(storeFile(), JSON.stringify(store, null, 1)); } catch (e) { console.error(e); } };
  if (now) write(); else saveTimer = setTimeout(write, 400);
}

const sceneById = (id) => store.scenes.find((s) => s.id === id) || null;

// ---------- médiathèque ----------
// Les images et vidéos importées sont copiées dans userData/media : une scène reste valable
// même si le fichier d'origine est déplacé. Elles sont servies par regie://app/@media/<fichier>.
const mediaDir = () => path.join(app.getPath('userData'), 'media');
const mediaExt = (name) => path.extname(name).slice(1).toLowerCase();
const mediaInfo = (m) => ({ ...m, url: `${ORIGIN}/@media/${encodeURIComponent(m.file)}` });

async function addMedia(name, size, write) {
  const ext = mediaExt(name);
  const type = MEDIA_TYPES[ext];
  if (!type) throw new Error(L(`Format non pris en charge : .${ext || '?'}`, `Unsupported format: .${ext || '?'}`));
  const dup = store.media.find((m) => m.name === name && m.size === size && fs.existsSync(path.join(mediaDir(), m.file)));
  if (dup) return mediaInfo(dup);
  const id = uid('m');
  const m = { id, name, file: `${id}.${ext}`, kind: type.startsWith('video/') ? 'video' : 'image', size, added: Date.now() };
  await fs.promises.mkdir(mediaDir(), { recursive: true });
  await write(path.join(mediaDir(), m.file));
  store.media.unshift(m);
  saveStore();
  return mediaInfo(m);
}

async function importMediaPath(src) {
  const st = await fs.promises.stat(src);
  return addMedia(path.basename(src), st.size, (dest) => fs.promises.copyFile(src, dest));
}

// Lecture avec prise en charge des requêtes partielles (Range) : indispensable pour se déplacer dans une vidéo.
async function serveMedia(req, name) {
  const file = path.join(mediaDir(), path.basename(name));
  let st;
  try { st = await fs.promises.stat(file); } catch { return new Response('Introuvable', { status: 404 }); }
  const size = st.size;
  const headers = { 'Content-Type': MEDIA_TYPES[mediaExt(file)] || 'application/octet-stream', 'Accept-Ranges': 'bytes' };
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') || '');
  if (!m || (!m[1] && !m[2])) {
    headers['Content-Length'] = String(size);
    return new Response(Readable.toWeb(fs.createReadStream(file)), { status: 200, headers });
  }
  let start = m[1] ? Number(m[1]) : size - Number(m[2]);
  let end = m[1] && m[2] ? Number(m[2]) : size - 1;
  start = Math.max(0, start);
  end = Math.min(end, size - 1);
  if (start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  headers['Content-Length'] = String(end - start + 1);
  return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })), { status: 206, headers });
}

// ---------- écrans ----------
function displaysInfo() {
  const primary = screen.getPrimaryDisplay();
  return screen.getAllDisplays().map((d, i) => ({
    id: d.id,
    index: i + 1,
    primary: d.id === primary.id,
    width: d.size.width,
    height: d.size.height,
    pxW: Math.round(d.size.width * d.scaleFactor),
    pxH: Math.round(d.size.height * d.scaleFactor),
  }));
}
const targetDisplay = () => screen.getAllDisplays().find((d) => d.id === store.display) || screen.getPrimaryDisplay();

// ---------- overlay (compositeur plein écran) ----------
function sendOverlay(channel, payload) {
  if (overlay && !overlay.isDestroyed()) overlay.webContents.send(channel, payload);
}

function createOverlay() {
  overlay = new BrowserWindow({
    ...targetDisplay().bounds,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    title: 'Régie — overlay',
    webPreferences: { preload: PRELOAD, backgroundThrottling: false },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setIgnoreMouseEvents(true);
  overlay.loadURL(pageUrl('compositor.html', 'mode=overlay'));
  overlay.webContents.on('did-finish-load', () => {
    sendOverlay('modules', modules);
    sendOverlay('live', { live: !!live.scene, since: live.since });
    sendOverlay('scene', sceneById(live.scene));
    if (live.scene) showOverlay();
  });
  overlay.on('closed', () => { overlay = null; });
}

const placeOverlay = () => { if (overlay) overlay.setBounds(targetDisplay().bounds); };

function showOverlay() {
  if (!overlay) return;
  clearTimeout(hideTimer);
  placeOverlay();
  overlay.showInactive();
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.moveTop();
  sendOverlay('enter');
  clearInterval(topTimer);
  topTimer = setInterval(() => {
    if (overlay && live.scene) { overlay.setAlwaysOnTop(true, 'screen-saver'); overlay.moveTop(); }
  }, 2500);
}

function hideOverlay() {
  if (!overlay) return;
  clearInterval(topTimer);
  sendOverlay('leave');
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => { if (overlay && !live.scene) overlay.hide(); }, 480);
}

function setLive(sceneId) {
  const scene = sceneById(sceneId);
  const prev = live.scene;
  if (!scene) {
    live = { scene: null, since: null };
    hideOverlay();
  } else {
    live = { scene: scene.id, since: prev === scene.id && live.since ? live.since : Date.now() };
    sendOverlay('live', { live: true, since: live.since });
    sendOverlay('scene', scene);
    if (!prev) showOverlay();
  }
  if (win && !win.isDestroyed()) win.webContents.send('live', live);
  if (!live.scene) sendOverlay('live', { live: false, since: null });
  updateTray();
}

// ---------- fenêtre principale ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1480,
    height: 900,
    minWidth: 1220,
    minHeight: 720,
    show: false,
    backgroundColor: '#0E0D0C',
    title: 'Régie',
    icon: path.join(ASSETS, 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0E0D0C', symbolColor: '#A39B90', height: 40 },
    webPreferences: { preload: PRELOAD },
  });
  win.setMenuBarVisibility(false);
  win.loadURL(pageUrl('index.html'));
  win.once('ready-to-show', () => win.show());
  win.on('close', (e) => {
    if (live.scene && !quitting && tray) {
      e.preventDefault();
      win.hide();
      if (!trayHinted) {
        trayHinted = true;
        tray.displayBalloon({
          title: L("La scène reste à l'écran", 'The scene stays on screen'),
          content: L("Ctrl+Alt+B pour la couper. Clic sur l'icône pour rouvrir Régie, clic droit pour quitter.",
            'Ctrl+Alt+B to cut it. Click the icon to reopen Régie, right-click to quit.'),
          iconType: 'none',
        });
      }
    }
  });
  win.on('closed', () => { win = null; app.quit(); });
}

function focusWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// ---------- zone de notification ----------
function updateTray() {
  if (!tray) return;
  const current = sceneById(live.scene);
  tray.setToolTip(current ? `Régie — ${L("à l'écran", 'on screen')} : ${current.name}` : 'Régie');
  tray.setContextMenu(Menu.buildFromTemplate([
    ...store.scenes.map((s) => ({
      label: s.name,
      type: 'checkbox',
      checked: s.id === live.scene,
      click: () => setLive(s.id === live.scene ? null : s.id),
    })),
    { type: 'separator' },
    { label: L('Couper', 'Cut'), enabled: !!live.scene, click: () => setLive(null) },
    { label: L('Ouvrir Régie', 'Open Régie'), click: focusWindow },
    { type: 'separator' },
    { label: L('Quitter', 'Quit'), click: () => app.quit() },
  ]));
}

function createTray() {
  try {
    tray = new Tray(nativeImage.createFromPath(path.join(ASSETS, 'tray.png')));
    tray.on('click', focusWindow);
    updateTray();
  } catch (e) { console.error(e); }
}

// ---------- raccourcis ----------
function registerHotkeys() {
  hotkeys.toggle = globalShortcut.register(HOTKEY_TOGGLE, () => {
    setLive(live.scene ? null : (store.selected.scene || (store.scenes[0] && store.scenes[0].id)));
  });
  let ok = true;
  for (let i = 1; i <= 9; i++) {
    ok = globalShortcut.register(`Control+Alt+${i}`, () => {
      const s = store.scenes[i - 1];
      if (s) setLive(live.scene === s.id ? null : s.id);
    }) && ok;
  }
  hotkeys.scenes = ok;
}

// ---------- IPC ----------
ipcMain.handle('init', () => ({
  origin: ORIGIN,
  modules: localModules(),
  lang: lang(),
  store,
  displays: displaysInfo(),
  live,
  hotkeys,
}));

// structure des scènes (ajout, suppression, renommage, ordre, visibilité)
ipcMain.on('scenes', (_e, { scenes, selected }) => {
  if (!Array.isArray(scenes)) return;
  store.scenes = scenes;
  if (selected) store.selected = selected;
  saveStore();
  if (live.scene) {
    const s = sceneById(live.scene);
    if (s) sendOverlay('scene', s); else setLive(null);
  }
  updateTray();
});

ipcMain.on('selected', (_e, selected) => { store.selected = selected; saveStore(); });

ipcMain.on('layer-state', (_e, { scene, layer, state }) => {
  const s = sceneById(scene);
  const l = s && s.layers.find((x) => x.id === layer);
  if (!l) return;
  l.state = state;
  saveStore();
  if (scene === live.scene) sendOverlay('layer-state', { layer, state });
});

ipcMain.on('shared', (_e, { module, data }) => {
  store.shared[module] = data;
  saveStore();
});

ipcMain.on('live', (_e, sceneId) => setLive(sceneId));

ipcMain.on('timer-reset', () => {
  if (!live.scene) return;
  live.since = Date.now();
  sendOverlay('live', { live: true, since: live.since });
  if (win) win.webContents.send('live', live);
});

// langue de l'interface : la fenêtre Régie se recharge, l'overlay aussi s'il n'affiche rien
ipcMain.on('lang', (_e, value) => {
  if (value !== 'fr' && value !== 'en') return;
  store.lang = value;
  saveStore();
  updateTray();
  if (win && !win.isDestroyed()) win.loadURL(pageUrl('index.html'));
  if (overlay && !live.scene) overlay.loadURL(pageUrl('compositor.html', 'mode=overlay'));
});

ipcMain.on('display', (_e, id) => {
  store.display = id;
  saveStore();
  placeOverlay();
});

ipcMain.handle('module-call', (_e, { module, method, args }) => {
  const b = backends.get(module);
  const fn = b && method !== 'dispose' && Object.prototype.hasOwnProperty.call(b, method) ? b[method] : null;
  if (typeof fn !== 'function') throw new Error(`${L('Méthode inconnue', 'Unknown method')} : ${module}.${method}`);
  return fn.apply(b, Array.isArray(args) ? args : []);
});

ipcMain.handle('media-pick', async (e) => {
  const exts = Object.keys(MEDIA_TYPES);
  const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender) || win, {
    title: L('Choisir une image ou une vidéo', 'Choose an image or a video'),
    properties: ['openFile'],
    filters: [
      { name: L('Images et vidéos', 'Images and videos'), extensions: exts },
      { name: 'Images', extensions: exts.filter((x) => MEDIA_TYPES[x].startsWith('image/')) },
      { name: L('Vidéos', 'Videos'), extensions: exts.filter((x) => MEDIA_TYPES[x].startsWith('video/')) },
    ],
  });
  return r.canceled || !r.filePaths[0] ? null : importMediaPath(r.filePaths[0]);
});

ipcMain.handle('media-import', (_e, file) => importMediaPath(String(file)));

// fichier déposé sans chemin sur le disque : on reçoit son contenu
ipcMain.handle('media-import-data', (_e, { name, data }) => {
  const buf = Buffer.from(data);
  return addMedia(path.basename(String(name)), buf.length, (dest) => fs.promises.writeFile(dest, buf));
});

ipcMain.handle('media-list', () => store.media.filter((m) => fs.existsSync(path.join(mediaDir(), m.file))).map(mediaInfo));

// refusé tant qu'un calque utilise le média
ipcMain.handle('media-remove', async (_e, id) => {
  const m = store.media.find((x) => x.id === id);
  if (!m) return { ok: true };
  const used = store.scenes.reduce((n, s) => n + s.layers.filter((l) => JSON.stringify(l.state || null).includes(m.file)).length, 0);
  if (used) return { ok: false, used };
  store.media = store.media.filter((x) => x !== m);
  saveStore();
  await fs.promises.rm(path.join(mediaDir(), m.file), { force: true });
  return { ok: true };
});

// ---------- cycle de vie ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', focusWindow);

  app.whenReady().then(() => {
    app.setAppUserModelId('Regie');

    protocol.handle('regie', (req) => {
      const rel = decodeURIComponent(new URL(req.url).pathname);
      if (rel.startsWith('/@media/')) return serveMedia(req, rel.slice('/@media/'.length));
      const file = path.normalize(path.join(ROOT, rel));
      if (file !== ROOT && !file.startsWith(ROOT + path.sep)) return new Response('Interdit', { status: 403 });
      return net.fetch(pathToFileURL(file).toString());
    });

    modules = discoverModules();
    loadStore();
    loadBackends();
    createOverlay();
    createWindow();
    createTray();
    registerHotkeys();

    const onDisplays = () => {
      placeOverlay();
      if (win) win.webContents.send('displays', displaysInfo());
    };
    screen.on('display-added', onDisplays);
    screen.on('display-removed', onDisplays);
    screen.on('display-metrics-changed', onDisplays);
  });

  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    for (const b of backends.values()) { try { if (typeof b.dispose === 'function') b.dispose(); } catch (e) { console.error(e); } }
    if (store) saveStore(true);
  });
  app.on('window-all-closed', () => app.quit());
}
