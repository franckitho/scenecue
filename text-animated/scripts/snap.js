// Outil de vérification : lance l'app, joue un scénario et enregistre des captures.
// Usage : npx electron scripts/snap.js <dossier-de-sortie>
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const out = path.resolve(process.argv[process.argv.length - 1]);
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(out, 'userdata'));

require('../src/main.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const logs = [];

app.on('browser-window-created', (_e, w) => {
  w.webContents.on('console-message', (ev) => {
    const msg = ev.message ?? ev;
    logs.push(`[${w.getTitle()}] ${ev.level ?? ''} ${msg}`);
  });
});

app.whenReady().then(async () => {
  await wait(3500);
  const wins = BrowserWindow.getAllWindows();
  const control = wins.find((w) => !w.getTitle().includes('overlay'));
  const overlay = wins.find((w) => w.getTitle().includes('overlay'));
  overlay.setOpacity(0); // capturé mais jamais visible à l'écran pendant le test
  const save = async (w, name, rect) => {
    const img = await w.webContents.capturePage(rect);
    fs.writeFileSync(path.join(out, `${name}.png`), img.toPNG());
  };
  const js = (code) => control.webContents.executeJavaScript(code);

  await save(control, '01-control');

  await js(`document.querySelector('#onair').click()`);
  await wait(2200);
  await save(overlay, '02-overlay');
  await save(control, '03-control-live');

  const frameRect = await js(`(() => { const r = document.querySelector('#frame').getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }; })()`);
  const n = await js(`document.querySelectorAll('#looks .tile').length`);
  for (let i = 0; i < n; i++) {
    await js(`document.querySelectorAll('#looks .tile')[${i}].click()`);
    await wait(1600);
    await save(control, `look-${String(i + 1).padStart(2, '0')}`, frameRect);
  }

  const click = (sel) => js(`document.querySelector(${JSON.stringify(sel)}).click()`);
  const typeText = (t) => js(`(() => { const a = document.querySelector('#text'); a.value = ${JSON.stringify(t)}; a.dispatchEvent(new Event('input')); })()`);

  await js(`document.querySelectorAll('#looks .tile')[0].click()`);
  await wait(1500);
  await save(control, 'arc', frameRect);

  await click('[data-bind="style.anim"] [data-v="type"]');
  await wait(1500);
  await save(control, 'type', frameRect);

  await click('[data-bind="style.anim"] [data-v="marquee"]');
  await wait(1500);
  await save(control, 'marquee', frameRect);

  await click('[data-bind="style.anim"] [data-v="wave"]');
  await click('[data-bind="timer.mode"] [data-v="down"]');
  await typeText('Pause pipi\nj\'arrive');
  await wait(1200);
  await save(control, 'timer');
  await save(overlay, 'timer-overlay');

  await click('[data-bind="style.fill.type"] [data-v="gradient"]');
  for (const [i, top] of [[1, 520], [2, 1150], [3, 1800]]) {
    await js(`document.querySelector('#inspector').scrollTop = ${top}`);
    await wait(500);
    await save(control, `insp-${i}`);
  }
  await js(`document.querySelector('#inspector').scrollTop = 1150`);
  await click('.color-field[data-bind="style.fill.c2"] .swatch-btn');
  await wait(400);
  await save(control, 'pop');

  await js(`document.querySelector('#onair').click()`);
  await wait(800);
  fs.writeFileSync(path.join(out, 'console.log'), logs.join('\n'));
  app.quit();
});
