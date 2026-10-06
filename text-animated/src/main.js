const { app, BrowserWindow, ipcMain, screen, globalShortcut, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const HOTKEY = 'Control+Alt+B';
// langue du système : français, sinon anglais (les pages suivent la même règle avec navigator.language)
const L = (fr, en) => (app.getLocale().toLowerCase().startsWith('fr') ? fr : en);
const ASSETS = path.join(__dirname, '..', 'assets');
const PRELOAD = path.join(__dirname, 'preload.js');

let control = null;
let overlay = null;
let tray = null;
let store = { state: null, shared: null };
let live = false;
let since = null;
let hotkeyOk = false;
let saveTimer = null;
let hideTimer = null;
let topTimer = null;
let quitting = false;
let trayHinted = false;

// ---------- persistance ----------
const storeFile = () => path.join(app.getPath('userData'), 'pancarte.json');

function loadStore() {
  try {
    const data = JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
    store = { ...store, ...data };
    // anciennes versions : les styles enregistrés étaient à la racine
    if (!store.shared) store.shared = { styles: Array.isArray(data.styles) ? data.styles : [] };
    delete store.styles;
  } catch { /* premier lancement */ }
}

function saveStore() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(storeFile(), JSON.stringify(store, null, 1)); } catch (e) { console.error(e); }
  }, 400);
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

function targetDisplay() {
  const id = store.state && store.state.display;
  return screen.getAllDisplays().find((d) => d.id === id) || screen.getPrimaryDisplay();
}

// ---------- overlay ----------
function createOverlay() {
  const { bounds } = targetDisplay();
  overlay = new BrowserWindow({
    ...bounds,
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
    title: 'Pancarte — overlay',
    webPreferences: { preload: PRELOAD, backgroundThrottling: false },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setIgnoreMouseEvents(true);
  overlay.loadFile(path.join(__dirname, 'renderer', 'overlay.html'));
  overlay.webContents.on('did-finish-load', () => {
    overlay.webContents.send('state', store.state);
    overlay.webContents.send('live', { live, since });
    if (live) showOverlay();
  });
  overlay.on('closed', () => { overlay = null; });
}

function placeOverlay() {
  if (!overlay) return;
  overlay.setBounds(targetDisplay().bounds);
}

function showOverlay() {
  if (!overlay) return;
  clearTimeout(hideTimer);
  placeOverlay();
  overlay.showInactive();
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.moveTop();
  overlay.webContents.send('enter');
  clearInterval(topTimer);
  // certains jeux / lecteurs passent devant : on reprend la main régulièrement
  topTimer = setInterval(() => {
    if (overlay && live) { overlay.setAlwaysOnTop(true, 'screen-saver'); overlay.moveTop(); }
  }, 2500);
}

function hideOverlay() {
  if (!overlay) return;
  clearInterval(topTimer);
  overlay.webContents.send('leave');
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => { if (overlay && !live) overlay.hide(); }, 360);
}

function broadcast(channel, payload) {
  for (const w of [control, overlay]) if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
}

function setLive(v) {
  live = !!v;
  since = live ? Date.now() : null;
  live ? showOverlay() : hideOverlay();
  broadcast('live', { live, since });
  updateTray();
}

// ---------- fenêtre de contrôle ----------
function createControl() {
  control = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1120,
    minHeight: 720,
    show: false,
    backgroundColor: '#0E0D0C',
    title: 'Pancarte',
    icon: path.join(ASSETS, 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0E0D0C', symbolColor: '#A39B90', height: 40 },
    webPreferences: { preload: PRELOAD },
  });
  control.setMenuBarVisibility(false);
  control.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  control.once('ready-to-show', () => control.show());
  // pancarte affichée : fermer la fenêtre la range dans la zone de notification au lieu de tout couper
  control.on('close', (e) => {
    if (live && !quitting && tray) {
      e.preventDefault();
      control.hide();
      if (!trayHinted) {
        trayHinted = true;
        tray.displayBalloon({
          title: L('Pancarte reste affichée', 'Pancarte stays on screen'),
          content: L("Ctrl+Alt+B pour la masquer. Clic sur l'icône pour rouvrir, clic droit pour quitter.",
            'Ctrl+Alt+B to hide it. Click the icon to reopen, right-click to quit.'),
          iconType: 'none',
        });
      }
    }
  });
  control.on('closed', () => { control = null; app.quit(); });
}

function focusControl() {
  if (!control) return;
  if (control.isMinimized()) control.restore();
  control.show();
  control.focus();
}

// ---------- zone de notification ----------
function updateTray() {
  if (!tray) return;
  tray.setToolTip(live ? `Pancarte — ${L('affichée', 'on screen')}` : 'Pancarte');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: live ? L('Masquer la pancarte', 'Hide Pancarte') : L('Afficher la pancarte', 'Show Pancarte'), click: () => setLive(!live) },
    { label: L('Ouvrir Pancarte', 'Open Pancarte'), click: focusControl },
    { type: 'separator' },
    { label: L('Quitter', 'Quit'), click: () => app.quit() },
  ]));
}

function createTray() {
  try {
    tray = new Tray(nativeImage.createFromPath(path.join(ASSETS, 'tray.png')));
    tray.on('click', focusControl);
    updateTray();
  } catch (e) { console.error(e); }
}

// ---------- IPC ----------
ipcMain.handle('init', () => ({
  state: store.state,
  shared: store.shared || {},
  embedded: false,
  displays: displaysInfo(),
  live,
  since,
  hotkey: hotkeyOk ? 'Ctrl+Alt+B' : null,
}));

ipcMain.on('state', (_e, state) => {
  const prevDisplay = store.state && store.state.display;
  store.state = state;
  saveStore();
  if (overlay) overlay.webContents.send('state', state);
  if (state && state.display !== prevDisplay) placeOverlay();
});

ipcMain.on('shared', (_e, data) => {
  store.shared = data && typeof data === 'object' ? data : {};
  saveStore();
});

ipcMain.on('live', (_e, v) => setLive(v));

ipcMain.on('timer-reset', () => {
  if (!live) return;
  since = Date.now();
  broadcast('live', { live, since });
});

// ---------- cycle de vie ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', focusControl);

  app.whenReady().then(() => {
    app.setAppUserModelId('Pancarte');
    loadStore();
    createOverlay();
    createControl();
    createTray();

    hotkeyOk = globalShortcut.register(HOTKEY, () => setLive(!live));

    const onDisplays = () => {
      placeOverlay();
      if (control) control.webContents.send('displays', displaysInfo());
    };
    screen.on('display-added', onDisplays);
    screen.on('display-removed', onDisplays);
    screen.on('display-metrics-changed', onDisplays);
  });

  app.on('before-quit', () => { quitting = true; });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    try { if (store.state) fs.writeFileSync(storeFile(), JSON.stringify(store, null, 1)); } catch { /* ignore */ }
  });

  app.on('window-all-closed', () => app.quit());
}
