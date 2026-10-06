/* Régie — compositeur de scène.
 * Empile les calques (une iframe par instance de module) et leur fournit leur bridge.
 *  - mode=overlay : la fenêtre plein écran transparente, pilotée par le processus principal.
 *  - sinon : aperçu intégré (vignette, arrière-plan d'un éditeur), alimenté par la fenêtre Régie
 *    via window.top.regieFeed. Paramètres : scene=<id>|@selected, ref=<calque>, only=below|above.
 */
(function () {
  'use strict';

  const params = new URLSearchParams(location.search);
  const isOverlay = params.get('mode') === 'overlay' && !!window.host;
  const LEAVE_MS = 450;

  let modules = new Map();
  let shown = !isOverlay; // les aperçus sont toujours visibles, sans animation d'entrée
  let liveInfo = { live: false, since: null };
  const items = new Map(); // id du calque -> instance

  // appelé par les pages des calques (même origine) pour obtenir leur bridge
  window.regieBridge = (win) => {
    for (const L of items.values()) if (L.iframe.contentWindow === win) return L.bridge;
    return null;
  };

  const topFeed = () => { try { return window.top !== window ? window.top.regieFeed : null; } catch { return null; } };

  // backend d'un module : directement dans l'overlay, via la fenêtre Régie dans les aperçus
  function callModule(module, method, args) {
    if (isOverlay) return host.callModule(module, method, args);
    const feed = topFeed();
    return feed ? feed.call(module, method, args) : Promise.reject(new Error('Régie indisponible'));
  }

  function emit(L, channel, payload) {
    for (const fn of L.listeners[channel] || []) {
      try { fn(payload); } catch (e) { console.error(e); }
    }
  }

  function makeLayer(layer) {
    const mod = modules.get(layer.module);
    if (!mod) return null;
    const iframe = document.createElement('iframe');
    iframe.className = 'layer';
    iframe.tabIndex = -1;
    const L = { id: layer.id, module: layer.module, iframe, listeners: {}, loaded: false, state: layer.state, json: JSON.stringify(layer.state) };
    L.bridge = {
      embedded: true,
      // output : true dans l'overlay (la vraie sortie), false dans les aperçus. Seule la sortie joue le son.
      init: async () => ({ state: L.state, live: liveInfo.live, since: liveInfo.since, embedded: true, output: isOverlay }),
      on: (ch, fn) => { (L.listeners[ch] = L.listeners[ch] || []).push(fn); },
      call: (method, ...args) => callModule(layer.module, method, args),
      saveState() {}, saveShared() {}, setLive() {}, resetTimer() {},
    };
    iframe.addEventListener('load', () => {
      L.loaded = true;
      if (L.state) emit(L, 'state', L.state);
      emit(L, 'live', liveInfo);
      if (shown) emit(L, isOverlay ? 'enter' : 'show');
    });
    iframe.src = `${mod.layerUrl}?lang=${params.get('lang') === 'en' ? 'en' : 'fr'}`;
    return L;
  }

  function dropLayer(L, animate) {
    if (animate && L.loaded && shown) {
      emit(L, 'leave');
      setTimeout(() => L.iframe.remove(), LEAVE_MS);
    } else {
      L.iframe.remove();
    }
  }

  // layers : liste du bas vers le haut
  function setLayers(layers) {
    const wanted = (layers || []).filter((l) => l.visible !== false && modules.has(l.module));
    const ids = new Set(wanted.map((l) => l.id));
    for (const [id, L] of items) {
      if (!ids.has(id)) { dropLayer(L, isOverlay); items.delete(id); }
    }
    wanted.forEach((l, z) => {
      let L = items.get(l.id);
      if (!L) {
        L = makeLayer(l);
        if (!L) return;
        items.set(l.id, L);
        document.body.append(L.iframe);
      } else {
        const json = JSON.stringify(l.state);
        if (json !== L.json) {
          L.state = l.state;
          L.json = json;
          if (L.loaded && l.state) emit(L, 'state', l.state);
        }
      }
      L.iframe.style.zIndex = String(z + 1);
    });
  }

  function setLayerState(id, state) {
    const L = items.get(id);
    if (!L) return;
    L.state = state;
    L.json = JSON.stringify(state);
    if (L.loaded && state) emit(L, 'state', state);
  }

  function setModules(list) { modules = new Map((list || []).map((m) => [m.id, m])); }
  function setLive(info) { liveInfo = info; for (const L of items.values()) if (L.loaded) emit(L, 'live', info); }
  function enter() { shown = true; for (const L of items.values()) if (L.loaded) emit(L, 'enter'); }
  function leave() { shown = false; for (const L of items.values()) if (L.loaded) emit(L, 'leave'); }
  function moduleEvent(module, channel, payload) {
    for (const L of items.values()) if (L.loaded && L.module === module) emit(L, channel, payload);
  }

  const api = { setModules, setLayers, setLayerState, setLive, enter, leave, moduleEvent, params };
  window.compositor = api;

  if (isOverlay) {
    host.on('modules', setModules);
    host.on('scene', (scene) => setLayers(scene ? scene.layers : []));
    host.on('layer-state', ({ layer, state }) => setLayerState(layer, state));
    host.on('live', setLive);
    host.on('enter', enter);
    host.on('leave', leave);
    host.on('module-event', (e) => moduleEvent(e.module, e.channel, e.payload));
  } else {
    const feed = topFeed();
    if (feed) {
      feed.attach(api);
      window.addEventListener('pagehide', () => feed.detach(api));
    }
  }
})();
