// Vérification de la diffusion sur un autre écran (menu « Diffusion ») : fenêtre plein écran avec la copie de l'écran
// de sortie et les calques par-dessus. Il faut deux écrans. Les fenêtres sont rendues invisibles (opacité 0).
// Si le pilote Virtual Display Driver est installé, vérifie aussi l'option « Écran virtuel » : l'écran virtuel est
// branché puis débranché, et le scénario se termine en quittant SceneCue avec cette option (il doit être débranché).
// Usage : npx electron scripts/snap-mirror.js <dossier-de-sortie>
const { app, BrowserWindow, screen } = require('electron');
const path = require('path');
const fs = require('fs');

const out = path.resolve(process.argv[process.argv.length - 1]);
fs.rmSync(path.join(out, 'userdata'), { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(out, 'userdata'));
app.commandLine.appendSwitch('lang', 'fr-FR'); // le scénario vérifie les textes français

const results = [];
const check = (name, ok, detail = '') => { results.push(`${ok ? 'OK  ' : 'ÉCHEC'} ${name}${detail ? ` — ${detail}` : ''}`); };
const finish = () => {
  fs.writeFileSync(path.join(out, 'results.txt'), results.join('\n'));
  console.log(results.join('\n'));
  app.exit(results.some((r) => r.startsWith('ÉCHEC')) ? 1 : 0);
};
setTimeout(() => { results.push('ÉCHEC délai dépassé'); finish(); }, 90000);
process.on('unhandledRejection', (e) => { results.push(`ÉCHEC DU SCÉNARIO : ${e && e.stack}`); finish(); });
const logs = [];
app.on('web-contents-created', (_e, wc) => {
  wc.setAudioMuted(true);
  wc.on('console-message', (ev) => logs.push(`[${ev.level}] ${ev.message}`));
});

require(process.env.SCENECUE_MAIN || '../src/main.js');
const vdisplay = require('../src/vdisplay');
const isVirtual = (d) => /VDD by MTT/i.test(d.label || '');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const byUrl = (s) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.webContents.getURL().includes(s));
// toute fenêtre, dès sa création, devient invisible
const hide = setInterval(() => { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed() && w.getOpacity() !== 0) w.setOpacity(0); }, 5);
const pick = (id, v) => `(() => { const s = document.querySelector('#${id}'); s.value = '${v}'; s.dispatchEvent(new Event('change')); })()`;
const save = async (w, name) => fs.writeFileSync(path.join(out, `${name}.png`), (await w.webContents.capturePage()).toPNG());

app.whenReady().then(async () => {
  await wait(3500);
  const main = byUrl('/src/renderer/index.html')[0];
  const js = (code) => main.webContents.executeJavaScript(code);
  const prim = screen.getPrimaryDisplay();
  const other = screen.getAllDisplays().find((d) => d.id !== prim.id && !isVirtual(d));
  check('deux écrans', !!other);
  if (!other) return finish();

  check('au départ : overlay, pas de diffusion', byUrl('mode=overlay').length === 1 && byUrl('mode=mirror').length === 0);
  check('au départ : SceneCue capturable', !main.isContentProtected());
  const opts = await js(`[...document.querySelectorAll('#mirror option')].map(o => o.value + '|' + o.textContent)`);
  const hasVirtual = opts.includes('virtual|Écran virtuel');
  check('menu Diffusion', opts.length === (hasVirtual ? 3 : 2) && opts[0] === "|Par-dessus l'écran" && opts[1].startsWith(`${other.id}|Copie sur l'écran`), opts.join(' / '));

  // diffusion sur l'autre écran
  await js(pick('mirror', other.id));
  await wait(3000);
  const mirror = byUrl('mode=mirror')[0];
  check('fenêtre de diffusion créée', !!mirror);
  if (!mirror) return finish();
  check("l'overlay a disparu", byUrl('mode=overlay').length === 0);
  check("plein écran sur l'autre écran", mirror.isFullScreen() && JSON.stringify(mirror.getBounds()) === JSON.stringify(other.bounds), JSON.stringify(mirror.getBounds()));
  check('affichée hors antenne', mirror.isVisible());
  check('SceneCue exclue des captures', main.isContentProtected());
  const v = await mirror.webContents.executeJavaScript(`(() => {
    const v = document.querySelector('video.screen'), r = document.querySelector('.stage').getBoundingClientRect();
    return { w: v.videoWidth, h: v.videoHeight, playing: !v.paused, stage: [r.x, r.y, r.width, r.height] };
  })()`);
  check("vidéo de l'écran de sortie", v.w === Math.round(prim.size.width * prim.scaleFactor) && v.h === Math.round(prim.size.height * prim.scaleFactor) && v.playing, JSON.stringify(v));
  check("scène au format de l'écran copié", Math.abs(v.stage[2] / v.stage[3] - v.w / v.h) < 0.01, JSON.stringify(v.stage));
  const tips = await js(`[document.querySelector('#tip').textContent, document.querySelector('#mirror-note').hidden, document.querySelector('#mirror-note').textContent]`);
  check('consignes', /partage l'écran \d+ en entier\.$/.test(tips[0]) && !tips[1] && /le son passe avec/.test(tips[2]), JSON.stringify(tips));
  await save(main, '01-scenecue');
  await wait(500);
  const stored = JSON.parse(fs.readFileSync(path.join(out, 'userdata', 'scenecue.json'), 'utf8'));
  check('enregistré', stored.mirror === other.id, String(stored.mirror));

  // à l'antenne, puis coupure
  await js(`document.querySelector('#onair').click()`);
  await wait(2500);
  const n1 = await mirror.webContents.executeJavaScript(`document.querySelectorAll('.stage iframe.layer').length`);
  check('calque posé sur la copie', n1 === 1, String(n1));
  await save(mirror, '02-diffusion-antenne');
  await js(`document.querySelector('#onair').click()`);
  await wait(1200);
  check('toujours affichée après la coupure', mirror.isVisible() && byUrl('mode=mirror').length === 1);
  const n2 = await mirror.webContents.executeJavaScript(`document.querySelectorAll('.stage iframe.layer').length`);
  check('calques retirés après la coupure', n2 === 0, String(n2));
  await save(mirror, '03-diffusion-coupee');

  // l'écran de sortie devient l'écran de diffusion : retour à l'overlay
  await js(pick('display', other.id));
  await wait(1500);
  check('sortie = écran de diffusion → overlay', byUrl('mode=overlay').length === 1 && byUrl('mode=mirror').length === 0);
  check('SceneCue de nouveau capturable', !main.isContentProtected());
  const m2 = await js(`[document.querySelector('#mirror').value, document.querySelector('#mirror-note').hidden, [...document.querySelectorAll('#mirror option')].map(o => o.value).join(',')]`);
  check('menu revenu à « par-dessus »', m2[0] === '' && m2[1] && m2[2] === `,${prim.id}${hasVirtual ? ',virtual' : ''}`, JSON.stringify(m2));
  const ov = byUrl('mode=overlay')[0];
  await js(`document.querySelector('#onair').click()`);
  await wait(1200);
  check("overlay sur l'écran choisi, à l'antenne", ov.isVisible() && JSON.stringify(ov.getBounds()) === JSON.stringify(other.bounds), JSON.stringify(ov.getBounds()));
  await js(`document.querySelector('#onair').click()`);
  await wait(800);

  // retour à l'écran principal, diffusion, puis « par-dessus »
  await js(pick('display', prim.id));
  await js(pick('mirror', other.id));
  await wait(2000);
  check('diffusion réactivée', byUrl('mode=mirror').length === 1);
  await js(pick('mirror', ''));
  await wait(1500);
  check('par-dessus : overlay', byUrl('mode=overlay').length === 1 && byUrl('mode=mirror').length === 0 && !main.isContentProtected());

  // écran virtuel
  const virtualMirror = async () => {
    for (let i = 0; i < 60; i++) {
      const d = screen.getAllDisplays().find(isVirtual);
      const w = d && byUrl('mode=mirror').find((x) => x.isFullScreen() && JSON.stringify(x.getBounds()) === JSON.stringify(d.bounds));
      if (w) return { d, w };
      await wait(250);
    }
    return {};
  };
  const virtualOutput = async () => { const r = await vdisplay.list(); return r.ok ? r.outputs.find((o) => o.virtual) : null; };
  if (hasVirtual) {
    await js(pick('mirror', 'virtual'));
    const { d, w } = await virtualMirror();
    check("diffusion sur l'écran virtuel", !!w, d ? JSON.stringify(d.bounds) : 'écran virtuel absent');
    const o = await virtualOutput();
    check("écran virtuel à la résolution de l'écran de sortie, dans un coin", o && o.attached && o.placed
      && o.w === Math.round(prim.size.width * prim.scaleFactor) && o.h === Math.round(prim.size.height * prim.scaleFactor), JSON.stringify(o));
    await wait(1500);
    const note = await js(`[document.querySelector('#mirror').value, document.querySelector('#mirror-note').textContent, document.querySelector('#tip').textContent]`);
    check('consignes écran virtuel', note[0] === 'virtual' && /écran virtuel · \d+×\d+ en entier/.test(note[1]) && /l'écran virtuel en entier/.test(note[2]), JSON.stringify(note));
    const opts2 = await js(`[...document.querySelectorAll('#display option, #mirror option')].map(o => o.value).join(',')`);
    check("l'écran virtuel n'est pas proposé comme écran", !!d && !opts2.split(',').includes(String(d.id)), opts2);
    if (w) await save(w, '04-ecran-virtuel');

    await js(pick('mirror', ''));
    await wait(3000);
    const o2 = await virtualOutput();
    check('par-dessus : écran virtuel débranché', o2 && !o2.attached && !screen.getAllDisplays().some(isVirtual), JSON.stringify(o2));
    check('par-dessus : overlay (après écran virtuel)', byUrl('mode=overlay').length === 1 && byUrl('mode=mirror').length === 0);

    // on quitte SceneCue avec l'écran virtuel choisi : il doit être débranché (à vérifier après coup)
    await js(pick('mirror', 'virtual'));
    const again = await virtualMirror();
    check('écran virtuel rebranché', !!again.w);
  } else {
    results.push('—    pas de pilote Virtual Display Driver : option « Écran virtuel » non testée');
  }

  const errors = logs.filter((l) => /error|impossible/i.test(l));
  check('console sans erreur', errors.length === 0, errors.slice(0, 5).join(' | '));
  fs.writeFileSync(path.join(out, 'console.log'), logs.join('\n'));
  clearInterval(hide);
  if (!hasVirtual) return finish();
  fs.writeFileSync(path.join(out, 'results.txt'), results.join('\n'));
  console.log(results.join('\n'));
  app.quit(); // pas app.exit : SceneCue débranche l'écran virtuel en quittant (will-quit)
});
