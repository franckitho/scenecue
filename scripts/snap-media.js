// Vérification du module « Image / vidéo » : lance SceneCue avec un profil temporaire, fabrique des médias de test
// (vidéo enregistrée à la volée, PNG animé, image fixe), joue un scénario et enregistre captures + mesures.
// L'overlay est rendu invisible (opacité 0) : rien ne s'affiche réellement à l'écran pendant le test.
// Usage : npx electron scripts/snap-media.js <dossier-de-sortie>
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

const out = path.resolve(process.argv[process.argv.length - 1]);
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(out, 'userdata'));
app.commandLine.appendSwitch('lang', 'fr-FR'); // le scénario vérifie les textes français (SceneCue est en anglais par défaut)
setTimeout(() => { console.error('délai dépassé'); app.exit(1); }, 180000);
process.on('unhandledRejection', (e) => {
  console.error('ÉCHEC DU SCÉNARIO :', e);
  console.error(results.join('\n'));
  console.error(logs.slice(-15).join('\n'));
  app.exit(1);
});

require(process.env.SCENECUE_MAIN || '../src/main.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const logs = [];
const results = [];
const check = (name, ok, detail = '') => { results.push(`${ok ? 'OK  ' : 'ÉCHEC'} ${name}${detail ? ` — ${detail}` : ''}`); };
app.on('web-contents-created', (_e, wc) => {
  wc.setAudioMuted(true); // test silencieux : la vidéo de test contient un bip
  wc.on('console-message', (ev) => logs.push(`[${wc.getURL().split('/').slice(-1)[0]}] ${ev.level ?? ''} ${ev.message ?? ev}`));
});

// ---------- PNG / APNG ----------
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (buf) => { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function idat(w, h, px) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) px.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  return zlib.deflateSync(raw);
}
function ihdr(w, h) { const b = Buffer.alloc(13); b.writeUInt32BE(w, 0); b.writeUInt32BE(h, 4); b[8] = 8; b[9] = 6; return b; }
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function paint(w, h, fn) {
  const px = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px.set(fn(x / w, y / h), (y * w + x) * 4);
  return px;
}
function png(w, h, fn) {
  return Buffer.concat([SIG, chunk('IHDR', ihdr(w, h)), chunk('IDAT', idat(w, h, paint(w, h, fn))), chunk('IEND', Buffer.alloc(0))]);
}
function apng(w, h, n, delayMs, fn) {
  const parts = [SIG, chunk('IHDR', ihdr(w, h))];
  const actl = Buffer.alloc(8); actl.writeUInt32BE(n, 0); actl.writeUInt32BE(0, 4);
  parts.push(chunk('acTL', actl));
  let seq = 0;
  for (let i = 0; i < n; i++) {
    const fc = Buffer.alloc(26);
    fc.writeUInt32BE(seq++, 0); fc.writeUInt32BE(w, 4); fc.writeUInt32BE(h, 8);
    fc.writeUInt16BE(delayMs, 20); fc.writeUInt16BE(1000, 22); fc[24] = 1; fc[25] = 0;
    parts.push(chunk('fcTL', fc));
    const data = idat(w, h, paint(w, h, (x, y) => fn(x, y, i)));
    if (i === 0) parts.push(chunk('IDAT', data));
    else { const s = Buffer.alloc(4); s.writeUInt32BE(seq++); parts.push(chunk('fdAT', Buffer.concat([s, data]))); }
  }
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

// ---------- vidéo : enregistrée dans une fenêtre cachée (compteur d'images + bip) ----------
async function recordVideo(mime) {
  const w = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  await w.loadURL('data:text/html,<canvas width=640 height=360></canvas>');
  const b64 = await w.webContents.executeJavaScript(`(async () => {
    const mime = ${JSON.stringify(mime)};
    if (!MediaRecorder.isTypeSupported(mime)) return null;
    const cv = document.querySelector('canvas'), ctx = cv.getContext('2d');
    const ac = new AudioContext(), osc = ac.createOscillator(), dst = ac.createMediaStreamDestination();
    osc.frequency.value = 440; osc.connect(dst); osc.start();
    // fenêtre cachée : pas de requestAnimationFrame, on pousse chaque image à la main (30 i/s)
    const track = cv.captureStream(0).getVideoTracks()[0];
    const stream = new MediaStream([track, ...dst.stream.getAudioTracks()]);
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2e6 });
    const chunks = []; rec.ondataavailable = (e) => chunks.push(e.data);
    const t0 = performance.now();
    const draw = () => {
      const t = (performance.now() - t0) / 1000;
      ctx.fillStyle = 'hsl(' + (t * 120) + ' 70% 45%)'; ctx.fillRect(0, 0, 640, 360);
      ctx.fillStyle = '#fff'; ctx.fillRect(20 + t * 190, 300, 30, 30);
      ctx.font = 'bold 150px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(t.toFixed(1), 320, 220);
      track.requestFrame();
    };
    draw();
    rec.start(100);
    const timer = setInterval(draw, 1000 / 30);
    await new Promise((r) => setTimeout(r, 3100));
    clearInterval(timer);
    rec.stop(); osc.stop();
    await new Promise((r) => { rec.onstop = r; });
    const buf = await new Blob(chunks).arrayBuffer();
    let s = ''; const u = new Uint8Array(buf);
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(s);
  })()`);
  w.destroy();
  return b64 ? Buffer.from(b64, 'base64') : null;
}

app.whenReady().then(async () => {
  const media = path.join(out, 'media-src');
  fs.mkdirSync(media, { recursive: true });
  const files = {};
  files.png = path.join(media, 'logo fixe.png');
  fs.writeFileSync(files.png, png(400, 300, (x, y) => [255 * x, 120, 255 * y, 255]));
  files.apng = path.join(media, 'balle.png');
  fs.writeFileSync(files.apng, apng(160, 160, 12, 80, (x, y, i) => {
    const cx = 0.2 + 0.6 * (i / 11), d = Math.hypot(x - cx, y - 0.5);
    return d < 0.15 ? [255, 77, 31, 255] : [0, 0, 0, 0];
  }));
  const mp4 = await recordVideo('video/mp4;codecs=avc1.42E01E,mp4a.40.2');
  const webm = await recordVideo('video/webm;codecs=vp8,opus');
  if (mp4) fs.writeFileSync(files.mp4 = path.join(media, 'compteur.mp4'), mp4);
  if (webm) fs.writeFileSync(files.webm = path.join(media, 'compteur.webm'), webm);
  check('vidéos de test enregistrées', !!(mp4 || webm), `mp4 ${mp4 ? mp4.length : 'non'}, webm ${webm ? webm.length : 'non'}`);
  const video = files.mp4 || files.webm;

  await wait(3500);
  const wins = BrowserWindow.getAllWindows();
  const isOverlay = (w) => w.webContents.getURL().includes('mode=overlay');
  const main = wins.find((w) => w.webContents.getURL().includes('/src/renderer/index.html'));
  const overlay = wins.find(isOverlay);
  overlay.setOpacity(0);
  // la fenêtre de test peut être recouverte : Chromium mettrait alors en pause les vidéos muettes de l'aperçu
  main.webContents.setBackgroundThrottling(false);
  const save = async (w, name) => fs.writeFileSync(path.join(out, `${name}.png`), (await w.webContents.capturePage()).toPNG());
  const js = (code) => main.webContents.executeJavaScript(code).catch((e) => { throw new Error(`${e.message}\n  dans : ${code.slice(0, 300)}`); });
  // évalue dans une iframe (variables globales du script de la page accessibles)
  const inFrame = (wc, part, code) => {
    const f = wc.mainFrame.framesInSubtree.filter((x) => x.url.includes(part)).pop();
    if (!f) return Promise.resolve(null);
    return f.executeJavaScript(code).catch((e) => { throw new Error(`${e.message}\n  dans ${part} : ${code.slice(0, 300)}`); });
  };
  const pjs = (code) => inFrame(main.webContents, 'media/src/renderer/index.html', code);
  const ojs = (code) => inFrame(overlay.webContents, 'media/src/renderer/layer.html', code);
  const dbgP = () => pjs(`JSON.stringify({ audio: player.audio, on: player.on, showing: player.showing, active: player.active, raf: player.raf, phase: player.phase, engine: player.engine, mode: player.state.mode, sound: player.state.sound, muted: player.src && player.src.el && player.src.el.muted, paused: player.src && player.src.el && player.src.el.paused, t: player.currentTime(), rs: player.src && player.src.el && player.src.el.readyState, err: player.src && player.src.el && player.src.el.error && player.src.el.error.message })`);
  const dbgO = () => ojs(`JSON.stringify({ audio: player.audio, on: player.on, showing: player.showing, active: player.active, raf: player.raf, phase: player.phase, engine: player.engine, mode: player.state.mode, sound: player.state.sound, muted: player.src && player.src.el && player.src.el.muted, paused: player.src && player.src.el && player.src.el.paused, t: player.currentTime() })`);
  const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await wait(150); } return false; };
  const importFile = async (file) => {
    const m = await js(`host.importMedia(${JSON.stringify(file)})`);
    await pjs(`useMedia(${JSON.stringify(m)})`);
    await until(() => pjs('!info.loading && (!!info.kind || !!info.error)'));
    return m;
  };

  // nouvelle scène (vide) → ajout du module depuis le catalogue
  await js(`document.querySelector('#add-scene').click()`);
  await wait(800);
  await js(`document.activeElement && document.activeElement.blur()`);
  await wait(300);
  const card = await js(`(() => { const c = [...document.querySelectorAll('#catalog .mod-card')].find((b) => b.textContent.includes('Image / vidéo')); if (c) c.click(); return !!c; })()`);
  check('module listé dans le catalogue', card);
  await wait(2500);
  await save(main, '01-vide');
  check('zone d\'import affichée sans média', await pjs(`!document.querySelector('#pick').hidden`));

  // vidéo
  const mv = await importFile(video);
  const vinfo = await pjs('JSON.stringify(info)');
  check('vidéo chargée', await pjs(`info.kind === 'video' && info.duration > 2.5`), vinfo);
  check('calque renommé d\'après le fichier', (await js(`[...document.querySelectorAll('#layers .row-name')].map((n) => n.textContent).join('|')`)).includes('compteur'));
  const range = await pjs(`fetch(state.media.url, { headers: { Range: 'bytes=10-109' } }).then(async (r) => r.status + ' ' + (await r.arrayBuffer()).byteLength + ' ' + r.headers.get('content-range'))`);
  check('requêtes partielles (Range)', range.startsWith('206 100 bytes 10-109/'), range);
  const seek = await pjs(`new Promise((res) => { const v = player.src.el; v.addEventListener('seeked', () => res(v.currentTime.toFixed(2)), { once: true }); v.currentTime = 1.5; })`);
  check('déplacement dans la vidéo', Math.abs(seek - 1.5) < 0.2, seek);
  await wait(1200);
  await save(main, '02-video-boucle');

  // à l'écran
  await js(`document.querySelector('#onair').click()`);
  await wait(2500);
  await save(overlay, '03-overlay-video');
  check('overlay : vidéo en lecture', await ojs(`player.engine === 'video' && !player.src.el.paused`));
  await pjs(`document.querySelector('.switch[data-bind="sound"]').click()`);
  await until(() => ojs(`player.src.el.muted === false`), 3000);
  check('son : sort à l\'écran', await ojs(`player.src.el.muted === false`), await dbgO());
  check('son : aperçu muet', await pjs(`player.src.el.muted === true`));
  await pjs(`document.querySelector('#listen').click()`);
  await wait(200);
  check('son : « Écouter » dans l\'aperçu', await pjs(`player.src.el.muted === false`), await dbgP());
  await pjs(`document.querySelector('#listen').click()`);

  // boomerang, mesuré sur la sortie (l'aperçu ralentit si la fenêtre SceneCue est recouverte)
  const sample = async (n) => {
    const s = [];
    for (let i = 0; i < n; i++) {
      s.push(await ojs(`[player.engine, player.dir, +(player.currentTime() || 0).toFixed(2), player.frames.length].join(',')`));
      await wait(200);
    }
    return s;
  };
  await pjs(`document.querySelector('[data-bind="mode"] [data-v="bounce"]').click()`);
  const samples = await sample(50);
  fs.writeFileSync(path.join(out, 'boomerang.txt'), samples.join('\n'));
  results.push(`  panneau : ${await dbgP()}`);
  const back = samples.filter((s) => s.startsWith('cache,-1'));
  const fwdCache = samples.filter((s) => s.startsWith('cache,1'));
  check('boomerang : retour en arrière', back.length > 3, `${back.length} mesures à l'envers`);
  check('boomerang : repart à l\'endroit depuis la mémoire', fwdCache.length > 3, `${fwdCache.length} mesures`);
  check('boomerang : images mémorisées', +samples[samples.length - 1].split(',')[3] > 30, samples[samples.length - 1]);
  check('boomerang : muet', await ojs(`player.src.el.muted === true`));
  // sans requestVideoFrameCallback : capture de secours
  await ojs(`player.src.el.requestVideoFrameCallback = () => 0; player.clearFrames(); player.restart();`);
  const fb = await sample(30);
  check('boomerang : capture de secours', fb.some((s) => s.startsWith('cache,-1')) && +fb[fb.length - 1].split(',')[3] > 30, fb[fb.length - 1]);
  await ojs(`delete player.src.el.requestVideoFrameCallback`);
  await save(main, '04-boomerang');
  await save(overlay, '05-overlay-boomerang');

  // une fois, puis disparaître
  await pjs(`document.querySelector('[data-bind="mode"] [data-v="once"]').click(); document.querySelector('[data-bind="end"] [data-v="hide"]').click();`);
  await wait(1000);
  check('une fois : en lecture', await ojs(`player.phase === 'play'`));
  await until(() => ojs(`player.phase === 'done'`), 6000);
  await wait(600);
  check('une fois : disparaît à la fin', await ojs(`player.canvas.classList.contains('md-hidden') && player.src.el.paused`));

  // découpe + 2 passages avec pause
  await pjs(`state.mode = 'loop'; state.repeat = 2; state.gap = 1; state.end = 'hold'; state.trimA = 1; state.trimB = 2; sync(); commit();`);
  await wait(300);
  await save(main, '06-decoupe');
  const t1 = await pjs(`player.currentTime()`);
  check('découpe : démarre au début choisi', t1 >= 0.95 && t1 < 1.6, String(t1));
  await wait(1500);
  check('pause entre deux passages', await pjs(`player.phase === 'gap' && player.passes === 1`), await pjs(`player.phase + ' ' + player.passes`));
  await until(() => pjs(`player.phase === 'done'`), 5000);
  const tEnd = await pjs(`player.currentTime()`);
  check('2 passages puis figé sur la fin', await pjs(`player.passes === 2`) && tEnd > 1.8 && tEnd < 2.2, String(tEnd));

  // déplacer à la souris, redimensionner par le coin
  await pjs(`state.fit = 'free'; state.x = 0.5; state.y = 0.5; state.size = 0.4; state.rotate = 0; state.repeat = 0; state.gap = 0; sync(); commit();`);
  await wait(300);
  // rectangle du média, en coordonnées de la fenêtre SceneCue
  const boxRect = async () => {
    const o = await js(`(() => { const r = document.querySelector('#panel').getBoundingClientRect(); return { x: r.left, y: r.top }; })()`);
    const b = await pjs(`(() => { const r = player.box.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
    return { x: o.x + b.x, y: o.y + b.y, w: b.w, h: b.h };
  };
  const box = await boxRect();
  const mouse = async (type, x, y, down = false) => main.webContents.sendInputEvent({
    type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, modifiers: down ? ['leftButtonDown'] : [],
  });
  const drag = async (x0, y0, x1, y1) => {
    await mouse('mouseMove', x0, y0); await mouse('mouseDown', x0, y0, true);
    for (let i = 1; i <= 8; i++) { await mouse('mouseMove', x0 + ((x1 - x0) * i) / 8, y0 + ((y1 - y0) * i) / 8, true); await wait(40); }
    await wait(150); await mouse('mouseUp', x1, y1); await wait(200);
  };
  await drag(box.x + box.w / 2, box.y + box.h / 2, box.x + box.w / 2 + 120, box.y + box.h / 2 - 40);
  check('glisser déplace le média', await pjs(`state.x > 0.6 && state.y < 0.47`), await pjs(`state.x + ',' + state.y`));
  const box2 = await boxRect();
  await mouse('mouseMove', box2.x + box2.w / 2, box2.y + box2.h / 2);
  await wait(200);
  await drag(box2.x + box2.w - 2, box2.y + box2.h - 2, box2.x + box2.w + 60, box2.y + box2.h + 34);
  check('le coin redimensionne', await pjs(`state.size > 0.5`), await pjs(`String(state.size)`));
  check('fin du geste détectée', await pjs(`!frame.classList.contains('resizing')`));
  await save(main, '07-deplace');

  // PNG animé
  await importFile(files.apng);
  check('PNG animé décodé image par image', await pjs(`info.kind === 'anim' && info.frames === 12 && Math.abs(info.duration - 0.96) < 0.01`), await pjs('JSON.stringify(info)'));
  await pjs(`document.querySelector('[data-bind="mode"] [data-v="bounce"]').click()`);
  const animDirs = new Set();
  for (let i = 0; i < 12; i++) { animDirs.add(await pjs('player.dir')); await wait(100); }
  check('PNG animé en boomerang', animDirs.has(1) && animDirs.has(-1));
  await save(main, '08-png-anime');

  // image fixe importée sans chemin (comme un fichier glissé depuis un navigateur)
  const b64 = fs.readFileSync(files.png).toString('base64');
  await pjs(`importWith(api.importMedia(new File([Uint8Array.from(atob(${JSON.stringify(b64)}), (c) => c.charCodeAt(0))], 'logo fixe.png', { type: 'image/png' })))`);
  await until(() => pjs(`!!state.media && state.media.name === 'logo fixe.png' && info.kind === 'image'`));
  check('import par contenu (sans chemin)', await pjs(`info.kind === 'image' && info.w === 400`));
  await pjs(`state.radius = 12; state.shadow = true; state.rotate = -8; state.motion = 'float'; sync(); commit();`);
  await wait(800);
  await save(main, '09-image-fixe');
  await save(overlay, '10-overlay-image');

  // plein écran
  await pjs(`document.querySelector('[data-bind="fit"] [data-v="cover"]').click()`);
  await wait(500);
  check('remplir l\'écran', await pjs(`player.rect.w >= player.cw - 1 && player.rect.h >= player.ch - 1`));
  await save(main, '11-remplir');

  // bibliothèque
  check('bibliothèque', (await pjs(`document.querySelectorAll('#lib .lib-item').length`)) >= 3);
  await wait(500); // le temps que l'état du calque arrive au processus principal
  const used = await js(`host.removeMedia(${JSON.stringify(await pjs('state.media.id'))})`);
  check('suppression refusée pour un média utilisé', used.ok === false && used.used === 1, JSON.stringify(used));
  const free = await js(`host.removeMedia(${JSON.stringify(mv.id)})`);
  check('suppression d\'un média inutilisé', free.ok === true && !fs.existsSync(path.join(out, 'userdata', 'media', mv.file)), JSON.stringify(free));
  await save(main, '12-scenecue');

  await js(`document.querySelector('#onair').click()`);
  await wait(800);
  fs.writeFileSync(path.join(out, 'console.log'), logs.join('\n'));
  fs.writeFileSync(path.join(out, 'results.txt'), results.join('\n'));
  console.log(results.join('\n'));
  app.quit();
});
