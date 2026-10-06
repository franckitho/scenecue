const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Exposé à la fenêtre SceneCue et à l'overlay (pas aux iframes des modules : eux passent par sceneCueBridge).
const CHANNELS = ['live', 'displays', 'virtual', 'modules', 'scene', 'layer-state', 'enter', 'leave', 'module-event'];

contextBridge.exposeInMainWorld('host', {
  init: () => ipcRenderer.invoke('init'),
  saveScenes: (scenes, selected) => ipcRenderer.send('scenes', { scenes, selected }),
  saveSelected: (selected) => ipcRenderer.send('selected', selected),
  layerState: (scene, layer, state) => ipcRenderer.send('layer-state', { scene, layer, state }),
  saveShared: (module, data) => ipcRenderer.send('shared', { module, data }),
  setLive: (sceneId) => ipcRenderer.send('live', sceneId),
  resetTimer: () => ipcRenderer.send('timer-reset'),
  setDisplay: (id) => ipcRenderer.send('display', id),
  setMirror: (id) => ipcRenderer.send('mirror', id),
  setLang: (lang) => ipcRenderer.send('lang', lang),
  // médiathèque
  pickMedia: () => ipcRenderer.invoke('media-pick'),
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch { return ''; } },
  importMedia: (file) => ipcRenderer.invoke('media-import', file),
  importMediaData: (name, data) => ipcRenderer.invoke('media-import-data', { name, data }),
  listMedia: () => ipcRenderer.invoke('media-list'),
  removeMedia: (id) => ipcRenderer.invoke('media-remove', id),
  // backend d'un module (script Node déclaré par "main" dans module.json)
  callModule: (module, method, args) => ipcRenderer.invoke('module-call', { module, method, args }),
  on: (channel, fn) => {
    if (!CHANNELS.includes(channel)) return;
    ipcRenderer.on(channel, (_e, payload) => fn(payload));
  },
});
