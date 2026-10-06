// Module Caméra — backend, chargé dans le processus principal de Régie.
// Serveur HTTPS sur le réseau local : il sert la page à ouvrir sur l'iPhone et relaie la signalisation WebRTC
// entre le téléphone (qui envoie sa caméra) et les calques de Régie (qui la reçoivent). La vidéo, elle,
// circule directement du téléphone vers Régie (WebRTC), sans passer par ce serveur.
//
//  téléphone : POST /api/hello → id   GET /api/events (SSE : viewer, answer, bye, active, config, kicked)
//              POST /api/offer, /api/info, /api/config, /api/gone, /api/bye
//  calques   : bridge.call('join' | 'answer' | 'leave' | 'setActive')   bridge.on('offer')
//  éditeur   : bridge.call('start' | 'status' | 'qr' | 'command' | 'configure')   bridge.on('status')
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const QR = require('qrcode/lib/core/qrcode');
const { makeCert, certCovers } = require('./cert');

const PHONE_DIR = path.join(__dirname, '..', 'phone');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/phone.js': ['phone.js', 'text/javascript; charset=utf-8'],
  '/i18n.js': ['i18n.js', 'text/javascript; charset=utf-8'],
  '/en.js': ['en.js', 'text/javascript; charset=utf-8'],
  '/phone.css': ['phone.css', 'text/css; charset=utf-8'],
  '/icon.png': [path.join('..', '..', 'assets', 'icon.png'), 'image/png'],
};
// cartes réseau virtuelles (machines virtuelles, WSL, VPN…) : l'iPhone ne peut pas les joindre
const VIRTUAL = /vEthernet|VirtualBox|VMware|WSL|Hyper-V|Loopback|Bluetooth|VPN|Wintun|TAP|ZeroTier|Tailscale|Hamachi|Docker|vboxnet/i;
const PRIVATE = /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/;

function addresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if ((a.family !== 'IPv4' && a.family !== 4) || a.internal || a.address.startsWith('169.254.')) continue;
      out.push({ name, ip: a.address, virtual: VIRTUAL.test(name) });
    }
  }
  const rank = (a) => (a.virtual ? 2 : 0) + (PRIVATE.test(a.ip) ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e6) { reject(new Error('trop gros')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

module.exports = function backend(ctx) {
  // messages affichés dans Régie, dans la langue de l'interface (ceux destinés au téléphone sont traduits par sa page)
  const L = (fr, en) => (ctx.lang && ctx.lang() === 'en' ? en : fr);
  const configFile = path.join(ctx.dataDir, 'config.json');
  // host : interface d'écoute ('0.0.0.0' = tout le réseau local ; '127.0.0.1' = ce PC seulement)
  let config = { port: 8443, httpPort: 8080, host: '0.0.0.0', facing: 'user', quality: '1080', ip: null, key: null };
  try { config = { ...config, ...JSON.parse(fs.readFileSync(configFile, 'utf8')) }; } catch { /* premier lancement */ }
  if (!config.key) config.key = crypto.randomBytes(4).toString('hex'); // à mettre dans l'URL : protège des autres appareils du réseau
  const saveConfig = () => { try { fs.writeFileSync(configFile, JSON.stringify(config, null, 1)); } catch (e) { ctx.log(e); } };
  saveConfig();

  let server = null;
  let redirect = null;
  let starting = null;
  let error = null;
  let httpError = null;
  let phone = null; // { id, sse, info, lost }
  const viewers = new Map(); // id -> { quality: 'full' | 'preview', active }

  const chosenIp = (list = addresses()) => (list.find((a) => a.ip === config.ip) || list[0] || { ip: '127.0.0.1' }).ip;

  function snapshot() {
    const list = addresses();
    const ip = chosenIp(list);
    return {
      running: !!server,
      starting: !!starting,
      error,
      httpError,
      port: config.port,
      httpPort: config.httpPort,
      addresses: list,
      ip,
      key: config.key,
      url: `https://${ip}:${config.port}/?k=${config.key}`,
      httpUrl: `http://${ip}:${config.httpPort}`,
      phone: phone ? { connected: !!phone.sse, info: phone.info } : null,
      viewers: viewers.size,
      facing: config.facing,
      quality: config.quality,
    };
  }
  const notify = () => ctx.emit('status', snapshot());

  function send(msg) {
    if (phone && phone.sse) phone.sse.write(`data: ${JSON.stringify(msg)}\n\n`);
  }

  // ---------- serveur ----------
  function loadTls(ips) {
    const keyFile = path.join(ctx.dataDir, 'key.pem');
    const certFile = path.join(ctx.dataDir, 'cert.pem');
    try {
      const cert = fs.readFileSync(certFile, 'utf8');
      if (certCovers(cert, ips)) return { key: fs.readFileSync(keyFile, 'utf8'), cert };
    } catch { /* à créer */ }
    // nouvelle adresse (autre réseau) : nouveau certificat, l'iPhone devra l'accepter à nouveau
    const host = os.hostname().toLowerCase().replace(/[^a-z0-9-]/g, '');
    const c = makeCert({ dns: ['localhost', ...(host ? [host, `${host}.local`] : [])], ips });
    fs.writeFileSync(keyFile, c.key);
    fs.writeFileSync(certFile, c.cert);
    return c;
  }

  function start() {
    if (server) return Promise.resolve();
    if (starting) return starting;
    starting = new Promise((resolve) => {
      error = null;
      const done = () => { starting = null; resolve(); notify(); };
      let tls;
      try { tls = loadTls(['127.0.0.1', ...addresses().map((a) => a.ip)]); } catch (e) { error = `${L('Certificat', 'Certificate')} : ${e.message}`; done(); return; }
      const s = https.createServer(tls, (req, res) => { handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); }); });
      s.once('error', (e) => {
        error = e.code === 'EADDRINUSE'
          ? L(`Le port ${config.port} est déjà pris par une autre application`, `Port ${config.port} is already used by another application`)
          : e.message;
        done();
      });
      s.listen(config.port, config.host, () => {
        server = s;
        startRedirect();
        ctx.log(`serveur prêt : ${snapshot().url}`);
        done();
      });
    });
    return starting;
  }

  // http://… (plus simple à taper) renvoie vers la page https://…
  function startRedirect() {
    httpError = null;
    const r = http.createServer((req, res) => {
      const host = (req.headers.host || '').replace(/:\d+$/, '') || chosenIp();
      const url = new URL(req.url, 'http://x');
      if (!url.searchParams.has('k')) url.searchParams.set('k', config.key);
      res.writeHead(301, { Location: `https://${host}:${config.port}${url.pathname}${url.search}` });
      res.end();
    });
    r.once('error', (e) => {
      httpError = e.code === 'EADDRINUSE' ? L(`port ${config.httpPort} déjà pris`, `port ${config.httpPort} already in use`) : e.message;
      notify();
    });
    r.listen(config.httpPort, config.host, () => { redirect = r; });
  }

  function stop() {
    for (const s of [server, redirect]) {
      if (!s) continue;
      s.close();
      if (s.closeAllConnections) s.closeAllConnections();
    }
    server = null;
    redirect = null;
    if (phone) clearTimeout(phone.lost);
    phone = null;
  }

  // ---------- requêtes du téléphone ----------
  async function handle(req, res) {
    const url = new URL(req.url, 'https://x');
    res.setHeader('Cache-Control', 'no-store');
    const file = req.method === 'GET' && STATIC[url.pathname];
    if (file) {
      const body = await fs.promises.readFile(path.join(PHONE_DIR, file[0]));
      res.writeHead(200, { 'Content-Type': file[1] });
      res.end(body);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/events') { events(req, res, url.searchParams.get('id')); return; }
    if (req.method !== 'POST' || !url.pathname.startsWith('/api/')) { res.writeHead(404); res.end(); return; }

    const body = await readJson(req);
    const reply = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data || {})); };
    if (url.pathname === '/api/hello') {
      if (body.key !== config.key) { reply(403, { error: 'Code incorrect : scanne le QR code affiché dans Régie.' }); return; }
      if (phone && phone.sse) { send({ type: 'kicked' }); phone.sse.end(); }
      if (phone) clearTimeout(phone.lost);
      phone = { id: crypto.randomBytes(12).toString('hex'), sse: null, info: body.info || null, lost: null };
      notify();
      reply(200, { id: phone.id, facing: config.facing, quality: config.quality });
      return;
    }
    if (!phone || body.id !== phone.id) { reply(410, { error: 'session terminée' }); return; }
    switch (url.pathname) {
      case '/api/offer':
        if (viewers.has(body.viewer)) ctx.emit('offer', { viewer: body.viewer, sdp: String(body.sdp || '') });
        break;
      case '/api/info':
        phone.info = body.info || null;
        notify();
        break;
      case '/api/config': // réglage changé depuis le téléphone
        applyConfig(body, false);
        break;
      case '/api/gone': // un calque n'a jamais répondu : page fermée entre-temps
        viewers.delete(body.viewer);
        notify();
        break;
      case '/api/bye':
        clearTimeout(phone.lost);
        phone = null;
        notify();
        break;
      default:
        reply(404);
        return;
    }
    reply(200);
  }

  function events(req, res, id) {
    if (!phone || id !== phone.id) { res.writeHead(410); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(': ok\n\n');
    if (phone.sse && phone.sse !== res) phone.sse.end();
    phone.sse = res;
    clearTimeout(phone.lost);
    for (const [viewer, v] of viewers) send({ type: 'viewer', viewer, ...v });
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => {
      clearInterval(ping);
      if (!phone || phone.sse !== res) return;
      phone.sse = null;
      // simple coupure (Safari en arrière-plan…) : on garde la session un moment
      const p = phone;
      p.lost = setTimeout(() => { if (phone === p && !p.sse) { phone = null; notify(); } }, 30000);
      notify();
    });
    notify();
  }

  function applyConfig(patch, fromRegie) {
    let changed = false;
    if (patch.facing === 'user' || patch.facing === 'environment') { changed = changed || config.facing !== patch.facing; config.facing = patch.facing; }
    if (patch.quality === '720' || patch.quality === '1080') { changed = changed || config.quality !== patch.quality; config.quality = patch.quality; }
    if (!changed) return;
    saveConfig();
    if (fromRegie) send({ type: 'config', facing: config.facing, quality: config.quality });
    notify();
  }

  // ---------- méthodes appelées par les pages du module (bridge.call) ----------
  return {
    status: () => snapshot(),
    async start() { await start(); return snapshot(); },

    // un calque veut recevoir la caméra du téléphone (quality : full pour la sortie, preview pour les aperçus)
    async join(viewer, opts = {}) {
      const v = { quality: opts.quality === 'full' ? 'full' : 'preview', active: opts.active !== false };
      viewers.set(String(viewer), v);
      await start();
      send({ type: 'viewer', viewer: String(viewer), ...v });
      notify();
      return snapshot();
    },
    answer(viewer, sdp) { send({ type: 'answer', viewer: String(viewer), sdp: String(sdp || '') }); },
    leave(viewer) {
      if (!viewers.delete(String(viewer))) return;
      send({ type: 'bye', viewer: String(viewer) });
      notify();
    },
    // la sortie n'est pas à l'écran : le téléphone arrête d'encoder pour elle
    setActive(viewer, active) {
      const v = viewers.get(String(viewer));
      if (!v || v.active === !!active) return;
      v.active = !!active;
      send({ type: 'active', viewer: String(viewer), active: v.active });
    },

    command(patch) { applyConfig(patch || {}, true); return snapshot(); },
    async configure(patch = {}) {
      const port = (v) => Number.isInteger(v) && v >= 1024 && v <= 65535;
      let restart = false;
      if (port(patch.port) && patch.port !== config.port) { config.port = patch.port; restart = true; }
      if (port(patch.httpPort) && patch.httpPort !== config.httpPort) { config.httpPort = patch.httpPort; restart = true; }
      if (typeof patch.ip === 'string') config.ip = patch.ip;
      saveConfig();
      if (restart && (server || starting)) { await starting; stop(); await start(); }
      notify();
      return snapshot();
    },

    // QR code → tracé SVG d'une case par module sombre
    qr(text) {
      const m = QR.create(String(text), { errorCorrectionLevel: 'M' }).modules;
      let d = '';
      for (let y = 0; y < m.size; y++) for (let x = 0; x < m.size; x++) if (m.get(y, x)) d += `M${x} ${y}h1v1h-1z`;
      return { size: m.size, path: d };
    },

    dispose: stop,
  };
};
