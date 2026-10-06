// Module Musique en cours — backend, chargé dans le processus principal de SceneCue.
// Lit le morceau joué par Spotify (application pour PC) dans les contrôles multimédias de Windows, sans compte
// ni clé d'API : un Windows PowerShell en arrière-plan (smtc.ps1) écrit l'état toutes les 500 ms.
// Il ne tourne que tant qu'une page du module le demande (watch, renouvelé toutes les 20 s).
//
//  pages : bridge.call('watch') → { ok, error, track }   bridge.on('track', { ok, error, track })
//  track : { title, artist, album, playing, position, duration, at, cover }   (position en ms à l'instant at)
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const SCRIPT = path.join(__dirname, 'smtc.ps1');
const LEASE_MS = 60000; // sans nouvelle d'une page pendant ce temps, PowerShell est arrêté
const DRIFT_MS = 1500; // écart de position au-delà duquel on prévient les pages (avance, retour en arrière)

module.exports = function backend(ctx) {
  const L = (fr, en) => (ctx.lang && ctx.lang() === 'en' ? en : fr);
  let ps = null;
  let buf = '';
  let stderr = '';
  let lease = 0;
  let leaseTimer = null;
  let restartTimer = null;
  let failures = 0;
  let error = null;
  let track = null;
  let cover = null; // data: URL de la pochette du morceau en cours
  let raw = null; // position et horodatage bruts de la ligne précédente

  const snapshot = () => ({ ok: !!ps && !error, error, track });
  const notify = () => ctx.emit('track', snapshot());

  // PowerShell lit un vrai fichier : on recopie le script hors de app.asar (avec BOM, pour les accents)
  function scriptFile() {
    const dest = path.join(ctx.dataDir, 'smtc.ps1');
    const src = '\ufeff' + fs.readFileSync(SCRIPT, 'utf8').replace(/^\ufeff/, '');
    let cur = null;
    try { cur = fs.readFileSync(dest, 'utf8'); } catch { /* première fois */ }
    if (cur !== src) fs.writeFileSync(dest, src);
    return dest;
  }

  function start() {
    if (ps || restartTimer) return;
    if (process.platform !== 'win32') { error = L('Disponible sous Windows seulement', 'Windows only'); return; }
    let file;
    try { file = scriptFile(); } catch (e) { error = e.message; return; }
    const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    buf = '';
    stderr = '';
    const p = spawn(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    ps = p;
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try { onLine(JSON.parse(line)); } catch (e) { ctx.log('ligne illisible', e.message); }
      }
    });
    p.stderr.setEncoding('utf8');
    p.stderr.on('data', (c) => { stderr = (stderr + c).slice(-2000); });
    // impossible à lancer : 'exit' ne vient pas toujours, on libère la place pour le prochain watch
    p.on('error', (e) => {
      ctx.log(e);
      if (ps !== p) return;
      ps = null;
      error = `${L('Windows PowerShell ne se lance pas', "Windows PowerShell won't start")} (${e.message})`;
      notify();
    });
    p.on('exit', (code) => {
      if (ps !== p) return;
      ps = null;
      if (Date.now() > lease) return; // arrêt voulu ou plus personne pour écouter
      // arrêt imprévu : on relance, de moins en moins souvent
      failures++;
      const msg = stderr.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      ctx.log(`PowerShell arrêté (code ${code})`, msg || '');
      if (failures >= 3) {
        error = L('Windows ne donne pas accès au lecteur en cours', "Windows doesn't give access to the current player") + (msg ? ` (${msg})` : '');
        notify();
      }
      restartTimer = setTimeout(() => { restartTimer = null; if (Date.now() < lease) start(); }, Math.min(30000, 2000 * failures));
    });
  }

  function stop() {
    clearTimeout(restartTimer);
    restartTimer = null;
    if (ps) { const p = ps; ps = null; p.kill(); }
    track = null; // plus personne n'écoute : pas d'état périmé au prochain démarrage
    cover = null;
    raw = null;
  }

  // position attendue maintenant, d'après le dernier état envoyé
  const expected = (t, now) => (t.playing ? t.position + (now - t.at) : t.position);

  function onLine(m) {
    if (m.error) {
      // erreur passagère (Spotify qui se ferme pendant la lecture…) : on garde l'état précédent
      ctx.log('SMTC :', m.error);
      return;
    }
    failures = 0;
    const hadError = !!error;
    error = null;
    if (!m.app) {
      cover = null;
      raw = null;
      if (track || hadError) { track = null; notify(); }
      return;
    }
    if (Object.prototype.hasOwnProperty.call(m, 'cover')) cover = m.cover ? `data:${coverType(m.cover)};base64,${m.cover}` : null;
    const now = Date.now();
    const playing = m.status === 'Playing';
    // Instant où la position était juste : l'horodatage de Windows (une application peut ne publier sa position
    // qu'aux changements), sauf si la position avance sans que l'horodatage bouge : elle est alors fraîche.
    const prev = raw;
    raw = { position: m.position, updated: m.updated };
    const stamped = m.updated > 0 && !(prev && prev.updated === m.updated && prev.position !== m.position);
    const at = playing && stamped ? Math.min(m.updated, now) : now;
    const next = {
      title: String(m.title || ''),
      artist: String(m.artist || ''),
      album: String(m.album || ''),
      playing,
      position: Math.max(0, +m.position || 0),
      duration: Math.max(0, +m.duration || 0),
      at,
      cover,
    };
    const t = track;
    const changed = !t || hadError
      || t.title !== next.title || t.artist !== next.artist || t.album !== next.album
      || t.playing !== next.playing || t.duration !== next.duration || t.cover !== next.cover
      || Math.abs(expected(t, now) - expected(next, now)) > DRIFT_MS;
    if (!changed) return;
    track = next;
    notify();
  }

  const coverType = (b64) => (b64.startsWith('/9j/') ? 'image/jpeg' : 'image/png');

  function watch() {
    lease = Date.now() + LEASE_MS;
    clearTimeout(leaseTimer);
    leaseTimer = setTimeout(() => { if (Date.now() >= lease) stop(); }, LEASE_MS + 100);
    start();
    return snapshot();
  }

  return {
    watch,
    status: () => snapshot(),
    dispose() { lease = 0; clearTimeout(leaseTimer); stop(); },
  };
};
