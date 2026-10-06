// Calque affiché à l'écran, chargé par le compositeur de Régie : plein écran, transparent.
// Dans l'overlay (la vraie sortie) la caméra du téléphone arrive en pleine qualité, dans les aperçus en petite image.
const api = hostBridge();
const view = new Cam.View(document.getElementById('host'), { bridge: api });

function hostBridge() {
  try {
    return window.parent !== window && typeof window.parent.regieBridge === 'function'
      ? window.parent.regieBridge(window)
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
