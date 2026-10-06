const { contextBridge, ipcRenderer } = require('electron');

// Même API que celle fournie par SceneCue : le module fonctionne à l'identique en solo ou dans une scène.
const CHANNELS = ['state', 'live', 'displays', 'enter', 'leave', 'show'];

contextBridge.exposeInMainWorld('bridge', {
  embedded: false,
  init: () => ipcRenderer.invoke('init'),
  saveState: (state) => ipcRenderer.send('state', state),
  saveShared: (data) => ipcRenderer.send('shared', data),
  setLive: (v) => ipcRenderer.send('live', v),
  resetTimer: () => ipcRenderer.send('timer-reset'),
  on: (channel, fn) => {
    if (!CHANNELS.includes(channel)) return;
    ipcRenderer.on(channel, (_e, payload) => fn(payload));
  },
});
