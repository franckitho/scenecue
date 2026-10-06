/* Caméra — rendu partagé entre l'aperçu de l'éditeur et le calque à l'écran.
 * Canevas logique de 1920 px de large (hauteur = ratio de l'écran), mis à l'échelle, comme les autres modules.
 * Deux sources :
 *  - device : une caméra branchée au PC (webcam, carte d'acquisition, caméra virtuelle) via getUserMedia ;
 *  - phone  : l'iPhone, qui envoie sa caméra en WebRTC. Le backend du module (backend.js) ne fait que
 *             relayer l'offre et la réponse ; la vidéo va directement du téléphone à cette page. */
(function () {
  'use strict';

  const CANVAS_W = 1920;
  const ENTER_MS = 1000;
  const LEAVE_MS = 380;
  const RES = { 720: [1280, 720], 1080: [1920, 1080], 2160: [3840, 2160] };
  // messages traduits dans l'éditeur (le calque à l'écran n'affiche aucun texte)
  const _ = (s, v) => (window.I18N ? window.I18N.t(s, v) : s);
  const ASPECTS = { '16x9': 16 / 9, '4x3': 4 / 3, '1x1': 1, '9x16': 9 / 16 };

  const DEFAULT_STATE = {
    source: 'phone', // phone | device
    device: '', // deviceId de la caméra locale ('' = la première)
    deviceLabel: '',
    res: '1080', // caméra locale : 720 | 1080 | 2160
    fps: 30, // 30 | 60
    fit: 'free', // free | contain | cover
    x: 0.84, y: 0.78,
    size: 0.24, // largeur, en fraction de l'écran
    rotate: 0,
    opacity: 1,
    aspect: 'source', // source | 16x9 | 4x3 | 1x1 | 9x16
    shape: 'round', // rect | round | circle
    radius: 10, // forme arrondie : % du petit côté
    zoom: 1,
    panX: 0, panY: 0, // recadrage, de -1 à 1
    mirror: false,
    border: false,
    borderWidth: 6,
    borderColor: '#FFFFFF',
    shadow: true,
    entrance: 'pop',
  };

  // ---------- utilitaires ----------
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  function merge(base, over) {
    const out = { ...base };
    if (!isObj(over)) return out;
    for (const k of Object.keys(over)) out[k] = isObj(base[k]) && isObj(over[k]) ? merge(base[k], over[k]) : over[k];
    return out;
  }
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };

  function gathered(pc) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(resolve, 2500);
      pc.addEventListener('icegatheringstatechange', () => {
        if (pc.iceGatheringState === 'complete') { clearTimeout(t); resolve(); }
      });
    });
  }

  // ---------- caméras branchées au PC ----------
  async function listDevices() {
    const md = navigator.mediaDevices;
    let list = (await md.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    if (list.length && !list[0].label) { // noms masqués tant que la caméra n'a jamais été ouverte
      try {
        const s = await md.getUserMedia({ video: true });
        s.getTracks().forEach((t) => t.stop());
        list = (await md.enumerateDevices()).filter((d) => d.kind === 'videoinput');
      } catch { /* on garde la liste sans noms */ }
    }
    return list.map((d, i) => ({ id: d.deviceId, label: d.label || _('Caméra {n}', { n: i + 1 }) }));
  }

  function openDevice(s) {
    const [w, h] = RES[s.res] || RES[1080];
    return navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { ...(s.device ? { deviceId: { exact: s.device } } : {}), width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: +s.fps || 30 } },
    });
  }

  function deviceError(e) {
    const n = e && e.name;
    if (n === 'NotReadableError' || n === 'TrackStartError') return _('Caméra déjà utilisée par une autre application (Discord, OBS, Teams…). Ferme-la puis clique « Réessayer ».');
    if (n === 'OverconstrainedError' || n === 'NotFoundError') return _('Caméra introuvable : rebranche-la ou choisis-en une autre.');
    if (n === 'NotAllowedError') return _('Windows bloque la caméra : Paramètres › Confidentialité › Caméra › autoriser les applications de bureau.');
    return (e && e.message) || String(e);
  }

  // ---------- réception de la caméra du téléphone ----------
  class PhoneLink {
    constructor(bridge, quality, onStream, onState) {
      this.bridge = bridge;
      this.quality = quality;
      this.active = true;
      this.onStream = onStream;
      this.onState = onState;
      this.id = `v${Math.random().toString(36).slice(2, 10)}`;
      this.pc = null;
      this.closed = false;
      this.join();
      // tant que rien n'arrive, on se rappelle au téléphone (il a pu redémarrer, ou une réponse s'est perdue)
      this.beat = setInterval(() => { if (!this.connected()) this.join(); }, 8000);
    }

    connected() { return !!this.pc && this.pc.connectionState === 'connected'; }
    join() { this.bridge.call('join', this.id, { quality: this.quality, active: this.active }).catch(() => {}); }

    async offer(sdp) {
      if (this.closed) return;
      if (this.pc) this.pc.close();
      const pc = new RTCPeerConnection({ iceServers: [] });
      this.pc = pc;
      pc.ontrack = (e) => {
        try { e.receiver.jitterBufferTarget = 0; } catch { /* ignore */ }
        try { e.receiver.playoutDelayHint = 0; } catch { /* ignore */ }
        this.onStream(e.streams[0] || new MediaStream([e.track]));
      };
      pc.onconnectionstatechange = () => { if (this.pc === pc) this.onState(pc.connectionState); };
      try {
        await pc.setRemoteDescription({ type: 'offer', sdp });
        await pc.setLocalDescription(await pc.createAnswer());
        await gathered(pc);
        if (this.pc === pc && !this.closed) await this.bridge.call('answer', this.id, pc.localDescription.sdp);
      } catch (e) {
        console.error('caméra du téléphone :', e);
      }
    }

    setActive(active) {
      if (this.active === active) return;
      this.active = active;
      this.bridge.call('setActive', this.id, active).catch(() => {});
    }

    close() {
      this.closed = true;
      clearInterval(this.beat);
      if (this.pc) this.pc.close();
      this.pc = null;
      this.bridge.call('leave', this.id).catch(() => {});
    }
  }

  // ---------- vue ----------
  class View {
    constructor(host, opts = {}) {
      this.bridge = opts.bridge || null;
      this.onInfo = opts.onInfo || null;
      this.output = false; // vraie sortie (overlay) : pleine qualité
      this.outputKnown = opts.output != null;
      if (this.outputKnown) this.output = !!opts.output;
      this.waiters = [];
      this.cw = CANVAS_W;
      this.ch = 1080;
      this.k = 1;
      this.state = merge(DEFAULT_STATE, {});
      this.on = false; // le calque doit être affiché (enter / show reçus)
      this.showing = false;
      this.live = false; // des images arrivent
      this.error = null;
      this.link = null;
      this.devStream = null;
      this.srcKey = null;
      this.seq = 0;

      this.canvas = el('div', 'cm-canvas cm-hidden cm-wait');
      this.box = el('div', 'cm-box');
      this.enterEl = el('div', 'cm-enter');
      this.motion = el('div', 'cm-motion');
      this.frame = el('div', 'cm-frame');
      this.video = el('video', 'cm-video');
      this.video.muted = true;
      this.video.playsInline = true;
      this.video.autoplay = true;
      this.video.disablePictureInPicture = true;
      this.frame.append(this.video);
      this.motion.append(this.frame);
      this.enterEl.append(this.motion);
      this.box.append(this.enterEl);
      this.canvas.append(this.box);
      host.append(this.canvas);

      const check = () => { this.setLive(); this.layout(); this.info(); };
      for (const ev of ['loadeddata', 'playing', 'resize', 'emptied']) this.video.addEventListener(ev, check);
      if (this.bridge) this.bridge.on('offer', (m) => { if (this.link && m && m.viewer === this.link.id) this.link.offer(m.sdp); });
      this.ticker = setInterval(() => this.info(), 1000);
      this.apply();
      this.layout();
    }

    // la page du calque apprend après coup si elle est la sortie ou un aperçu
    setOutput(v) {
      this.output = !!v;
      this.outputKnown = true;
      this.waiters.splice(0).forEach((f) => f());
    }
    whenOutputKnown() { return this.outputKnown ? Promise.resolve() : new Promise((r) => this.waiters.push(r)); }

    destroy() {
      clearInterval(this.ticker);
      clearTimeout(this.visTimer);
      this.disconnect();
      this.canvas.remove();
    }

    resize(w, h) {
      if (!w || !h) return;
      this.k = w / CANVAS_W;
      this.ch = Math.round(h / this.k);
      this.canvas.style.width = `${this.cw}px`;
      this.canvas.style.height = `${this.ch}px`;
      this.canvas.style.transform = `scale(${this.k})`;
      this.layout();
    }

    info() {
      if (!this.onInfo) return;
      const t = this.video.srcObject && this.video.srcObject.getVideoTracks()[0];
      const set = t && t.getSettings ? t.getSettings() : {};
      this.onInfo({
        source: this.state.source,
        live: this.live,
        error: this.error,
        width: this.video.videoWidth,
        height: this.video.videoHeight,
        fps: Math.round(set.frameRate || 0),
        label: this.state.source === 'device' && t ? t.label : '',
        linked: this.link ? (this.link.pc ? this.link.pc.connectionState : 'waiting') : null,
      });
    }

    // ---------- état ----------
    update(state) {
      this.state = merge(DEFAULT_STATE, state || {});
      this.apply();
      this.layout();
      if (this.on) this.connect();
    }

    apply() {
      const s = this.state;
      const cl = this.canvas.classList;
      const keep = ['cm-canvas', 'cm-hidden', 'cm-in', 'cm-out', 'cm-shown', 'cm-wait'].filter((c) => cl.contains(c));
      keep.push(`cm-ent-${s.entrance}`);
      if (s.shadow) keep.push('cm-shadow');
      this.canvas.className = keep.join(' ');
      const st = this.canvas.style;
      st.setProperty('--op', clamp(+s.opacity, 0, 1));
      st.setProperty('--rot', `${+s.rotate || 0}deg`);
      st.setProperty('--bw', s.border ? `${clamp(+s.borderWidth || 0, 0, 60)}px` : '0px');
      st.setProperty('--bc', s.borderColor || '#FFFFFF');
      // recadrage : point visé, zoom autour de ce point, miroir
      const px = 50 + clamp(+s.panX || 0, -1, 1) * 50 * (s.mirror ? -1 : 1);
      const py = 50 + clamp(+s.panY || 0, -1, 1) * 50;
      const z = clamp(+s.zoom || 1, 1, 4);
      const v = this.video.style;
      v.objectPosition = `${px}% ${py}%`;
      v.transformOrigin = `${px}% ${py}%`;
      v.transform = `scale(${s.mirror ? -z : z}, ${z})`;
    }

    layout() {
      const s = this.state;
      const vw = this.video.videoWidth || 16, vh = this.video.videoHeight || 9;
      const ar = s.shape === 'circle' ? 1 : ASPECTS[s.aspect] || vw / vh;
      let w, h, x, y;
      if (s.fit === 'free') {
        w = s.size * this.cw;
        h = w / ar;
        x = s.x * this.cw;
        y = s.y * this.ch;
      } else {
        const k = s.fit === 'cover' ? Math.max(this.cw / ar, this.ch) : Math.min(this.cw / ar, this.ch);
        h = k;
        w = k * ar;
        x = this.cw / 2;
        y = this.ch / 2;
      }
      const b = this.box.style;
      b.left = `${x}px`;
      b.top = `${y}px`;
      b.width = `${w}px`;
      b.height = `${h}px`;
      const r = s.shape === 'circle' ? '50%' : s.shape === 'round' ? `${(Math.min(w, h) * clamp(+s.radius || 0, 0, 50)) / 100}px` : '0px';
      this.canvas.style.setProperty('--radius', r);
      this.canvas.style.setProperty('--slide', `${-Math.round(x + Math.max(w, h) + 60)}px`);
      this.rect = { x, y, w, h };
    }

    setLive() {
      const t = this.video.srcObject && this.video.srcObject.getVideoTracks()[0];
      const linkOk = !this.link || this.link.connected();
      this.live = !!t && t.readyState === 'live' && this.video.videoWidth > 0 && linkOk;
      this.canvas.classList.toggle('cm-wait', !this.live);
    }

    // ---------- source ----------
    sourceKey() {
      const s = this.state;
      return s.source === 'device' ? `device|${s.device}|${s.res}|${s.fps}` : 'phone';
    }

    async connect(force = false) {
      const key = this.sourceKey();
      if (!force && key === this.srcKey) return;
      this.disconnect();
      this.srcKey = key;
      const seq = this.seq;
      this.error = null;
      if (this.state.source === 'phone') {
        if (!this.bridge || !this.bridge.call) { this.error = _('Régie indisponible'); this.info(); return; }
        await this.whenOutputKnown();
        if (seq !== this.seq) return;
        this.link = new PhoneLink(this.bridge, this.output ? 'full' : 'preview', (stream) => this.attach(stream), () => { this.setLive(); this.info(); });
        if (this.output && !this.showing) this.link.setActive(false);
      } else {
        try {
          const stream = await openDevice(this.state);
          if (seq !== this.seq) { stream.getTracks().forEach((t) => t.stop()); return; }
          this.devStream = stream;
          stream.getVideoTracks()[0].addEventListener('ended', () => {
            if (this.devStream !== stream) return;
            this.error = _("La caméra s'est arrêtée (débranchée ?).");
            this.setLive();
            this.info();
          });
          this.attach(stream);
        } catch (e) {
          if (seq !== this.seq) return;
          this.error = deviceError(e);
          this.setLive();
          this.info();
        }
      }
      this.info();
    }

    disconnect() {
      this.seq++;
      if (this.link) { this.link.close(); this.link = null; }
      if (this.devStream) { this.devStream.getTracks().forEach((t) => t.stop()); this.devStream = null; }
      this.video.srcObject = null;
      this.srcKey = null;
      this.setLive();
    }

    retry() { this.connect(true); }

    attach(stream) {
      if (this.video.srcObject !== stream) this.video.srcObject = stream;
      this.video.play().catch(() => {});
      this.error = null;
      for (const t of stream.getVideoTracks()) {
        t.onmute = t.onunmute = () => { this.setLive(); this.info(); };
      }
      this.setLive();
      this.info();
    }

    // ---------- apparition ----------
    enter() { this.on = true; this.reveal(true); }
    show() { this.on = true; this.reveal(false); }
    replay() { this.reveal(true); }

    leave() {
      this.on = false;
      if (!this.showing) return;
      this.showing = false;
      clearTimeout(this.visTimer);
      this.setVis('cm-out');
      this.visTimer = setTimeout(() => {
        this.setVis('cm-hidden');
        // hors antenne : le téléphone cesse d'encoder pour la sortie, la caméra du PC est libérée
        if (this.link) this.link.setActive(false);
        if (this.devStream) this.disconnect();
      }, LEAVE_MS);
    }

    reveal(animate) {
      clearTimeout(this.visTimer);
      this.showing = true;
      if (animate && this.state.entrance !== 'none') {
        this.setVis('cm-in');
        this.visTimer = setTimeout(() => this.setVis('cm-shown'), ENTER_MS);
      } else {
        this.setVis('cm-shown');
      }
      if (this.link) this.link.setActive(true);
      this.connect();
    }

    setVis(c) {
      const cl = this.canvas.classList;
      cl.remove('cm-hidden', 'cm-in', 'cm-out', 'cm-shown');
      if (c === 'cm-in') void this.canvas.offsetWidth; // relance l'animation d'entrée
      cl.add(c);
    }
  }

  window.Cam = { View, DEFAULT_STATE, CANVAS_W, merge, clone, clamp, listDevices };
})();
