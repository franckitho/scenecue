/* Pancarte — moteur de rendu partagé entre l'aperçu et l'overlay.
 * Le texte est dessiné sur un canevas logique de 1920 px de large (hauteur = ratio de l'écran),
 * puis mis à l'échelle. Trois couches superposées : arrière (contour, ombre, relief),
 * avant (remplissage), reflet. Chaque lettre est un élément pour les animations par lettre. */
(function () {
  'use strict';

  const CANVAS_W = 1920;
  // textes affichés (noms des styles, texte par défaut) dans la langue de l'interface
  const _ = (s) => (window.I18N ? window.I18N.t(s) : s);

  const FONTS = [
    { id: 'bungee', name: 'Bungee', family: 'Bungee' },
    { id: 'anton', name: 'Anton', family: 'Anton' },
    { id: 'bebas', name: 'Bebas Neue', family: 'Bebas Neue' },
    { id: 'dela', name: 'Dela Gothic One', family: 'Dela Gothic One' },
    { id: 'rubik-mono', name: 'Rubik Mono One', family: 'Rubik Mono One' },
    { id: 'lilita', name: 'Lilita One', family: 'Lilita One' },
    { id: 'fredoka', name: 'Fredoka', family: 'Fredoka', weight: 700 },
    { id: 'bangers', name: 'Bangers', family: 'Bangers' },
    { id: 'righteous', name: 'Righteous', family: 'Righteous' },
    { id: 'black-ops', name: 'Black Ops One', family: 'Black Ops One' },
    { id: 'bungee-shade', name: 'Bungee Shade', family: 'Bungee Shade' },
    { id: 'monoton', name: 'Monoton', family: 'Monoton' },
    { id: 'press-start', name: 'Press Start 2P', family: 'Press Start 2P' },
    { id: 'rubik-glitch', name: 'Rubik Glitch', family: 'Rubik Glitch' },
    { id: 'abril', name: 'Abril Fatface', family: 'Abril Fatface' },
    { id: 'shrikhand', name: 'Shrikhand', family: 'Shrikhand' },
    { id: 'lobster', name: 'Lobster', family: 'Lobster' },
    { id: 'pacifico', name: 'Pacifico', family: 'Pacifico' },
    { id: 'marker', name: 'Permanent Marker', family: 'Permanent Marker' },
    { id: 'caveat', name: 'Caveat', family: 'Caveat', weight: 700 },
    { id: 'archivo', name: 'Archivo', family: 'Archivo', weight: 800 },
    { id: 'impact', name: 'Impact', family: 'Impact', system: true },
    { id: 'arial-black', name: 'Arial Black', family: 'Arial Black', weight: 900, system: true },
    { id: 'comic', name: 'Comic Sans MS', family: 'Comic Sans MS', weight: 700, system: true },
    { id: 'segoe-black', name: 'Segoe UI Black', family: 'Segoe UI Black', weight: 900, system: true },
    { id: 'georgia', name: 'Georgia', family: 'Georgia', weight: 700, system: true },
    { id: 'courier', name: 'Courier New', family: 'Courier New', weight: 700, system: true },
  ];

  const SUB_FONTS = [
    { id: 'archivo', name: 'Archivo', family: 'Archivo', weight: 700 },
    { id: 'mono', name: 'JetBrains Mono', family: 'JetBrains Mono', weight: 700 },
    { id: 'bebas', name: 'Bebas Neue', family: 'Bebas Neue' },
    { id: 'marker', name: 'Permanent Marker', family: 'Permanent Marker' },
    { id: 'caveat', name: 'Caveat', family: 'Caveat', weight: 700 },
    { id: 'press-start', name: 'Press Start 2P', family: 'Press Start 2P' },
    { id: 'fredoka', name: 'Fredoka', family: 'Fredoka', weight: 700 },
  ];

  // Remplissages prédéfinis : liste de [couleur, position 0..1]
  const FILL_PRESETS = {
    chrome: [['#fbfcfd', 0], ['#c3cad3', 0.36], ['#59616c', 0.5], ['#2a3038', 0.53], ['#dfe5ec', 0.62], ['#9aa3ae', 0.84], ['#f4f6f8', 1]],
    gold: [['#fff7cf', 0], ['#f5c851', 0.34], ['#9a5f0c', 0.5], ['#6e3f05', 0.53], ['#f6d36b', 0.62], ['#c4891b', 0.84], ['#fff0a8', 1]],
    rainbow: [['#ff3b3b', 0], ['#ff9f1c', 0.17], ['#ffe14d', 0.33], ['#3ee07a', 0.5], ['#2ec6ff', 0.67], ['#7a5cff', 0.83], ['#ff4fd8', 1]],
  };

  const DEFAULT_STYLE = {
    font: 'bungee', customFont: '', size: 150, spacing: 0, lineHeight: 1.05,
    upper: false, italic: false, align: 'center', rotate: 0, arc: 0,
    fill: { type: 'gradient', c1: '#FFE14D', c2: '#FF5A1F', c3: '', angle: 180 },
    stroke: { on: true, width: 6, color: '#1B0F08' },
    shadow: { type: 'extrude', color: '#1B0F08', opacity: 1, dist: 14, angle: 70, blur: 0 },
    shine: false, hue: false,
    anim: 'wave', speed: 1, amp: 1, entrance: 'pop',
  };

  const DEFAULT_STATE = {
    text: _('Je reviens vite'),
    x: 0.5, y: 0.5,
    display: null,
    dim: 0,
    style: DEFAULT_STYLE,
    sub: { on: true, text: _('parti prendre une douche'), font: 'archivo', size: 40, color: '#FFFFFF', upper: true, spacing: 0.22, shadow: true },
    timer: { mode: 'off', minutes: 10, label: _('De retour dans') },
  };

  // Galerie façon WordArt
  const LOOKS = [
    { id: 'wordart', name: _('WordArt 97'), style: { font: 'impact', size: 170, spacing: 2, upper: false, arc: 38, rotate: 0,
      fill: { type: 'rainbow', angle: 90 }, stroke: { on: true, width: 3, color: '#151515' },
      shadow: { type: 'extrude', color: '#3a3a3a', opacity: 1, dist: 12, angle: 45, blur: 0 }, anim: 'none', entrance: 'pop' } },
    { id: 'neon', name: _('Néon'), style: { font: 'monoton', size: 150, spacing: 4, upper: true,
      fill: { type: 'solid', c1: '#FFF1FA' }, stroke: { on: false },
      shadow: { type: 'glow', color: '#FF2E97', opacity: 1, blur: 46 }, anim: 'flicker', entrance: 'fade' } },
    { id: 'arcade', name: _('Arcade'), style: { font: 'press-start', size: 84, spacing: 2, upper: true, lineHeight: 1.4,
      fill: { type: 'gradient', c1: '#FFF27A', c2: '#FF9F1C', angle: 180 }, stroke: { on: true, width: 4, color: '#0B0B12' },
      shadow: { type: 'hard', color: '#E8174B', opacity: 1, dist: 10, angle: 45 }, anim: 'bounce', entrance: 'letters' } },
    { id: 'chrome', name: _('Chrome'), style: { font: 'anton', size: 190, spacing: 3, upper: true, rotate: -3,
      fill: { type: 'chrome', angle: 180 }, stroke: { on: true, width: 3, color: '#0D1014' },
      shadow: { type: 'extrude', color: '#1C222B', opacity: 1, dist: 14, angle: 75 }, shine: true, anim: 'float', entrance: 'rise' } },
    { id: 'gold', name: _('Lingot'), style: { font: 'abril', size: 170, spacing: 1,
      fill: { type: 'gold', angle: 180 }, stroke: { on: true, width: 2, color: '#3A2405' },
      shadow: { type: 'extrude', color: '#3A2405', opacity: 1, dist: 10, angle: 65 }, shine: true, anim: 'pulse', entrance: 'focus' } },
    { id: 'bubble', name: _('Chewing-gum'), style: { font: 'fredoka', size: 170,
      fill: { type: 'gradient', c1: '#FFC2E2', c2: '#FF4FA3', angle: 180 }, stroke: { on: true, width: 11, color: '#FFFFFF' },
      shadow: { type: 'soft', color: '#6E1240', opacity: 0.55, dist: 14, angle: 90, blur: 22 }, anim: 'wave', entrance: 'pop' } },
    { id: 'marker', name: _('Marqueur'), style: { font: 'marker', size: 150, rotate: -4,
      fill: { type: 'solid', c1: '#FFFFFF' }, stroke: { on: false },
      shadow: { type: 'soft', color: '#000000', opacity: 0.7, dist: 6, angle: 90, blur: 14 }, anim: 'float', entrance: 'rise' } },
    { id: 'sunset', name: _('Miami'), style: { font: 'shrikhand', size: 160, rotate: -6, arc: 12,
      fill: { type: 'gradient', c1: '#FFE66D', c2: '#FF6B6B', c3: '#C2185B', angle: 180 }, stroke: { on: true, width: 4, color: '#2A0A36' },
      shadow: { type: 'extrude', color: '#2A0A36', opacity: 1, dist: 18, angle: 90 }, anim: 'swing', entrance: 'pop' } },
    { id: 'glitch', name: _('Glitch'), style: { font: 'rubik-mono', size: 130, upper: true, spacing: 2,
      fill: { type: 'solid', c1: '#F4F4F4' }, stroke: { on: false },
      shadow: { type: 'soft', color: '#000000', opacity: 0.6, dist: 0, blur: 24 }, anim: 'glitch', entrance: 'focus' } },
    { id: 'comic', name: _('Bédé'), style: { font: 'bangers', size: 190, spacing: 4, rotate: -4,
      fill: { type: 'gradient', c1: '#FFF59A', c2: '#FFC21A', angle: 180 }, stroke: { on: true, width: 8, color: '#111111' },
      shadow: { type: 'hard', color: '#111111', opacity: 1, dist: 12, angle: 50 }, anim: 'bounce', entrance: 'letters' } },
    { id: 'headline', name: _('Gros titre'), style: { font: 'bebas', size: 210, spacing: 6, upper: true,
      fill: { type: 'solid', c1: '#FFFFFF' }, stroke: { on: true, width: 2, color: '#000000' },
      shadow: { type: 'soft', color: '#000000', opacity: 0.55, dist: 5, angle: 90, blur: 20 }, anim: 'none', entrance: 'rise' } },
    { id: 'ice', name: _('Givre'), style: { font: 'dela', size: 140,
      fill: { type: 'gradient', c1: '#F2FDFF', c2: '#86DBFF', c3: '#2E7BFF', angle: 180 }, stroke: { on: true, width: 4, color: '#0A2342' },
      shadow: { type: 'glow', color: '#7FD8FF', opacity: 0.9, blur: 34 }, anim: 'float', entrance: 'focus' } },
  ];

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

  function hexToRgb(hex) {
    let h = String(hex || '#000').replace('#', '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const n = parseInt(h.slice(0, 6), 16) || 0;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const rgba = (hex, a) => { const [r, g, b] = hexToRgb(hex); return `rgba(${r},${g},${b},${a})`; };
  function shade(hex, k, a) { // k < 0 assombrit
    const [r, g, b] = hexToRgb(hex).map((c) => Math.round(k < 0 ? c * (1 + k) : c + (255 - c) * k));
    return `rgba(${r},${g},${b},${a})`;
  }

  function fontOf(style) {
    if (style.font === 'custom') return { family: style.customFont || 'Arial', weight: 700 };
    return FONTS.find((f) => f.id === style.font) || FONTS[0];
  }
  const familyCss = (f) => `"${f.family}", "Arial Black", sans-serif`;

  function fillStops(fill) {
    if (FILL_PRESETS[fill.type]) return FILL_PRESETS[fill.type];
    const cs = [fill.c1, fill.c2, fill.c3].filter(Boolean);
    if (cs.length < 2) cs.push(cs[0] || '#fff');
    return cs.map((c, i) => [c, i / (cs.length - 1)]);
  }

  function shadowCss(sh) {
    const t = sh.type;
    if (!t || t === 'none') return 'none';
    const a = sh.opacity ?? 1;
    const rad = ((sh.angle ?? 90) * Math.PI) / 180;
    const ux = Math.cos(rad), uy = Math.sin(rad);
    const d = sh.dist ?? 10, b = sh.blur ?? 0;
    const r = (n) => Math.round(n * 100) / 100;
    if (t === 'soft') return `${r(ux * d)}px ${r(uy * d)}px ${b}px ${rgba(sh.color, a)}`;
    if (t === 'hard') return `${r(ux * d)}px ${r(uy * d)}px 0 ${rgba(sh.color, a)}`;
    if (t === 'glow') {
      const g = Math.max(4, b);
      return [0.12, 0.3, 0.6, 1.2].map((m, i) => `0 0 ${r(g * m)}px ${rgba(sh.color, i < 2 ? a : a * 0.8)}`).join(', ');
    }
    if (t === 'extrude') {
      const n = Math.max(1, Math.min(60, Math.round(d)));
      const out = [];
      for (let i = 1; i <= n; i++) out.push(`${r(ux * i)}px ${r(uy * i)}px 0 ${shade(sh.color, -0.4 * (i / n), a)}`);
      out.push(`${r(ux * (n + 6))}px ${r(uy * (n + 6))}px ${Math.max(12, b)}px rgba(0,0,0,${0.35 * a})`);
      return out.join(', ');
    }
    return 'none';
  }

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const p = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
  }

  const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('fr', { granularity: 'grapheme' }) : null;
  const graphemes = (s) => (segmenter ? Array.from(segmenter.segment(s), (x) => x.segment) : Array.from(s));

  const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };

  let uidSeq = 0;
  const loadedFonts = new Set();

  // ---------- Renderer ----------
  class Renderer {
    constructor(host, opts = {}) {
      this.host = host;
      this.opts = opts; // { fit: bool }
      this.uid = `${Date.now().toString(36)}${uidSeq++}`;
      this.state = null;
      this.builtKey = null;
      this.since = null;
      this.cw = CANVAS_W;
      this.ch = 1080;

      this.canvas = el('div', 'pc-canvas pc-out');
      this.dim = el('div', 'pc-dim');
      this.block = el('div', 'pc-block');
      this.enterEl = el('div', 'pc-enter');
      this.motion = el('div', 'pc-motion');
      this.title = el('div', 'pc-title');
      this.layers = ['pc-back', 'pc-front', 'pc-shine'].map((c) => el('div', `pc-layer ${c}`));
      this.sub = el('div', 'pc-sub');
      this.timer = el('div', 'pc-timer');
      this.title.append(...this.layers);
      this.motion.append(this.title, this.sub, this.timer);
      this.enterEl.append(this.motion);
      this.block.append(this.enterEl);
      this.canvas.append(this.dim, this.block);
      host.append(this.canvas);

      this.css = el('style');
      document.head.append(this.css);

      this.ro = new ResizeObserver(() => requestAnimationFrame(() => this.layout()));
      this.ro.observe(this.layers[1]);
      this.ro.observe(this.motion);
      this.tick = setInterval(() => this.updateTimer(), 250);
      this.setSize(CANVAS_W, 1080);
    }

    destroy() {
      clearInterval(this.tick);
      clearTimeout(this.enterTimer);
      this.ro.disconnect();
      this.css.remove();
      this.canvas.remove();
    }

    setSize(w, h) {
      this.cw = w; this.ch = h;
      this.canvas.style.width = `${w}px`;
      this.canvas.style.height = `${h}px`;
      this.layout();
    }

    setSince(ts) { this.since = ts; this.updateTimer(); }

    // apparition animée
    enter() {
      const c = this.canvas;
      clearTimeout(this.enterTimer);
      c.classList.remove('pc-out', 'pc-in', 'pc-shown');
      void c.offsetWidth;
      c.classList.add('pc-in');
      const n = this.count || 0;
      this.enterTimer = setTimeout(() => {
        c.classList.remove('pc-in');
        c.classList.add('pc-shown');
      }, 1400 + n * 45);
    }
    leave() {
      clearTimeout(this.enterTimer);
      this.canvas.classList.remove('pc-in', 'pc-shown');
      this.canvas.classList.add('pc-out');
    }
    show() {
      clearTimeout(this.enterTimer);
      this.canvas.classList.remove('pc-in', 'pc-out');
      this.canvas.classList.add('pc-shown');
    }

    update(state) {
      const s = merge(DEFAULT_STATE, state || {});
      s.style = merge(DEFAULT_STYLE, s.style || {});
      this.state = s;
      const key = JSON.stringify([s.text]);
      if (key !== this.builtKey) { this.build(s); this.builtKey = key; }
      this.apply(s);
      this.layout();
      const f = fontOf(s.style);
      this.ensureFont(f);
      this.ensureFont(SUB_FONTS.find((x) => x.id === s.sub.font) || SUB_FONTS[0]);
    }

    ensureFont(f) {
      if (!document.fonts || !f) return;
      const spec = `${f.weight || 400} 40px "${f.family}"`;
      if (loadedFonts.has(spec)) return;
      document.fonts.load(spec).then(() => { loadedFonts.add(spec); this.layout(); }).catch(() => {});
    }

    build(s) {
      const text = s.text && s.text.length ? s.text : ' ';
      const lines = text.split('\n');
      const parts = this.layers.map(() => document.createDocumentFragment());
      let i = 0;
      for (const line of lines) {
        const lineEls = this.layers.map(() => el('div', 'pc-line'));
        const chars = graphemes(line.length ? line : ' ');
        let words = null;
        const flush = () => { words = null; };
        for (const g of chars) {
          const isSpace = /^\s$/.test(g);
          if (isSpace) flush();
          else if (!words) {
            words = lineEls.map((le) => { const w = el('span', 'pc-word'); le.append(w); return w; });
          }
          lineEls.forEach((le, li) => {
            const slot = el('span', 'pc-slot');
            slot.style.setProperty('--i', i);
            const ch = el('span', 'pc-ch');
            ch.textContent = isSpace ? ' ' : g;
            slot.append(ch);
            (isSpace ? le : words[li]).append(slot);
          });
          i++;
        }
        lineEls.forEach((le, li) => parts[li].append(le));
      }
      this.layers.forEach((l, li) => { l.replaceChildren(parts[li]); });
      this.count = i;
      this.title.style.setProperty('--n', i);
    }

    apply(s) {
      const st = s.style;
      const c = this.canvas.style;
      const f = fontOf(st);
      const anim = this.opts.fit && (st.anim === 'type' || st.anim === 'marquee') ? 'none' : st.anim;

      // classes d'état
      const keep = ['pc-canvas', 'pc-out', 'pc-in', 'pc-shown'];
      const cls = [...this.canvas.classList].filter((k) => keep.includes(k));
      cls.push(`pc-anim-${anim}`, `pc-ent-${st.entrance}`, `pc-fill-${st.fill.type === 'solid' ? 'solid' : 'grad'}`);
      if (st.shine) cls.push('pc-shine-on');
      if (st.hue) cls.push('pc-hue-on');
      if (this.opts.fit) cls.push('pc-fit');
      this.canvas.className = cls.join(' ');

      c.setProperty('--x', s.x);
      c.setProperty('--y', s.y);
      c.setProperty('--dim', s.dim);
      c.setProperty('--spd', Math.max(0.1, st.speed));
      c.setProperty('--amp', st.amp);
      c.setProperty('--rot', `${st.rotate}deg`);
      c.setProperty('--align', st.align);
      c.setProperty('--font', familyCss(f));
      c.setProperty('--weight', f.weight || 400);
      c.setProperty('--fstyle', st.italic ? 'italic' : 'normal');
      c.setProperty('--size', `${st.size}px`);
      c.setProperty('--ls', `${st.spacing}px`);
      c.setProperty('--lh', st.lineHeight);
      c.setProperty('--tt', st.upper ? 'uppercase' : 'none');
      c.setProperty('--fill', st.fill.c1 || '#fff');
      c.setProperty('--stroke-w', st.stroke.on ? `${st.stroke.width * 2}px` : '0px');
      c.setProperty('--stroke-c', st.stroke.color);
      c.setProperty('--back-fill', st.stroke.on && st.stroke.width > 0 ? st.stroke.color : 'transparent');
      c.setProperty('--shadow', shadowCss(st.shadow));
      c.setProperty('--tw-dur', `${(this.count * 0.09 + 2.6) / Math.max(0.1, st.speed)}s`);

      // sous-titre + minuteur
      const sf = SUB_FONTS.find((x) => x.id === s.sub.font) || SUB_FONTS[0];
      c.setProperty('--sub-font', `"${sf.family}", sans-serif`);
      c.setProperty('--sub-weight', sf.weight || 400);
      c.setProperty('--sub-size', `${s.sub.size}px`);
      c.setProperty('--sub-color', s.sub.color);
      c.setProperty('--sub-ls', `${s.sub.spacing}em`);
      c.setProperty('--sub-tt', s.sub.upper ? 'uppercase' : 'none');
      c.setProperty('--sub-shadow', s.sub.shadow ? '0 2px 3px rgba(0,0,0,.55), 0 0 18px rgba(0,0,0,.45)' : 'none');
      const subOn = s.sub.on && s.sub.text.trim().length > 0;
      this.sub.hidden = !subOn;
      if (subOn) this.sub.textContent = s.sub.text;
      this.timer.hidden = s.timer.mode === 'off';
      this.updateTimer();
    }

    updateTimer() {
      const s = this.state;
      if (!s || s.timer.mode === 'off') return;
      const elapsed = this.since ? (Date.now() - this.since) / 1000 : 0;
      let t, done = false;
      if (s.timer.mode === 'down') {
        const left = s.timer.minutes * 60 - elapsed;
        done = left <= 0;
        t = fmtTime(Math.ceil(left));
      } else {
        t = fmtTime(elapsed);
      }
      const label = (s.timer.label || '').trim();
      const txt = label ? `${label} ${t}` : t;
      if (this.timer.textContent !== txt) this.timer.textContent = txt;
      this.timer.classList.toggle('pc-done', done && !!this.since);
    }

    layout() {
      const s = this.state;
      if (!s) return;
      const st = s.style;
      const front = this.layers[1];
      const W = front.offsetWidth, H = front.offsetHeight;
      if (!W || !H) return;
      const size = st.size;
      const pX = size * 0.25, pY = size * 0.3; // marge de la boîte de chaque lettre (cf. .pc-ch)
      const bw = W + 2 * pX, bh = H + 2 * pY;

      // dégradé continu sur tout le texte, exprimé en px pour coller au bloc de texte
      const stops = fillStops(st.fill);
      const ang = st.fill.type === 'rainbow' && st.fill.angle == null ? 90 : (st.fill.angle ?? 180);
      const th = (ang * Math.PI) / 180;
      const L = Math.abs(bw * Math.sin(th)) + Math.abs(bh * Math.cos(th));
      const Li = Math.abs(W * Math.sin(th)) + Math.abs(H * Math.cos(th));
      const off = (L - Li) / 2;
      const grad = `linear-gradient(${ang}deg, ${stops.map(([col, p]) => `${col} ${(off + p * Li).toFixed(1)}px`).join(', ')})`;
      const ts = this.title.style;
      ts.setProperty('--grad', grad);
      ts.setProperty('--bw', `${bw}px`);
      ts.setProperty('--bh', `${bh}px`);

      // positions de chaque lettre (sans transformations)
      const slotsByLayer = this.layers.map((l) => l.getElementsByClassName('pc-slot'));
      const ref = slotsByLayer[1];
      const n = ref.length;
      const pos = new Array(n);
      for (let i = 0; i < n; i++) {
        const sl = ref[i];
        pos[i] = { x: sl.offsetLeft, y: sl.offsetTop, w: sl.offsetWidth };
      }

      // courbure façon WordArt : regroupe par ligne visuelle
      const arc = +st.arc || 0;
      const tf = new Array(n).fill('');
      let maxDy = 0;
      if (arc !== 0 && n) {
        const rows = new Map();
        pos.forEach((p, i) => { const k = Math.round(p.y); if (!rows.has(k)) rows.set(k, []); rows.get(k).push(i); });
        let widest = 1;
        const spans = [];
        for (const idx of rows.values()) {
          const a = pos[idx[0]], b = pos[idx[idx.length - 1]];
          const left = a.x, right = b.x + b.w;
          widest = Math.max(widest, right - left);
          spans.push({ idx, cx: (left + right) / 2 });
        }
        const total = (Math.abs(arc) / 100) * Math.PI; // 100 = demi-cercle
        const R = widest / total;
        const sign = arc > 0 ? 1 : -1;
        for (const { idx, cx } of spans) {
          for (const i of idx) {
            const dx = pos[i].x + pos[i].w / 2 - cx;
            const a = dx / R;
            const dy = R * (1 - Math.cos(a));
            maxDy = Math.max(maxDy, dy);
            tf[i] = `translateY(${(sign * dy).toFixed(2)}px) rotate(${(sign * a * 180 / Math.PI).toFixed(3)}deg)`;
          }
        }
      }

      // la courbe déborde du bloc : on réserve la place pour ne pas chevaucher le sous-titre
      const room = maxDy > 0 ? `${Math.round(maxDy + size * 0.12)}px` : '0px';
      const mb = arc > 0 ? room : '0px', mt = arc < 0 ? room : '0px';
      if (ts.marginBottom !== mb) ts.marginBottom = mb;
      if (ts.marginTop !== mt) ts.marginTop = mt;

      for (const slots of slotsByLayer) {
        for (let i = 0; i < slots.length && i < n; i++) {
          const sl = slots[i];
          sl.style.setProperty('--bx', `${-pos[i].x}px`);
          sl.style.setProperty('--by', `${-pos[i].y}px`);
          if (sl.style.transform !== tf[i]) sl.style.transform = tf[i];
        }
      }

      // keyframes propres à cette instance (reflet, défilement)
      const mw = this.motion.offsetWidth;
      const spd = Math.max(0.1, st.speed);
      let css = `@keyframes pc-sh-${this.uid}{0%{--shift:${-bw}px}55%,100%{--shift:${bw}px}}`;
      css += `@keyframes pc-mq-${this.uid}{from{transform:translateX(${this.cw}px)}to{transform:translateX(${-mw}px)}}`;
      if (this.css.textContent !== css) this.css.textContent = css;
      const shineAnim = st.shine ? `pc-sh-${this.uid} ${(3.4 / spd).toFixed(2)}s ease-in-out infinite` : '';
      if (this.layers[2].style.animation !== shineAnim) this.layers[2].style.animation = shineAnim;
      const mqAnim = st.anim === 'marquee' && !this.opts.fit ? `pc-mq-${this.uid} ${((this.cw + mw) / (240 * spd)).toFixed(2)}s linear infinite` : '';
      if (this.motion.style.animation !== mqAnim) this.motion.style.animation = mqAnim;

      // largeur max avant retour à la ligne
      ts.setProperty('--maxw', this.opts.fit || st.anim === 'marquee' ? 'none' : `${Math.round(this.cw * 0.92)}px`);

      // vignettes : tout faire tenir dans le cadre
      if (this.opts.fit) {
        const bwid = this.motion.offsetWidth, bhei = this.motion.offsetHeight;
        const k = Math.min(1.5, (this.cw * 0.84) / bwid, (this.ch * 0.72) / bhei);
        this.canvas.style.setProperty('--fit', k.toFixed(3));
      }
    }

    // boîte du bloc de texte en coordonnées du canevas (pour le glisser-déposer)
    blockRect() {
      return { w: this.motion.offsetWidth, h: this.motion.offsetHeight };
    }
  }

  window.Pancarte = { Renderer, FONTS, SUB_FONTS, LOOKS, FILL_PRESETS, DEFAULT_STATE, DEFAULT_STYLE, CANVAS_W, merge, clone, fontOf, fmtTime };
})();
