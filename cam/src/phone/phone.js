'use strict';
/* Régie · Caméra — page ouverte sur le téléphone.
 * Filme et envoie la vidéo (WebRTC) à chaque écran de Régie qui la regarde : la sortie à l'écran
 * en pleine qualité, les aperçus de l'éditeur en petite image. Le serveur de Régie ne sert qu'à se trouver. */
(function () {
  const $ = (s) => document.querySelector(s);
  const _ = I18N.t; // traduction (voir i18n.js et en.js), dans la langue du téléphone
  I18N.apply();
  const preview = $('#preview');
  const go = $('#go');
  const QUALITY = { 720: [1280, 720], 1080: [1920, 1080] };
  const ENCODING = {
    full: { maxBitrate: 8000000, maxFramerate: 30, scaleResolutionDownBy: 1 },
    preview: { maxBitrate: 500000, maxFramerate: 15, scaleResolutionDownBy: 3 },
  };

  let key = new URLSearchParams(location.search).get('k') || '';
  try { if (!key) key = localStorage.getItem('regie-key') || ''; } catch { /* navigation privée */ }
  let id = null;
  let es = null;
  let stream = null;
  let track = null;
  let running = false;
  let busy = false;
  let reconnecting = false;
  let facing = 'user';
  let quality = '1080';
  let wake = null;
  let reportTimer = 0;
  const pcs = new Map(); // écran de Régie -> { pc, sender, quality, active, timer }

  // ---------- interface ----------
  function message(text, info = false) {
    const m = $('#msg');
    m.hidden = !text;
    m.textContent = text || '';
    m.classList.toggle('info', info);
  }

  const connected = () => [...pcs.values()].filter((p) => p.pc.connectionState === 'connected');
  function refresh() {
    const pill = $('#pill');
    const live = connected();
    let text = _('Prêt');
    let cls = '';
    if (running && (!es || es.readyState !== EventSource.OPEN)) { text = _('Connexion…'); cls = 'wait'; }
    else if (running && live.some((p) => p.quality === 'full' && p.active)) { text = _("À l'écran"); cls = 'on'; }
    else if (running && live.length) { text = _('Aperçu dans Régie'); cls = 'wait'; }
    else if (running) { text = _('En attente de Régie'); cls = 'wait'; }
    pill.className = `pill ${cls}`;
    $('#pill-text').textContent = text;
    go.textContent = _(running ? 'Arrêter' : 'Démarrer la caméra');
    go.classList.toggle('stop', running);
    go.disabled = busy;
    $('#ctl').hidden = !running;
    for (const b of $('#facing').children) b.classList.toggle('on', b.dataset.v === facing);
    for (const b of $('#quality').children) b.classList.toggle('on', b.dataset.v === quality);
    const badge = $('#badge');
    badge.hidden = !running || !preview.videoWidth;
    if (!badge.hidden) badge.textContent = `${preview.videoWidth}×${preview.videoHeight}`;
  }

  function cameraError(e) {
    const n = e && e.name;
    if (n === 'NotAllowedError') return _('Accès à la caméra refusé. Réglages › Safari › Caméra › Autoriser, puis recharge la page.');
    if (n === 'NotReadableError') return _('La caméra est déjà utilisée par une autre app (appel, FaceTime…).');
    if (n === 'NotFoundError' || n === 'OverconstrainedError') return _('Aucune caméra trouvée.');
    return (e && e.message) || String(e);
  }

  // ---------- serveur de Régie ----------
  async function api(path, body = {}) {
    const r = await fetch(path, { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, ...body }) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = new Error(data.error ? _(data.error) : _('Régie a répondu {status}', { status: r.status }));
      e.status = r.status;
      throw e;
    }
    return data;
  }

  function info() {
    const s = track ? track.getSettings() : {};
    const live = connected();
    return {
      facing, quality,
      width: preview.videoWidth || s.width || 0,
      height: preview.videoHeight || s.height || 0,
      fps: Math.round(s.frameRate || 0),
      label: track ? track.label : '',
      viewers: live.length,
      onAir: live.some((p) => p.quality === 'full' && p.active),
      device: /iPad/.test(navigator.userAgent) ? 'iPad' : /iPhone/.test(navigator.userAgent) ? 'iPhone' : 'Navigateur',
    };
  }
  function report() {
    clearTimeout(reportTimer);
    reportTimer = setTimeout(() => { if (id && running) api('/api/info', { info: info() }).catch(() => {}); }, 300);
  }

  async function hello() {
    const r = await api('/api/hello', { key, info: info() });
    id = r.id;
    try { localStorage.setItem('regie-key', key); } catch { /* ignore */ }
    return r;
  }

  function listen() {
    if (es) es.close();
    es = new EventSource(`/api/events?id=${encodeURIComponent(id)}`);
    es.onopen = refresh;
    es.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      handle(m);
    };
    es.onerror = () => {
      refresh();
      // session expirée côté Régie (redémarrage, longue coupure) : on se présente à nouveau
      if (es && es.readyState === EventSource.CLOSED && running) { es = null; setTimeout(reconnect, 1500); }
    };
  }

  async function reconnect() {
    if (!running || reconnecting) return;
    reconnecting = true;
    try {
      closeAll();
      const r = await hello();
      if (r.facing !== facing || r.quality !== quality) { facing = r.facing; quality = r.quality; await openCamera(); }
      listen();
      report();
    } catch (e) {
      if (e.status === 403) { await stop(false); askKey(e.message); } else setTimeout(reconnect, 3000);
    } finally {
      reconnecting = false;
      refresh();
    }
  }

  function handle(m) {
    const p = pcs.get(m.viewer);
    switch (m.type) {
      case 'viewer': offer(m.viewer, m); break;
      case 'answer':
        if (p && p.pc.signalingState === 'have-local-offer') p.pc.setRemoteDescription({ type: 'answer', sdp: m.sdp }).catch(() => close(m.viewer));
        break;
      case 'bye': close(m.viewer); break;
      case 'active':
        if (p) { p.active = !!m.active; encode(p); refresh(); report(); }
        break;
      case 'config':
        if (m.facing !== facing || m.quality !== quality) { facing = m.facing; quality = m.quality; switchCamera(false); }
        break;
      case 'kicked':
        stop(false);
        message(_('Un autre appareil a pris le relais. Touche « Démarrer » pour reprendre la main.'), true);
        break;
      default:
    }
  }

  // ---------- caméra ----------
  async function openCamera() {
    if (stream) stream.getTracks().forEach((t) => t.stop()); // iOS : une seule caméra ouverte à la fois
    const [w, h] = QUALITY[quality];
    const s = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: facing }, width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: 30, max: 30 } },
    });
    const t = s.getVideoTracks()[0];
    try { t.contentHint = 'motion'; } catch { /* ignore */ }
    t.addEventListener('ended', () => {
      if (running && track === t) message(_("La caméra s'est arrêtée (appel, autre app…). Reviens sur cette page pour la relancer."));
    });
    stream = s;
    track = t;
    preview.srcObject = s;
    preview.classList.toggle('mirror', facing === 'user');
    preview.play().catch(() => {});
    $('#view-empty').hidden = true;
    for (const p of pcs.values()) if (p.sender) await p.sender.replaceTrack(t).catch(() => {});
    refresh();
  }

  async function switchCamera(fromPhone) {
    const prev = { facing, quality };
    busy = true;
    refresh();
    try {
      await openCamera();
      message('');
    } catch (e) {
      message(cameraError(e));
      if (prev.facing !== facing || prev.quality !== quality) { ({ facing, quality } = prev); await openCamera().catch(() => {}); }
    }
    busy = false;
    if (fromPhone && id) api('/api/config', { facing, quality }).catch(() => {});
    refresh();
    report();
  }

  async function keepAwake() {
    try {
      if ('wakeLock' in navigator && document.visibilityState === 'visible' && !wake) {
        wake = await navigator.wakeLock.request('screen');
        wake.addEventListener('release', () => { wake = null; });
      }
    } catch { /* pas de verrou d'écran : l'utilisateur doit désactiver le verrouillage auto */ }
  }

  // ---------- envoi vers Régie (WebRTC) ----------
  const encoding = (p) => ({ ...ENCODING[p.quality], active: p.active });

  async function encode(p) {
    try {
      const prm = p.sender.getParameters();
      if (!prm.encodings || !prm.encodings.length) prm.encodings = [{}];
      Object.assign(prm.encodings[0], encoding(p));
      await p.sender.setParameters(prm);
    } catch { /* ancien Safari : réglages par défaut */ }
  }

  // H.264 en premier : encodé par la puce de l'iPhone
  function preferH264(tr) {
    try {
      const rank = (c) => (/h264/i.test(c.mimeType) ? 0 : /vp8/i.test(c.mimeType) ? 1 : 2);
      tr.setCodecPreferences([...RTCRtpReceiver.getCapabilities('video').codecs].sort((a, b) => rank(a) - rank(b)));
    } catch { /* ordre par défaut */ }
  }

  function gathered(pc) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(resolve, 2500);
      pc.addEventListener('icegatheringstatechange', () => {
        if (pc.iceGatheringState === 'complete') { clearTimeout(t); resolve(); }
      });
    });
  }

  async function offer(viewer, opts) {
    if (!track) return;
    const q = opts.quality === 'full' ? 'full' : 'preview';
    const active = opts.active !== false;
    const cur = pcs.get(viewer);
    if (cur && cur.quality === q && ['new', 'connecting', 'connected'].includes(cur.pc.connectionState)) {
      if (cur.active !== active) { cur.active = active; encode(cur); }
      return;
    }
    close(viewer);
    const pc = new RTCPeerConnection({ iceServers: [] }); // même réseau local : pas besoin de serveur STUN
    const p = { pc, sender: null, quality: q, active, timer: 0 };
    pcs.set(viewer, p);
    let tr;
    try { tr = pc.addTransceiver(track, { direction: 'sendonly', streams: [stream], sendEncodings: [encoding(p)] }); } catch {
      tr = pc.addTransceiver(track, { direction: 'sendonly', streams: [stream] });
    }
    p.sender = tr.sender;
    preferH264(tr);
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'connected') clearTimeout(p.timer);
      if ((s === 'failed' || s === 'closed') && pcs.get(viewer) === p) close(viewer); // l'écran redemandera la vidéo
      refresh();
      report();
    };
    try {
      await pc.setLocalDescription(await pc.createOffer());
      await gathered(pc);
      if (pcs.get(viewer) !== p) return;
      await encode(p);
      await api('/api/offer', { viewer, sdp: pc.localDescription.sdp });
    } catch {
      close(viewer);
      return;
    }
    // jamais de réponse : la page de Régie a été fermée entre-temps
    p.timer = setTimeout(() => {
      if (pcs.get(viewer) === p && pc.connectionState !== 'connected') {
        close(viewer);
        api('/api/gone', { viewer }).catch(() => {});
      }
    }, 15000);
  }

  function close(viewer) {
    const p = pcs.get(viewer);
    if (!p) return;
    pcs.delete(viewer);
    clearTimeout(p.timer);
    try { p.pc.close(); } catch { /* ignore */ }
    refresh();
  }
  function closeAll() { for (const v of [...pcs.keys()]) close(v); }

  // ---------- démarrer / arrêter ----------
  function askKey(text) {
    key = '';
    $('#key-row').hidden = false;
    message(text || _('Entre le code affiché dans Régie, ou scanne son QR code.'));
  }

  async function start() {
    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      message(_("Safari bloque la caméra sur cette page : ouvre l'adresse en https:// (scanne le QR code affiché dans Régie)."));
      return;
    }
    if (!key) {
      key = $('#key').value.trim();
      if (!key) { askKey(); return; }
    }
    busy = true;
    message('');
    refresh();
    try {
      const r = await hello(); // réglages choisis dans Régie (caméra avant / arrière, qualité)
      facing = r.facing;
      quality = r.quality;
      await openCamera();
      running = true;
      $('#key-row').hidden = true;
      listen();
      keepAwake();
      report();
    } catch (e) {
      if (e.status === 403) askKey(e.message);
      else if (e.status) message(e.message);
      else if (e instanceof DOMException) message(cameraError(e)); // refus ou erreur de getUserMedia
      else message(_('Régie ne répond pas ({error}). Vérifie que Régie est ouverte et que le téléphone est sur le même Wi-Fi.', { error: e.message }));
      if (id) api('/api/bye').catch(() => {});
      id = null;
    }
    busy = false;
    refresh();
  }

  async function stop(sayBye = true) {
    running = false;
    if (es) es.close();
    es = null;
    closeAll();
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    track = null;
    preview.srcObject = null;
    $('#view-empty').hidden = false;
    if (sayBye && id) await api('/api/bye').catch(() => {});
    id = null;
    if (wake) wake.release().catch(() => {});
    refresh();
  }

  go.addEventListener('click', () => (running ? stop() : start()));
  $('#facing').addEventListener('click', (e) => {
    const v = e.target.dataset.v;
    if (v && v !== facing && !busy) { facing = v; switchCamera(true); }
  });
  $('#quality').addEventListener('click', (e) => {
    const v = e.target.dataset.v;
    if (v && v !== quality && !busy) { quality = v; switchCamera(true); }
  });
  $('#key').value = key;
  $('#key').addEventListener('keydown', (e) => { if (e.key === 'Enter') start(); });
  preview.addEventListener('resize', () => { refresh(); report(); });

  // retour sur la page : iOS a pu couper la caméra ou la connexion
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible' || !running) return;
    keepAwake();
    if (!track || track.readyState === 'ended') { try { await openCamera(); message(''); } catch (e) { message(cameraError(e)); } }
    if (!es) reconnect();
  });
  window.addEventListener('pagehide', () => { if (id) navigator.sendBeacon('/api/bye', JSON.stringify({ id })); });

  if (!key) askKey();
  refresh();
})();
