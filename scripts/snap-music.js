// Vérification du module « Musique en cours » : lance SceneCue avec un profil temporaire. Le PowerShell qui lit
// Spotify est remplacé par un faux lecteur piloté par ce scénario (lecture, pause, morceau suivant, fermeture,
// panne) : le vrai Spotify n'est jamais touché. À la fin, le vrai script PowerShell est lancé une fois, seul,
// pour vérifier qu'il répond sur ce PC. L'overlay est rendu invisible (opacité 0).
// Usage : npx electron scripts/snap-music.js <dossier-de-sortie>
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const cp = require('child_process');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

const out = path.resolve(process.argv[process.argv.length - 1]);
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(out, 'userdata'));
app.commandLine.appendSwitch('lang', 'fr-FR'); // le scénario vérifie les textes français (SceneCue est en anglais par défaut)

const results = [];
const logs = [];
const check = (name, ok, detail = '') => { results.push(`${ok ? 'OK  ' : 'ÉCHEC'} ${name}${detail ? ` — ${detail}` : ''}`); };
setTimeout(() => { console.error('délai dépassé'); console.error(results.join('\n')); app.exit(1); }, 180000);
process.on('unhandledRejection', (e) => {
  console.error('ÉCHEC DU SCÉNARIO :', e);
  console.error(results.join('\n'));
  console.error(logs.slice(-15).join('\n'));
  app.exit(1);
});
app.on('web-contents-created', (_e, wc) => {
  wc.setAudioMuted(true);
  wc.on('console-message', (ev) => logs.push(`[${wc.getURL().split('/').slice(-1)[0]}] ${ev.level ?? ''} ${ev.message ?? ev}`));
});

// ---------- faux Spotify : remplace le PowerShell lancé par le backend du module ----------
const realSpawn = cp.spawn;
const COVER = fs.readFileSync(path.join(__dirname, '..', 'music', 'assets', 'icon.png')).toString('base64');
const fake = { crash: false, spawned: 0, state: { app: null }, sentKey: null };
function fakeLine() {
  const s = fake.state;
  if (!s.app) { fake.sentKey = null; return { app: null }; }
  const { cover, ...line } = s;
  const key = `${s.title}|${s.artist}|${s.album}`;
  if (key !== fake.sentKey) { fake.sentKey = key; line.cover = cover || null; } // comme smtc.ps1 : au changement de morceau
  return line;
}
cp.spawn = function spawn(cmd, args, opts) {
  if (!(Array.isArray(args) && args.some((a) => String(a).endsWith('smtc.ps1')))) return realSpawn.call(this, cmd, args, opts);
  fake.spawned++;
  const p = new EventEmitter();
  p.stdout = new PassThrough();
  p.stderr = new PassThrough();
  p.kill = () => { clearInterval(p.timer); setImmediate(() => p.emit('exit', null)); return true; };
  if (fake.crash) {
    setTimeout(() => { p.stderr.write('Exception : panne simulée\r\n'); p.emit('exit', 1); }, 100);
    return p;
  }
  fake.sentKey = null;
  const send = () => p.stdout.write(`${JSON.stringify(fakeLine())}\n`);
  setTimeout(send, 100);
  p.timer = setInterval(send, 500);
  fake.proc = p;
  return p;
};
// Spotify « joue » : position donnée à l'instant présent, comme Windows
const play = (title, extra = {}) => {
  fake.state = { app: 'Spotify.exe', title, artist: 'Groupe test', album: 'Album test', status: 'Playing', position: 30000, duration: 200000, updated: Date.now(), cover: COVER, ...extra };
};

require(process.env.SCENECUE_MAIN || '../src/main.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  await wait(3500);
  const wins = BrowserWindow.getAllWindows();
  const main = wins.find((w) => w.webContents.getURL().includes('/src/renderer/index.html'));
  const overlay = wins.find((w) => w.webContents.getURL().includes('mode=overlay'));
  overlay.setOpacity(0);
  main.webContents.setBackgroundThrottling(false);
  const save = async (w, name) => fs.writeFileSync(path.join(out, `${name}.png`), (await w.webContents.capturePage()).toPNG());
  const js = (code) => main.webContents.executeJavaScript(code);
  const inFrame = (wc, part, code) => {
    const f = wc.mainFrame.framesInSubtree.filter((x) => x.url.includes(part)).pop();
    if (!f) return Promise.resolve(null);
    return f.executeJavaScript(code).catch((e) => { throw new Error(`${e.message}\n  dans ${part} : ${code.slice(0, 300)}`); });
  };
  const pjs = (code) => inFrame(main.webContents, 'music/src/renderer/index.html', code);
  const ojs = (code) => inFrame(overlay.webContents, 'music/src/renderer/layer.html', code);
  const until = async (fn, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await wait(200); } return false; };
  const shown = () => ojs('view.showing');
  const chip = () => pjs(`document.querySelector('#chip-text').textContent`);
  const TITLE = 'view.title.run.firstChild.firstChild.nodeValue'; // titre seul, sans « · artiste » (mode compact)

  // nouvelle scène → module Musique en cours
  await js(`document.querySelector('#add-scene').click()`);
  await wait(800);
  await js(`document.activeElement && document.activeElement.blur()`);
  const card = await js(`(() => { const c = [...document.querySelectorAll('#catalog .mod-card')].find((b) => b.textContent.includes('Musique en cours')); if (c) c.click(); return !!c; })()`);
  check('module listé dans le catalogue', card);
  check('éditeur ouvert', await until(() => pjs('!!view'), 8000));
  check('backend démarré à la demande', await until(() => fake.spawned > 0, 5000), `${fake.spawned} lancement(s)`);

  // Spotify fermé : exemple dans l'aperçu
  check('Spotify fermé : signalé dans l\'éditeur', await until(async () => (await chip()) === "Spotify n'est pas ouvert · exemple", 5000), await chip());
  check('Spotify fermé : morceau d\'exemple dans l\'aperçu', (await pjs(TITLE)) === 'Titre du morceau');
  await wait(600);
  await save(main, '01-exemple');

  // à l'écran, sans morceau : rien ne s'affiche
  await js(`document.querySelector('#onair').click()`);
  await until(() => ojs('!!view'), 8000);
  await wait(1500);
  check('à l\'écran sans Spotify : carte cachée (pas d\'exemple)', (await shown()) === false && (await ojs(`view.canvas.classList.contains('mu-hidden')`)));

  // un morceau démarre
  play('Chanson test');
  check('morceau reçu : la carte apparaît à l\'écran', await until(shown, 5000));
  check('à l\'écran : titre et artiste', (await ojs(`${TITLE} + ' / ' + view.artist.line.textContent`)) === 'Chanson test / Groupe test',
    await ojs(`${TITLE} + ' / ' + view.artist.line.textContent`));
  check('pochette affichée', await until(() => ojs(`view.img.naturalWidth > 0 && view.canvas.classList.contains('mu-has-cover')`), 4000));
  const accent = await ojs(`view.coverColor`);
  check('accent tiré de la pochette (orange)', /^#[0-9a-f]{6}$/i.test(accent || '') && parseInt(accent.slice(1, 3), 16) > parseInt(accent.slice(5, 7), 16) + 60, accent);
  const pos = await ojs(`Music.positionOf(view.current())`);
  check('position extrapolée (30 s + temps écoulé)', pos > 30000 && pos < 36000, `${Math.round(pos)} ms`);
  check('éditeur : « en lecture » et titre', (await chip()) === 'Spotify · en lecture' && (await pjs(`document.querySelector('#np-title').textContent`)) === 'Chanson test', await chip());
  check('égaliseur animé pendant la lecture', await ojs(`getComputedStyle(view.eq.firstChild).animationName === 'mu-eq'`));
  await wait(1200);
  await save(overlay, '02-overlay-carte');
  await save(main, '03-editeur-lecture');

  // pause : carte estompée (réglage par défaut), position figée
  fake.state = { ...fake.state, status: 'Paused', position: 45000, updated: Date.now() };
  check('pause : carte estompée', await until(() => ojs(`view.canvas.classList.contains('mu-paused') && +getComputedStyle(view.card).opacity < 0.7`), 4000));
  const p1 = await ojs(`Music.positionOf(view.current())`);
  await wait(700);
  check('pause : position figée', p1 === (await ojs(`Music.positionOf(view.current())`)) && Math.abs(p1 - 45000) < 1, `${p1} ms`);

  // réglage « Masquer » : la carte quitte l'écran en pause, revient à la reprise
  await pjs(`document.querySelector('[data-bind="paused"] [data-v="hide"]').click()`);
  check('pause + « Masquer » : la carte quitte l\'écran', await until(async () => !(await shown()), 4000));
  check('pause + « Masquer » : fantôme dans l\'aperçu de l\'éditeur', await pjs(`view.showing && view.canvas.classList.contains('mu-p-hide')`));
  fake.state = { ...fake.state, status: 'Playing', updated: Date.now() };
  check('reprise : la carte revient', await until(shown, 4000));

  // retour en arrière dans le morceau : position corrigée
  fake.state = { ...fake.state, position: 5000, updated: Date.now() };
  check('saut dans le morceau suivi', await until(async () => (await ojs(`Music.positionOf(view.current())`)) < 9000, 4000));

  // morceau suivant au titre très long : transition et défilement
  play('Un titre de chanson beaucoup trop long pour tenir sur la carte, même en tout petit', { artist: 'Autre groupe' });
  check('morceau suivant : transition « glissé »', await until(() => ojs(`view.canvas.classList.contains('mu-swap')`), 4000));
  check('titre trop long : il défile', await until(() => ojs(`view.title.line.classList.contains('mu-mq')`), 3000));
  check('titre court : il ne défile pas', !(await ojs(`view.artist.line.classList.contains('mu-mq')`)));
  await wait(1500);
  await save(overlay, '04-overlay-defilement');

  // dispositions
  await pjs(`document.querySelector('[data-bind="layout"] [data-v="compact"]').click()`);
  await wait(900);
  check('compacte : une ligne, l\'artiste après le titre', await ojs(`getComputedStyle(view.artist.line).display === 'none' && getComputedStyle(view.title.line.querySelector('.mu-sub')).display !== 'none'`));
  await save(main, '05-compacte');
  await pjs(`document.querySelector('[data-bind="layout"] [data-v="cover"]').click()`);
  await wait(900);
  check('pochette : carte de 320 px, pochette carrée', await ojs(`Math.abs(view.box.offsetWidth - 320) < 1 && Math.abs(view.art.offsetWidth - view.art.offsetHeight) < 1`),
    await ojs(`view.box.offsetWidth + ' · ' + view.art.offsetWidth + 'x' + view.art.offsetHeight`));
  check('« Longueur » masquée en mode pochette', await pjs(`document.querySelector('[data-bind="width"]').hidden`));
  check('pochette : la carte, plus haute, reste dans l\'écran', await pjs(`state.y * view.ch + view.rect.h / 2 <= view.ch`), await pjs(`state.y + ' · ' + view.rect.h`));
  await save(main, '06-pochette');
  await pjs(`document.querySelector('[data-bind="layout"] [data-v="card"]').click()`);

  // taille par le coin, état enregistré
  await pjs(`state.scale = 1.5; sync(); commit();`);
  await wait(600);
  check('taille appliquée à l\'écran', await until(() => ojs(`Math.abs(view.box.offsetWidth - 560 * 1.5) < 1`), 3000), await ojs('view.box.offsetWidth'));
  const saved = JSON.parse(fs.readFileSync(path.join(out, 'userdata', 'scenecue.json'), 'utf8'));
  const layer = saved.scenes.flatMap((s) => s.layers).find((l) => l.module === 'music');
  check('réglages enregistrés dans scenecue.json', await until(() => {
    const s = JSON.parse(fs.readFileSync(path.join(out, 'userdata', 'scenecue.json'), 'utf8'));
    const l = s.scenes.flatMap((x) => x.layers).find((x) => x.module === 'music');
    return l && l.state && l.state.scale === 1.5 && l.state.paused === 'hide';
  }, 3000), layer ? JSON.stringify(layer.state).slice(0, 120) : 'calque introuvable');

  // Spotify fermé : la carte quitte l'écran, l'aperçu revient à l'exemple
  fake.state = { app: null };
  check('Spotify fermé : la carte quitte l\'écran', await until(async () => !(await shown()), 4000));
  check('Spotify fermé : exemple dans l\'aperçu', await until(async () => (await pjs(TITLE)) === 'Titre du morceau', 3000));

  // PowerShell en panne : relancé, puis erreur affichée ; il repart ensuite tout seul
  fake.crash = true;
  const before = fake.spawned;
  clearInterval(fake.proc.timer);
  fake.proc.emit('exit', 1);
  check('panne : PowerShell relancé', await until(() => fake.spawned > before, 6000), `${fake.spawned - before} relance(s)`);
  check('pannes répétées : erreur affichée', await until(async () => (await chip()) === 'Spotify inaccessible', 20000), await pjs(`document.querySelector('#np-error').textContent`));
  await save(main, '07-erreur');
  fake.crash = false;
  play('Retour');
  check('après la panne : tout repart', await until(async () => (await chip()) === 'Spotify · en lecture', 40000), await chip());
  check('après la panne : la carte revient à l\'écran', await until(shown, 4000));

  // hors antenne : disparition en moins de 450 ms
  await js(`document.querySelector('#onair').click()`);
  const t0 = Date.now();
  await until(() => ojs(`view.canvas.classList.contains('mu-hidden')`), 2000);
  check('hors antenne : disparition rapide', Date.now() - t0 < 900, `${Date.now() - t0} ms`);

  // le vrai script PowerShell, lancé seul : il doit répondre sur ce PC (Spotify ouvert ou non)
  const ps = realSpawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(out, 'userdata', 'modules', 'music', 'smtc.ps1')],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let first = null;
  let err = '';
  ps.stdout.setEncoding('utf8');
  let buf = '';
  ps.stdout.on('data', (c) => { buf += c; const i = buf.indexOf('\n'); if (i >= 0 && !first) first = buf.slice(0, i); });
  ps.stderr.on('data', (c) => { err += c; });
  await until(() => first || err, 10000);
  ps.kill();
  let line = null;
  try { line = JSON.parse(first); } catch { /* illisible */ }
  check('vrai PowerShell : lecture des contrôles multimédias de Windows', !!line && !line.error,
    line ? (line.app ? `${line.app} : ${line.title} — ${line.artist} (${line.status})` : 'Spotify fermé') : (err || first || 'pas de réponse').slice(0, 200));

  fs.writeFileSync(path.join(out, 'console.log'), logs.join('\n'));
  fs.writeFileSync(path.join(out, 'results.txt'), results.join('\n'));
  console.log(results.join('\n'));
  app.quit();
});
