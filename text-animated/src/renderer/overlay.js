// Calque affiché à l'écran : plein écran, transparent. En solo il vit dans sa propre fenêtre,
// dans Régie il est chargé dans le compositeur de la scène.
const api = window.bridge || hostBridge();
const r = new Pancarte.Renderer(document.getElementById('host'));

function hostBridge() {
  try {
    return window.parent !== window && typeof window.parent.regieBridge === 'function'
      ? window.parent.regieBridge(window)
      : null;
  } catch { return null; }
}

function fit() {
  const w = window.innerWidth, h = window.innerHeight;
  if (!w || !h) return;
  const k = w / Pancarte.CANVAS_W;
  r.setSize(Pancarte.CANVAS_W, Math.round(h / k));
  r.canvas.style.transform = `scale(${k})`;
}
window.addEventListener('resize', fit);
fit();

if (api) {
  api.on('state', (s) => { if (s) r.update(s); });
  api.on('live', ({ since }) => r.setSince(since));
  api.on('enter', () => r.enter());
  api.on('leave', () => r.leave());
  api.on('show', () => r.show());
}
