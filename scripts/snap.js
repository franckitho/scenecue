// Outil de vérification : lance Régie avec un profil temporaire, joue un scénario, enregistre des captures.
// L'overlay est rendu invisible (opacité 0) : rien ne s'affiche réellement à l'écran pendant le test.
// Usage : npx electron scripts/snap.js <dossier-de-sortie>
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const out = path.resolve(process.argv[process.argv.length - 1]);
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(out, 'userdata'));
setTimeout(() => { console.error('délai dépassé'); app.exit(1); }, 90000);
process.on('unhandledRejection', (e) => { console.error('ÉCHEC DU SCÉNARIO :', e); app.exit(1); });

// REGIE_MAIN permet de tester la version packagée : …/resources/app.asar/src/main.js
require(process.env.REGIE_MAIN || '../src/main.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const logs = [];
app.on('web-contents-created', (_e, wc) => {
  wc.on('console-message', (ev) => logs.push(`[${wc.getURL().split('/').slice(-1)[0]}] ${ev.level ?? ''} ${ev.message ?? ev}`));
});

app.whenReady().then(async () => {
  await wait(4500);
  const wins = BrowserWindow.getAllWindows();
  const isOverlay = (w) => w.webContents.getURL().includes('mode=overlay');
  const main = wins.find((w) => !isOverlay(w));
  const overlay = wins.find(isOverlay);
  overlay.setOpacity(0);
  const save = async (w, name) => fs.writeFileSync(path.join(out, `${name}.png`), (await w.webContents.capturePage()).toPNG());
  const js = (code) => main.webContents.executeJavaScript(code);
  const panelJs = (code) => js(`(() => { const d = document.querySelector('#panel').contentDocument; ${code} })()`);

  await save(main, '01-regie');

  await js(`document.querySelector('#onair').click()`);
  await wait(2200);
  await save(overlay, '02-overlay');
  await save(main, '03-live');

  await js(`document.querySelector('#add-layer').click()`);
  await wait(300);
  await save(main, '04-menu');
  await js(`[...document.querySelectorAll('#module-menu .mod-card')].find((c) => c.textContent.includes('Texte animé')).click()`);
  await wait(3500);
  await panelJs(`const t = d.querySelector('#text'); t.value = 'COUCOU'; t.dispatchEvent(new Event('input')); d.querySelectorAll('#pad button')[0].click();`);
  await panelJs(`d.querySelectorAll('#looks .tile')[2].click();`);
  await wait(2000);
  await save(main, '05-two-layers');
  await save(overlay, '06-overlay-two-layers');

  await js(`document.querySelectorAll('#scenes .row')[1].click()`);
  await wait(3000);
  await save(main, '07-brb');
  await js(`document.querySelector('#onair').click()`);
  await wait(2500);
  await save(overlay, '08-overlay-brb');
  await save(main, '09-switched');

  await js(`document.querySelector('#add-scene').click()`);
  await wait(1200);
  await save(main, '10-new-scene');

  await js(`document.querySelector('#cut') && !document.querySelector('#cut').hidden ? document.querySelector('#cut').click() : document.querySelector('#onair').click()`);
  await wait(800);
  fs.writeFileSync(path.join(out, 'console.log'), logs.join('\n'));
  fs.copyFileSync(path.join(out, 'userdata', 'regie.json'), path.join(out, 'regie.json'));
  app.quit();
});
