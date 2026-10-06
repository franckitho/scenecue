// Calque affiché à l'écran, chargé par le compositeur de SceneCue : plein écran, transparent.
// Le son ne sort que de la vraie sortie (overlay), jamais des aperçus.
const api = hostBridge();
const player = new Media.Player(document.getElementById('host'));

function hostBridge() {
  try {
    return window.parent !== window && typeof window.parent.sceneCueBridge === 'function'
      ? window.parent.sceneCueBridge(window)
      : null;
  } catch { return null; }
}

const fit = () => player.resize(window.innerWidth, window.innerHeight);
window.addEventListener('resize', fit);
fit();

if (api) {
  api.on('state', (s) => { if (s) player.update(s); });
  api.on('enter', () => player.enter());
  api.on('leave', () => player.leave());
  api.on('show', () => player.show());
  api.init().then((i) => player.setAudio(!!(i && i.output))).catch(() => {});
}
