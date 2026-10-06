/* Musique en cours — rendu partagé entre l'aperçu de l'éditeur et le calque à l'écran.
 * Canevas logique de 1920 px de large (hauteur = ratio de l'écran), mis à l'échelle, comme les autres modules.
 * Le morceau vient du backend du module (backend.js), qui lit Spotify dans les contrôles multimédias de Windows :
 * bridge.call('watch') au démarrage puis toutes les 20 s, et bridge.on('track') à chaque changement.
 * Dans les aperçus, un morceau d'exemple prend la place de Spotify quand il n'est pas ouvert. */
(function () {
  'use strict';

  const CANVAS_W = 1920;
  const ENTER_MS = 1000;
  const LEAVE_MS = 380;
  const SWAP_MS = 900;
  const WATCH_MS = 20000;
  const MARQUEE_SPEED = 55; // px du canevas par seconde, à la taille 1
  // textes traduits dans l'éditeur et les aperçus (le calque à l'écran n'affiche que le morceau)
  const _ = (s, v) => (window.I18N ? window.I18N.t(s, v) : s);

  const DEFAULT_STATE = {
    layout: 'card', // card | compact | cover
    x: 0.17, y: 0.88, // centre, en fraction de l'écran
    scale: 1,
    width: 560, // longueur de la carte (px du canevas, à la taille 1), sauf en mode pochette
    showCover: true,
    showAlbum: false,
    progress: true,
    times: false,
    eq: true, // petit égaliseur animé pendant la lecture
    bg: '#0E0D0C',
    bgOpacity: 0.8,
    text: '#FFFFFF',
    accentMode: 'auto', // auto (couleur de la pochette) | custom
    accent: '#1ED760',
    radius: 18,
    shadow: true,
    paused: 'dim', // en pause : show | dim | hide
    change: 'slide', // nouveau morceau : none | fade | slide
    entrance: 'rise',
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

  function rgba(hex, a) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    const n = m ? parseInt(m[1], 16) : 0;
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${clamp(+a, 0, 1)})`;
  }

  const two = (n) => String(n).padStart(2, '0');
  function fmtTime(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600);
    return h ? `${h}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}` : `${Math.floor(s / 60)}:${two(s % 60)}`;
  }

  // position actuelle d'un morceau : celle donnée par Spotify, plus le temps écoulé depuis s'il joue
  function positionOf(t, now = Date.now()) {
    if (!t) return 0;
    const p = t.playing ? t.position + (now - t.at) : t.position;
    return t.duration > 0 ? clamp(p, 0, t.duration) : Math.max(0, p);
  }

  // couleur vive dominante de la pochette, éclaircie pour rester lisible sur fond sombre
  function coverAccent(img) {
    const N = 24;
    const c = el('canvas');
    c.width = N;
    c.height = N;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, N, N);
    const d = g.getImageData(0, 0, N, N).data;
    const bins = Array.from({ length: 12 }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
    let total = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i] / 255, gg = d[i + 1] / 255, b = d[i + 2] / 255;
      const max = Math.max(r, gg, b), min = Math.min(r, gg, b);
      const chroma = max - min;
      const l = (max + min) / 2;
      if (chroma < 0.12 || l < 0.1 || l > 0.95) continue;
      let h = max === r ? ((gg - b) / chroma) % 6 : max === gg ? (b - r) / chroma + 2 : (r - gg) / chroma + 4;
      h = (h * 60 + 360) % 360;
      const w = chroma * chroma;
      const bin = bins[Math.floor(h / 30) % 12];
      bin.w += w; bin.r += d[i] * w; bin.g += d[i + 1] * w; bin.b += d[i + 2] * w;
      total += w;
    }
    const best = bins.reduce((a, b) => (b.w > a.w ? b : a));
    if (!best.w || total < 1) return null; // pochette en noir et blanc
    let [r, gg, b] = [best.r / best.w, best.g / best.w, best.b / best.w].map((v) => v / 255);
    // lumière ramenée vers 62 %, saturation d'au moins 55 %
    const max = Math.max(r, gg, b), min = Math.min(r, gg, b);
    const l = (max + min) / 2;
    const chroma = max - min;
    if (chroma < 0.02) return null;
    let h = max === r ? ((gg - b) / chroma) % 6 : max === gg ? (b - r) / chroma + 2 : (r - gg) / chroma + 4;
    h = (h * 60 + 360) % 360;
    const s = Math.max(0.55, chroma / (1 - Math.abs(2 * l - 1) || 1));
    const L2 = clamp(l, 0.55, 0.7);
    const C = (1 - Math.abs(2 * L2 - 1)) * Math.min(1, s);
    const X = C * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = L2 - C / 2;
    [r, gg, b] = h < 60 ? [C, X, 0] : h < 120 ? [X, C, 0] : h < 180 ? [0, C, X] : h < 240 ? [0, X, C] : h < 300 ? [X, 0, C] : [C, 0, X];
    return `#${[r, gg, b].map((v) => two(Math.round((v + m) * 255).toString(16))).join('')}`;
  }

  // morceau d'exemple des aperçus : il avance et recommence, pour voir la barre de progression
  function demoTrack() {
    return { title: _('Titre du morceau'), artist: _('Artiste'), album: _('Album'), playing: true, position: 0, duration: 214000, at: Date.now(), cover: null, demo: true };
  }

  // une ligne de texte : défile comme un bandeau quand elle est trop longue pour la carte
  function makeLine(cls) {
    const line = el('div', `mu-line ${cls}`);
    const run = el('div', 'mu-run');
    line.append(run);
    return { line, run };
  }

  // ---------- vue ----------
  class View {
    constructor(host, opts = {}) {
      this.bridge = opts.bridge || null;
      this.onInfo = opts.onInfo || null;
      // vraie sortie (overlay) : jamais de morceau d'exemple. Le calque ne le sait qu'après init().
      this.output = opts.output != null ? !!opts.output : true;
      this.cw = CANVAS_W;
      this.ch = 1080;
      this.k = 1;
      this.state = merge(DEFAULT_STATE, {});
      this.info = { ok: false, error: null, track: null };
      this.demo = demoTrack();
      this.on = false; // le calque doit être affiché (enter / show reçus)
      this.animateNext = false; // enter reçu avant le morceau : l'animation d'entrée attend qu'il arrive
      this.showing = false;
      this.key = null;
      this.coverUrl = null;
      this.coverColor = null;
      this.rect = { w: 0, h: 0 };

      this.canvas = el('div', 'mu-canvas mu-hidden');
      this.canvas.dataset.noI18n = ''; // titres de Spotify : rien à traduire
      this.box = el('div', 'mu-box');
      this.enterEl = el('div', 'mu-enter');
      this.card = el('div', 'mu-card');
      this.art = el('div', 'mu-art');
      this.img = el('img', 'mu-img');
      this.img.alt = '';
      this.img.decoding = 'async';
      this.ph = el('div', 'mu-ph');
      this.ph.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/></svg>';
      this.art.append(this.ph, this.img);

      this.meta = el('div', 'mu-meta');
      const head = el('div', 'mu-head');
      this.title = makeLine('mu-title');
      this.eq = el('div', 'mu-eq');
      for (let i = 0; i < 4; i++) this.eq.append(el('i'));
      head.append(this.eq, this.title.line);
      this.artist = makeLine('mu-artist');
      this.album = makeLine('mu-album');
      const barRow = el('div', 'mu-bar-row');
      this.bar = el('div', 'mu-bar');
      this.fill = el('i');
      this.bar.append(this.fill);
      this.time = el('span', 'mu-time');
      barRow.append(this.bar, this.time);
      this.meta.append(head, this.artist.line, this.album.line, barRow);

      this.card.append(this.art, this.meta);
      this.enterEl.append(this.card);
      this.box.append(this.enterEl);
      this.canvas.append(this.box);
      host.append(this.canvas);

      this.img.addEventListener('load', () => {
        try { this.coverColor = coverAccent(this.img); } catch { this.coverColor = null; }
        this.apply();
      });
      this.img.addEventListener('error', () => { this.coverColor = null; this.canvas.classList.remove('mu-has-cover'); this.apply(); });

      if (this.bridge && this.bridge.call) {
        this.bridge.on('track', (info) => this.setInfo(info));
        this.watch();
        this.watchTimer = setInterval(() => this.watch(), WATCH_MS);
      } else {
        this.info = { ok: false, error: _('SceneCue indisponible'), track: null };
      }
      this.ticker = setInterval(() => this.tick(), 250);
      if (document.fonts) document.fonts.ready.then(() => this.fit()).catch(() => {});
      this.apply();
      this.render();
    }

    // le calque apprend après coup s'il est la sortie ou un aperçu
    setOutput(v) {
      this.output = !!v;
      this.apply();
      this.render();
    }

    watch() {
      this.bridge.call('watch').then((info) => this.setInfo(info)).catch(() => {});
    }

    setInfo(info) {
      this.info = info || { ok: false, error: null, track: null };
      this.render();
      if (this.onInfo) this.onInfo(this.info);
    }

    destroy() {
      clearInterval(this.ticker);
      clearInterval(this.watchTimer);
      clearTimeout(this.visTimer);
      clearTimeout(this.swapTimer);
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

    // ---------- état ----------
    update(state) {
      const prev = this.state;
      this.state = merge(DEFAULT_STATE, state || {});
      this.apply();
      // la longueur des lignes ne change qu'avec la disposition et la taille
      const s = this.state;
      if (prev.layout !== s.layout || prev.width !== s.width || prev.scale !== s.scale || prev.showCover !== s.showCover
        || prev.eq !== s.eq || prev.times !== s.times) this.fit();
      this.render();
    }

    // morceau à afficher : celui de Spotify, sinon l'exemple (aperçus seulement)
    current() {
      const t = this.info && this.info.track;
      if (t) return t;
      return this.output ? null : this.demo;
    }

    apply() {
      const s = this.state;
      const cl = this.canvas.classList;
      const keep = ['mu-canvas', 'mu-hidden', 'mu-in', 'mu-out', 'mu-shown', 'mu-playing', 'mu-paused', 'mu-has-cover', 'mu-swap']
        .filter((c) => cl.contains(c));
      keep.push(`mu-l-${s.layout}`, `mu-ent-${s.entrance}`, `mu-chg-${s.change}`, `mu-p-${s.paused}`);
      if (s.shadow) keep.push('mu-shadow');
      if (s.showCover || s.layout === 'cover') keep.push('mu-with-cover');
      if (s.showAlbum) keep.push('mu-with-album');
      if (s.progress) keep.push('mu-with-bar');
      if (s.times) keep.push('mu-with-times');
      if (s.eq) keep.push('mu-with-eq');
      if (!this.output) keep.push('mu-preview');
      this.canvas.className = keep.join(' ');
      const st = this.canvas.style;
      st.setProperty('--u', `${clamp(+s.scale || 1, 0.2, 4)}px`);
      st.setProperty('--w', String(clamp(+s.width || 560, 240, 1600)));
      st.setProperty('--bg', rgba(s.bg, s.bgOpacity));
      st.setProperty('--fg', s.text || '#FFFFFF');
      const accent = s.accentMode === 'auto' ? this.coverColor || s.accent : s.accent;
      st.setProperty('--accent', accent || '#1ED760');
      st.setProperty('--radius', String(clamp(+s.radius || 0, 0, 60)));
      this.layout();
    }

    layout() {
      const s = this.state;
      const b = this.box.style;
      b.left = `${s.x * this.cw}px`;
      b.top = `${s.y * this.ch}px`;
      this.rect = { w: this.box.offsetWidth, h: this.box.offsetHeight };
      this.canvas.style.setProperty('--slide', `${-Math.round(s.x * this.cw + this.rect.w + 60)}px`);
    }

    // ---------- morceau ----------
    render() {
      const t = this.current();
      const key = t ? `${t.title}|${t.artist}|${t.album}` : null;
      if (key !== this.key) {
        const swap = this.key != null && key != null && this.showing;
        this.key = key;
        if (t) {
          this.setText(this.title, t.title || _('Titre inconnu'), t.artist);
          this.setText(this.artist, t.artist);
          this.setText(this.album, t.album);
          this.album.line.classList.toggle('mu-empty', !t.album);
        }
        if (swap) this.swap();
        this.fit();
      }
      const cover = t ? t.cover || null : null;
      if (cover !== this.coverUrl) {
        this.coverUrl = cover;
        this.coverColor = null;
        if (cover) this.img.src = cover; else this.img.removeAttribute('src');
        this.apply();
      }
      const cl = this.canvas.classList;
      cl.toggle('mu-has-cover', !!cover);
      cl.toggle('mu-playing', !!t && t.playing);
      cl.toggle('mu-paused', !!t && !t.playing);
      this.tick();
      this.refreshVisibility();
    }

    setText(ln, text, artist) {
      const t = el('span', 'mu-txt');
      t.textContent = text || '';
      // mode compact : l'artiste suit le titre sur la même ligne
      if (artist) { const a = el('span', 'mu-sub'); a.textContent = ` · ${artist}`; t.append(a); }
      ln.run.replaceChildren(t);
    }

    // bandeau défilant pour les lignes trop longues
    fit() {
      const fitLine = ({ line, run }) => {
        line.classList.remove('mu-mq');
        while (run.children.length > 1) run.lastChild.remove();
        const first = run.firstChild;
        if (!first || !line.clientWidth) return;
        const over = first.offsetWidth - line.clientWidth;
        if (over <= 1) return;
        const gap = Math.round(line.clientHeight * 2.2);
        const copy = first.cloneNode(true);
        copy.style.marginLeft = `${gap}px`;
        run.append(copy);
        const dist = first.offsetWidth + gap;
        const u = clamp(+this.state.scale || 1, 0.2, 4);
        line.style.setProperty('--mq-dist', `${-dist}px`);
        line.style.setProperty('--mq-dur', `${(dist / (MARQUEE_SPEED * u) / 0.8).toFixed(2)}s`);
        line.classList.add('mu-mq');
      };
      for (const ln of [this.title, this.artist, this.album]) fitLine(ln);
      this.layout();
    }

    swap() {
      if (this.state.change === 'none') return;
      clearTimeout(this.swapTimer);
      this.canvas.classList.remove('mu-swap');
      void this.canvas.offsetWidth; // relance l'animation
      this.canvas.classList.add('mu-swap');
      this.swapTimer = setTimeout(() => this.canvas.classList.remove('mu-swap'), SWAP_MS);
    }

    tick() {
      let t = this.current();
      // l'exemple tourne en boucle
      if (t && t.demo && positionOf(t) >= t.duration) { this.demo.at = Date.now(); this.demo.position = 0; t = this.demo; }
      if (!t) return;
      const pos = positionOf(t);
      const pct = t.duration > 0 ? (pos / t.duration) * 100 : 0;
      this.fill.style.width = `${pct.toFixed(2)}%`;
      this.bar.classList.toggle('mu-empty', !(t.duration > 0));
      const text = t.duration > 0 ? `${fmtTime(pos)} / ${fmtTime(t.duration)}` : fmtTime(pos);
      if (this.time.textContent !== text) this.time.textContent = text;
    }

    // ---------- apparition ----------
    // à l'écran : rien sans morceau, ni en pause si l'option « Masquer » est choisie
    wanted() {
      const t = this.current();
      if (!this.on || !t) return false;
      return !(this.output && !t.playing && this.state.paused === 'hide');
    }

    refreshVisibility() {
      const w = this.wanted();
      if (w && !this.showing) this.reveal(this.animateNext || this.output);
      else if (!w && this.showing) this.conceal();
    }

    enter() { this.on = true; this.animateNext = true; this.showing = false; this.refreshVisibility(); }
    show() { this.on = true; this.animateNext = false; this.showing = false; this.refreshVisibility(); }
    replay() { if (this.current()) this.reveal(true); }

    leave() {
      this.on = false;
      this.animateNext = false;
      this.conceal();
    }

    reveal(animate) {
      clearTimeout(this.visTimer);
      this.showing = true;
      this.animateNext = false;
      if (animate && this.state.entrance !== 'none') {
        this.setVis('mu-in');
        this.visTimer = setTimeout(() => this.setVis('mu-shown'), ENTER_MS);
      } else {
        this.setVis('mu-shown');
      }
      this.fit();
    }

    conceal() {
      if (!this.showing) { this.setVis('mu-hidden'); return; }
      this.showing = false;
      clearTimeout(this.visTimer);
      this.setVis('mu-out');
      this.visTimer = setTimeout(() => this.setVis('mu-hidden'), LEAVE_MS);
    }

    setVis(c) {
      const cl = this.canvas.classList;
      cl.remove('mu-hidden', 'mu-in', 'mu-out', 'mu-shown');
      if (c === 'mu-in') void this.canvas.offsetWidth; // relance l'animation d'entrée
      cl.add(c);
    }
  }

  window.Music = { View, DEFAULT_STATE, CANVAS_W, merge, clone, clamp, positionOf, fmtTime };
})();
