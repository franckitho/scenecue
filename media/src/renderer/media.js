/* Média — moteur de lecture partagé entre l'aperçu de l'éditeur et le calque à l'écran.
 * Le média est posé sur un canevas logique de 1920 px de large (hauteur = ratio de l'écran), mis à l'échelle.
 * Trois sources :
 *  - image fixe : <img> ;
 *  - image animée (GIF, WebP, APNG) : décodée image par image (ImageDecoder), jouée sur un <canvas> ;
 *  - vidéo : <video>. En boomerang, les images sont mémorisées pendant le premier passage puis rejouées
 *    à l'envers et à l'endroit sur le <canvas> (Chromium ne sait pas lire une vidéo à l'envers). */
(function () {
  'use strict';

  const CANVAS_W = 1920;
  const CACHE_BYTES = 384 * 1024 * 1024; // mémoire max des images gardées par un lecteur
  const ENTER_MS = 1000;
  const LEAVE_MS = 380;
  const GUESS_FPS = 30;

  const DEFAULT_STATE = {
    media: null, // { id, file, url, name, kind: 'image' | 'video', size }
    mode: 'loop', // once | loop | bounce
    speed: 1,
    repeat: 0, // nombre de passages en boucle / boomerang, 0 = sans fin
    gap: 0, // pause entre deux passages (s)
    end: 'hold', // à la fin : hold (figer) | hide (disparaître)
    trimA: 0, // découpe (s)
    trimB: null, // null = jusqu'au bout
    hold: 0, // image fixe : durée d'affichage (s), 0 = toujours
    sound: false,
    volume: 0.8,
    fit: 'free', // free | contain | cover
    x: 0.5, y: 0.5,
    size: 0.42, // largeur, en fraction de l'écran
    rotate: 0,
    flip: false,
    opacity: 1,
    radius: 0, // % du petit côté
    shadow: false,
    entrance: 'pop',
    motion: 'none',
  };

  const ANIM_TYPES = { gif: 'image/gif', webp: 'image/webp', png: 'image/png', apng: 'image/png', avif: 'image/avif' };
  const VIDEO_EXT = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv', 'ogv']);
  // messages d'erreur traduits dans l'éditeur (le calque à l'écran n'affiche aucun texte)
  const _ = (s) => (window.I18N ? window.I18N.t(s) : s);

  // ---------- utilitaires ----------
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  function merge(base, over) {
    const out = Array.isArray(base) ? base.slice() : { ...base };
    if (!isObj(over)) return out;
    for (const k of Object.keys(over)) {
      out[k] = isObj(base[k]) && isObj(over[k]) ? merge(base[k], over[k]) : over[k];
    }
    return out;
  }
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };
  const extOf = (s) => ((String(s || '').split(/[?#]/)[0].match(/\.([a-z0-9]+)$/i) || [])[1] || '').toLowerCase();
  const kindOf = (media) => media.kind || (VIDEO_EXT.has(extOf(media.file || media.name || media.url)) ? 'video' : 'image');

  function fmtTime(sec, dec = 1) {
    if (!Number.isFinite(sec)) return '–';
    sec = Math.max(0, sec);
    const m = Math.floor(sec / 60);
    const s = (sec - m * 60).toFixed(dec).padStart(dec ? dec + 3 : 2, '0');
    return `${m}:${s}`;
  }

  // ---------- ouverture des sources ----------
  // Les WebM enregistrés par certains logiciels n'annoncent pas leur durée : on la force en allant à la fin.
  function fixDuration(v) {
    if (Number.isFinite(v.duration)) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        v.removeEventListener('durationchange', check);
        v.currentTime = 0;
        resolve();
      };
      const check = () => { if (Number.isFinite(v.duration)) done(); };
      const timer = setTimeout(done, 4000);
      v.addEventListener('durationchange', check);
      v.currentTime = 1e7;
    });
  }

  function openVideo(url) {
    return new Promise((resolve, reject) => {
      const v = el('video', 'md-media');
      v.muted = true;
      v.playsInline = true;
      v.preload = 'auto';
      v.disablePictureInPicture = true;
      const cleanup = () => { v.removeEventListener('loadeddata', ok); v.removeEventListener('error', fail); };
      const fail = () => { cleanup(); reject(new Error(_('Vidéo illisible : format ou codec non pris en charge'))); };
      const ok = async () => {
        cleanup();
        if (!v.videoWidth) { reject(new Error(_("Ce fichier ne contient pas d'image"))); return; }
        await fixDuration(v);
        resolve({ kind: 'video', el: v, w: v.videoWidth, h: v.videoHeight, duration: v.duration });
      };
      v.addEventListener('loadeddata', ok);
      v.addEventListener('error', fail);
      v.src = url;
    });
  }

  async function openImage(url, ext) {
    const type = ANIM_TYPES[ext];
    if (type && typeof ImageDecoder === 'function') {
      try {
        if (await ImageDecoder.isTypeSupported(type)) {
          const data = await (await fetch(url)).arrayBuffer();
          const dec = new ImageDecoder({ data, type });
          await dec.tracks.ready;
          const tr = dec.tracks.selectedTrack;
          if (tr && tr.animated) await dec.completed;
          if (tr && tr.animated && tr.frameCount > 1) return { kind: 'anim', dec, count: tr.frameCount, w: 0, h: 0, duration: 0, frames: [] };
          dec.close();
        }
      } catch { /* image fixe ou décodeur indisponible : affichage classique */ }
    }
    const img = new Image();
    img.className = 'md-media';
    img.decoding = 'async';
    img.draggable = false;
    img.src = url;
    try { await img.decode(); } catch { throw new Error(_('Image illisible : format non pris en charge')); }
    return { kind: 'image', el: img, w: img.naturalWidth || 512, h: img.naturalHeight || 512 };
  }

  function closeSrc(src) {
    if (!src) return;
    if (src.kind === 'video') {
      src.el.pause();
      src.el.removeAttribute('src');
      src.el.load();
    }
    if (src.frames) for (const f of src.frames) f.bmp.close();
    if (src.dec) src.dec.close();
  }

  // ---------- Player ----------
  class Player {
    constructor(host, opts = {}) {
      this.opts = opts; // { audio: bool, onInfo: fn }
      this.audio = !!opts.audio;
      this.cw = CANVAS_W;
      this.ch = 1080;
      this.k = 1;
      this.state = merge(DEFAULT_STATE, {});
      this.src = null;
      this.srcUrl = null;
      this.loadSeq = 0;
      this.loading = false;
      this.error = null;
      this.on = false; // le calque doit être affiché (enter / show reçus, pas de leave)
      this.showing = false; // visible ou en train d'apparaître
      this.active = false; // boucle d'animation en marche
      this.phase = 'off'; // off | play | gap | done | scrub
      this.engine = null; // video | cache | still
      this.frames = []; // images mémorisées d'une vidéo (boomerang)
      this.framesKey = null;
      this.fade = 0; // volume de sortie (fondu à la disparition)
      this.raf = 0;
      this.view = null;

      this.canvas = el('div', 'md-canvas md-hidden');
      this.box = el('div', 'md-box');
      this.enterEl = el('div', 'md-enter');
      this.motion = el('div', 'md-motion');
      this.frame = el('div', 'md-frame');
      this.motion.append(this.frame);
      this.enterEl.append(this.motion);
      this.box.append(this.enterEl);
      this.canvas.append(this.box);
      host.append(this.canvas);

      this.cv = el('canvas', 'md-media');
      this.ctx = this.cv.getContext('2d');
      this.tick = this.tick.bind(this);
      this.onFrame = this.onFrame.bind(this);
      this.apply();
      this.layout();
    }

    destroy() {
      this.halt();
      clearTimeout(this.visTimer);
      this.clearFrames();
      closeSrc(this.src);
      this.src = null;
      this.canvas.remove();
    }

    // taille réelle (px CSS) de la zone où le calque est affiché
    resize(w, h) {
      if (!w || !h) return;
      this.k = w / CANVAS_W;
      this.ch = Math.round(h / this.k);
      this.canvas.style.width = `${this.cw}px`;
      this.canvas.style.height = `${this.ch}px`;
      this.canvas.style.transform = `scale(${this.k})`;
      this.layout();
    }

    setAudio(v) { this.audio = !!v; this.applyAudio(); }

    info() {
      if (!this.opts.onInfo) return;
      const s = this.src;
      this.opts.onInfo({
        loading: this.loading,
        error: this.error,
        kind: s ? s.kind : null,
        w: s ? s.w : 0,
        h: s ? s.h : 0,
        duration: s && s.kind !== 'image' && Number.isFinite(s.duration) ? s.duration : 0,
        frames: s && s.kind === 'anim' ? s.count : 0,
      });
    }

    // ---------- état ----------
    update(state) {
      const s = merge(DEFAULT_STATE, state || {});
      this.state = s;
      const url = (s.media && s.media.url) || null;
      const key = JSON.stringify([s.mode, s.repeat, s.gap, s.end, s.trimA, s.trimB, s.hold]);
      this.apply();
      if (url !== this.srcUrl) {
        this.srcUrl = url;
        this.playKey = key;
        this.load(s.media);
        return;
      }
      this.layout();
      if (key !== this.playKey) {
        this.playKey = key;
        if (this.scrubbing || !this.on) return;
        if (this.showing) this.restart(); else this.reveal(false);
      }
    }

    apply() {
      const s = this.state;
      const cl = this.canvas.classList;
      const cls = ['md-canvas', 'md-hidden', 'md-in', 'md-out', 'md-shown'].filter((c) => cl.contains(c));
      cls.push(`md-ent-${s.entrance}`, `md-mo-${s.motion}`);
      if (s.shadow) cls.push('md-shadow');
      if (s.flip) cls.push('md-flip');
      this.canvas.className = cls.join(' ');
      this.canvas.style.setProperty('--op', clamp(+s.opacity, 0, 1));
      this.canvas.style.setProperty('--rot', `${+s.rotate || 0}deg`);
      if (this.src && this.src.kind === 'video' && this.engine === 'video') this.src.el.playbackRate = clamp(+s.speed || 1, 0.0625, 16);
      this.applyAudio();
    }

    applyAudio() {
      const src = this.src;
      if (!src || src.kind !== 'video') return;
      const s = this.state;
      src.el.muted = !(this.audio && s.sound && s.mode !== 'bounce' && this.engine === 'video');
      src.el.volume = clamp(s.volume * this.fade, 0, 1);
    }

    layout() {
      const s = this.state;
      const src = this.src;
      const w0 = src && src.w ? src.w : 16, h0 = src && src.h ? src.h : 9;
      let w, h, x, y;
      if (s.fit === 'free' || !src) {
        w = s.size * this.cw;
        h = (w * h0) / w0;
        x = s.x * this.cw;
        y = s.y * this.ch;
      } else {
        const k = s.fit === 'cover' ? Math.max(this.cw / w0, this.ch / h0) : Math.min(this.cw / w0, this.ch / h0);
        w = w0 * k;
        h = h0 * k;
        x = this.cw / 2;
        y = this.ch / 2;
      }
      const b = this.box.style;
      b.left = `${x}px`;
      b.top = `${y}px`;
      b.width = `${w}px`;
      b.height = `${h}px`;
      this.canvas.style.setProperty('--radius', `${(Math.min(w, h) * clamp(+s.radius || 0, 0, 50)) / 100}px`);
      this.canvas.style.setProperty('--slide', `${-Math.round(x + Math.max(w, h) + 60)}px`);
      this.rect = { x, y, w, h };
    }

    // ---------- chargement ----------
    async load(media) {
      const seq = ++this.loadSeq;
      this.stopCapture();
      this.clearFrames();
      closeSrc(this.src);
      this.src = null;
      this.engine = null;
      this.phase = 'off';
      this.setView(null);
      this.error = null;
      this.loading = !!(media && media.url);
      this.layout();
      this.info();
      if (!this.loading) return;

      let src = null;
      try {
        src = kindOf(media) === 'video' ? await openVideo(media.url) : await openImage(media.url, extOf(media.file || media.name || media.url));
        if (src.kind === 'anim' && seq === this.loadSeq) await this.decodeAnim(src, seq);
      } catch (e) {
        closeSrc(src);
        if (seq !== this.loadSeq) return;
        this.loading = false;
        this.error = (e && e.message) || _('Lecture impossible');
        this.info();
        return;
      }
      if (seq !== this.loadSeq) { closeSrc(src); return; }
      this.src = src;
      this.loading = false;
      if (src.kind === 'video') {
        // la fin d'un passage est aussi détectée sans requestAnimationFrame (fenêtre masquée, jeu devant…)
        const watch = () => { if (this.src === src) this.checkVideo(); };
        src.el.addEventListener('timeupdate', watch);
        src.el.addEventListener('ended', watch);
      }
      this.layout();
      this.apply();
      this.info();
      if (this.showing) this.restart();
    }

    // échelle des images mémorisées : jamais plus que l'écran affiché ni que la mémoire allouée
    capScale(w, h, count) {
      const dpr = window.devicePixelRatio || 1;
      const vw = this.cw * this.k * dpr, vh = this.ch * this.k * dpr;
      let s = Math.min(1, Math.max(vw / w, vh / h));
      const bytes = w * h * s * s * 4 * count;
      if (bytes > CACHE_BYTES) s *= Math.sqrt(CACHE_BYTES / bytes);
      return Math.max(s, Math.min(1, 160 / Math.max(w, h)));
    }

    async decodeAnim(src, seq) {
      const dec = src.dec;
      const first = (await dec.decode({ frameIndex: 0 })).image;
      src.w = first.displayWidth;
      src.h = first.displayHeight;
      first.close();
      const s = this.capScale(src.w, src.h, src.count);
      const W = Math.max(1, Math.round(src.w * s)), H = Math.max(1, Math.round(src.h * s));
      const step = Math.max(1, Math.ceil((src.count * W * H * 4) / CACHE_BYTES));
      let t = 0;
      for (let i = 0; i < src.count; i++) {
        const { image } = await dec.decode({ frameIndex: i });
        let d = (image.duration || 0) / 1e6;
        if (d < 0.011) d = 0.1; // comme les navigateurs pour les GIF sans délai
        if (i % step === 0) {
          try { src.frames.push({ t, bmp: await createImageBitmap(image, { resizeWidth: W, resizeHeight: H, resizeQuality: 'medium' }) }); } finally { image.close(); }
        } else image.close();
        t += d;
        if (seq !== this.loadSeq) throw new Error('annulé');
      }
      src.duration = t;
      dec.close();
      src.dec = null;
    }

    setView(node) {
      if (this.view === node) return;
      this.view = node;
      if (node) this.frame.replaceChildren(node); else this.frame.replaceChildren();
    }

    // ---------- apparition ----------
    enter() { this.on = true; this.reveal(true); }
    show() { this.on = true; this.reveal(false); }
    leave() { this.on = false; this.hide(); }
    replay() { this.on = true; this.reveal(true); }

    reveal(animate) {
      clearTimeout(this.visTimer);
      this.showing = true;
      this.fade = 1;
      if (animate && this.state.entrance !== 'none') {
        this.setVis('md-in');
        this.visTimer = setTimeout(() => this.setVis('md-shown'), ENTER_MS);
      } else {
        this.setVis('md-shown');
      }
      this.restart();
    }

    hide() {
      if (!this.showing) return;
      this.showing = false;
      clearTimeout(this.visTimer);
      this.setVis('md-out');
      this.visTimer = setTimeout(() => { this.setVis('md-hidden'); this.halt(); }, LEAVE_MS);
    }

    setVis(c) {
      const cl = this.canvas.classList;
      cl.remove('md-hidden', 'md-in', 'md-out', 'md-shown');
      if (c === 'md-in') void this.canvas.offsetWidth; // relance l'animation d'entrée
      cl.add(c);
    }

    // ---------- lecture ----------
    range() {
      const src = this.src;
      const d = src && Number.isFinite(src.duration) && src.duration > 0 ? src.duration : Infinity;
      const s = this.state;
      let a = clamp(+s.trimA || 0, 0, Number.isFinite(d) ? d : 1e9);
      let b = s.trimB == null || !Number.isFinite(d) ? d : clamp(+s.trimB, 0, d);
      if (b - a < 0.05) { a = 0; b = d; }
      return [a, b];
    }
    rangeKey() { const [a, b] = this.range(); return `${a}|${b}`; }

    nativeLoop() {
      const s = this.state;
      const [a, b] = this.range();
      return s.mode === 'loop' && !s.repeat && !s.gap && a === 0 && b === this.src.duration;
    }

    restart() {
      this.passes = 0;
      this.phase = 'off';
      clearTimeout(this.timer);
      if (!this.src || !this.showing) return;
      this.active = true;
      this.startPass();
      if (!this.raf) {
        this.last = performance.now();
        this.raf = requestAnimationFrame(this.tick);
      }
    }

    startPass() {
      const src = this.src;
      const s = this.state;
      this.phase = 'play';
      this.dir = 1;
      this.drawn = -1;
      clearTimeout(this.timer);
      if (src.kind === 'image') {
        this.engine = 'still';
        this.setView(src.el);
        if (s.hold > 0) this.timer = setTimeout(() => this.finish(), s.hold * 1000);
        return;
      }
      const [a] = this.range();
      if (src.kind === 'anim' || (s.mode === 'bounce' && this.framesKey === this.rangeKey())) {
        if (src.kind === 'video') src.el.pause();
        this.engine = 'cache';
        this.pos = a;
        this.fi = 0;
        this.setView(this.cv);
        this.drawAt(a);
        this.applyAudio();
        return;
      }
      const v = src.el;
      this.engine = 'video';
      this.setView(v);
      v.loop = this.nativeLoop();
      v.playbackRate = clamp(+s.speed || 1, 0.0625, 16);
      if (s.mode === 'bounce') this.startCapture(); else this.stopCapture();
      if (v.ended || Math.abs(v.currentTime - a) > 0.01) v.currentTime = a;
      this.applyAudio();
      const p = v.play();
      if (p) p.catch(() => {});
    }

    endPass() {
      this.passes++;
      const s = this.state;
      const limit = s.mode === 'once' ? 1 : s.repeat;
      if (limit > 0 && this.passes >= limit) { this.finish(); return; }
      if (s.gap > 0) {
        this.phase = 'gap';
        if (this.engine === 'video') this.src.el.pause();
        this.timer = setTimeout(() => { if (this.phase === 'gap') this.startPass(); }, s.gap * 1000);
        return;
      }
      this.startPass();
    }

    finish() {
      this.phase = 'done';
      if (this.engine === 'video') this.src.el.pause();
      if (this.state.end === 'hide' || this.engine === 'still') this.hide();
    }

    // arrête tout (calque invisible)
    halt() {
      this.active = false;
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      clearTimeout(this.timer);
      this.stopCapture();
      if (this.src && this.src.kind === 'video') this.src.el.pause();
    }

    tick(now) {
      this.raf = 0;
      const src = this.src;
      if (!src || !this.active) return;
      const dt = clamp((now - this.last) / 1000, 0, 0.25);
      this.last = now;
      const s = this.state;

      const target = this.showing ? 1 : 0;
      if (this.fade !== target) {
        this.fade = target ? 1 : Math.max(0, this.fade - dt / (LEAVE_MS / 1000));
        this.applyAudio();
      }

      if (this.phase === 'play') {
        if (this.engine === 'video') {
          // secours : les rappels d'image de la vidéo n'arrivent pas (fenêtre masquée…), on capture ici
          if (this.capturing && now - this.capLast > 200 && !src.el.paused) this.grab(src.el.currentTime, 0.025 * (+s.speed || 1));
          this.checkVideo();
        } else if (this.engine === 'cache') {
          const [a, b] = this.range();
          this.pos += dt * (+s.speed || 1) * this.dir;
          if (this.dir > 0 && this.pos >= b) {
            if (s.mode === 'bounce') { this.dir = -1; this.pos = Math.max(a, 2 * b - this.pos); } else { this.pos = b; this.drawAt(b); this.endPass(); }
          } else if (this.dir < 0 && this.pos <= a) {
            this.pos = a;
            this.drawAt(a);
            this.endPass();
          }
          if (this.phase === 'play' && this.engine === 'cache') this.drawAt(this.pos);
        }
      }
      this.raf = requestAnimationFrame(this.tick);
    }

    // vidéo lue directement : fin du passage ?
    checkVideo() {
      if (this.phase !== 'play' || this.engine !== 'video') return;
      const v = this.src.el;
      const [, b] = this.range();
      if (v.loop || !(v.ended || v.currentTime >= b - 0.03)) return;
      if (this.state.mode === 'bounce') this.turn(); else this.endPass();
    }

    drawAt(t) {
      const f = this.src.kind === 'anim' ? this.src.frames : this.frames;
      if (!f.length) return;
      let i = Math.min(this.fi || 0, f.length - 1);
      while (i > 0 && f[i].t > t) i--;
      while (i < f.length - 1 && f[i + 1].t <= t) i++;
      this.fi = i;
      if (i === this.drawn || !f[i].bmp) return;
      this.drawn = i;
      const bmp = f[i].bmp;
      if (this.cv.width !== bmp.width || this.cv.height !== bmp.height) {
        this.cv.width = bmp.width;
        this.cv.height = bmp.height;
      } else {
        this.ctx.clearRect(0, 0, this.cv.width, this.cv.height);
      }
      this.ctx.drawImage(bmp, 0, 0);
    }

    // ---------- boomerang : mémorisation des images de la vidéo ----------
    startCapture() {
      this.clearFrames();
      const src = this.src;
      const [a, b] = this.range();
      const len = (Number.isFinite(b) ? b : src.duration || 10) - a;
      const s = this.capScale(src.w, src.h, Math.max(2, len * GUESS_FPS));
      this.capW = Math.max(1, Math.round(src.w * s));
      this.capH = Math.max(1, Math.round(src.h * s));
      this.capStep = 1;
      this.capN = 0;
      this.capKey = this.rangeKey();
      this.capturing = true;
      this.capLast = performance.now();
      if (!this.capReq) this.capReq = src.el.requestVideoFrameCallback(this.onFrame);
    }

    stopCapture() {
      this.capturing = false;
      if (this.capReq && this.src && this.src.kind === 'video') this.src.el.cancelVideoFrameCallback(this.capReq);
      this.capReq = 0;
    }

    onFrame(_now, meta) {
      this.capReq = 0;
      const src = this.src;
      if (!src || src.kind !== 'video' || !this.capturing) return;
      this.capLast = performance.now();
      this.grab(meta.mediaTime, 0.004);
      this.capReq = src.el.requestVideoFrameCallback(this.onFrame);
    }

    // mémorise l'image affichée (instant t du média), au moins minDt après la précédente
    grab(t, minDt) {
      const v = this.src.el;
      const [a, b] = this.range();
      const last = this.frames[this.frames.length - 1];
      // la première image doit être celle du début (pas une image d'avant le retour au début)
      const fresh = last ? t >= last.t + minDt : t < a + 0.25 * Math.max(1, this.state.speed);
      if (!fresh || t < a - 0.04 || t > b + 0.04 || this.capN++ % this.capStep !== 0) return;
      const f = { t, bmp: null };
      this.frames.push(f);
      createImageBitmap(v, { resizeWidth: this.capW, resizeHeight: this.capH, resizeQuality: 'medium' })
        .then((bmp) => { if (this.frames.includes(f)) f.bmp = bmp; else bmp.close(); }, () => {});
      if (this.frames.length * this.capW * this.capH * 4 > CACHE_BYTES) this.decimate();
    }

    // trop d'images pour la mémoire allouée : on en garde une sur deux
    decimate() {
      this.frames = this.frames.filter((f, i) => {
        if (i % 2 === 0) return true;
        if (f.bmp) f.bmp.close();
        return false;
      });
      this.capStep *= 2;
    }

    clearFrames() {
      for (const f of this.frames) if (f.bmp) f.bmp.close();
      this.frames = [];
      this.framesKey = null;
    }

    // fin du premier passage du boomerang : on repart en arrière depuis les images mémorisées
    turn() {
      const v = this.src.el;
      v.pause();
      this.stopCapture();
      if (this.frames.length < 2) { this.endPass(); return; }
      this.framesKey = this.capKey;
      this.engine = 'cache';
      this.dir = -1;
      this.fi = this.frames.length - 1;
      this.pos = this.frames[this.fi].t;
      this.drawn = -1;
      if (this.cv.width !== this.capW || this.cv.height !== this.capH) {
        this.cv.width = this.capW;
        this.cv.height = this.capH;
      }
      this.ctx.drawImage(v, 0, 0, this.capW, this.capH); // pas d'image vide si la dernière n'est pas encore prête
      this.setView(this.cv);
      this.drawAt(this.pos);
      this.applyAudio();
    }

    // ---------- éditeur ----------
    currentTime() {
      if (!this.src || this.src.kind === 'image') return null;
      return this.engine === 'video' ? this.src.el.currentTime : this.pos;
    }

    // affiche l'image à l'instant t sans lire (réglage de la découpe)
    scrub(t) {
      const src = this.src;
      if (!src || src.kind === 'image') return;
      this.scrubbing = true;
      this.phase = 'scrub';
      this.stopCapture();
      if (!this.showing) { clearTimeout(this.visTimer); this.showing = true; this.setVis('md-shown'); }
      this.pos = t;
      if (src.kind === 'video') {
        this.engine = 'video';
        this.setView(src.el);
        src.el.pause();
        src.el.currentTime = t;
      } else {
        this.engine = 'cache';
        this.setView(this.cv);
        this.drawn = -1;
        this.drawAt(t);
      }
      this.applyAudio();
    }

    endScrub() {
      if (!this.scrubbing) return;
      this.scrubbing = false;
      if (this.on) this.reveal(false);
    }
  }

  window.Media = { Player, DEFAULT_STATE, CANVAS_W, merge, clone, clamp, fmtTime, extOf };
})();
