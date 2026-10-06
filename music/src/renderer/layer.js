// Calque affiché à l'écran, chargé par le compositeur de SceneCue : plein écran, transparent.
// Dans l'overlay (la vraie sortie), seul le morceau de Spotify s'affiche ; les aperçus montrent un exemple à défaut.
const api = hostBridge();
const view = new Music.View(document.getElementById('host'), { bridge: api });

function hostBridge() {
  try {
    return window.parent !== window && typeof window.parent.sceneCueBridge === 'function'
      ? window.parent.sceneCueBridge(window)
      : null;
  } catch { return null; }
}

const fit = () => view.resize(window.innerWidth, window.innerHeight);
window.addEventListener('resize', fit);
fit();

if (api) {
  api.on('state', (s) => { if (s) view.update(s); });
  api.on('enter', () => view.enter());
  api.on('leave', () => view.leave());
  api.on('show', () => view.show());
  api.init().then((i) => view.setOutput(!!(i && i.output))).catch(() => view.setOutput(false));
}
window.addEventListener('pagehide', () => view.destroy());
