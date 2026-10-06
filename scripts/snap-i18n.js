// Vérification de la traduction anglaise : lance SceneCue en anglais (profil temporaire), ouvre l'éditeur de chaque
// module et la page du téléphone, et relève tout texte ou infobulle qui ressemble encore à du français.
// Vérifie aussi le retour au français par le sélecteur de langue. Rien n'est filmé : caméra factice de Chromium.
// Usage : npx electron scripts/snap-i18n.js <dossier-de-sortie>
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const out = path.resolve(process.argv[process.argv.length - 1]);
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(out, 'userdata'));
app.commandLine.appendSwitch('lang', 'en-US'); // système en anglais, pour la page du téléphone (SceneCue, lui, est en anglais par défaut)
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');

const PORT = 18443;
const camData = path.join(out, 'userdata', 'modules', 'camera');
fs.mkdirSync(camData, { recursive: true });
fs.writeFileSync(path.join(camData, 'config.json'), JSON.stringify({ port: PORT, httpPort: 18080, host: '127.0.0.1' }));
app.on('certificate-error', (e, _wc, url, _err, _cert, cb) => {
  if (url.startsWith(`https://127.0.0.1:${PORT}/`)) { e.preventDefault(); cb(true); } else cb(false);
});

const results = [];
const check = (name, ok, detail = '') => { results.push(`${ok ? 'OK  ' : 'ÉCHEC'} ${name}${detail ? ` — ${detail}` : ''}`); };
setTimeout(() => { console.error('délai dépassé'); console.error(results.join('\n')); app.exit(1); }, 150000);
process.on('unhandledRejection', (e) => { console.error('ÉCHEC DU SCÉNARIO :', e); console.error(results.join('\n')); app.exit(1); });
app.on('web-contents-created', (_e, wc) => wc.setAudioMuted(true));

require(process.env.SCENECUE_MAIN || '../src/main.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// textes visibles et infobulles qui ressemblent à du français (accents, guillemets, petits mots courants)
const LEAKS = `(() => {
  const FR = /[àâçéèêëîïôûùœ«»]|\\b(le|la|les|des|du|une|et|pour|avec|sans|dans|sur|tes|ton|ta|est|pas|aucun|aucune|choisis|glisse|scène|calque)\\b/i;
  const clean = (s) => String(s).replace(/SceneCue/g, '').replace(/\\s+/g, ' ').trim();
  const out = new Set();
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const el = n.parentElement;
    if (!el || el.closest('script, style, [data-no-i18n], .fname, .row-name, option')) continue;
    const s = clean(n.nodeValue);
    if (s && FR.test(s)) out.add(s);
  }
  for (const el of document.querySelectorAll('[title], [placeholder], [aria-label]')) {
    for (const a of ['title', 'placeholder', 'aria-label']) {
      const s = el.hasAttribute(a) ? clean(el.getAttribute(a)) : '';
      if (s && FR.test(s)) out.add('@' + a + ' ' + s);
    }
  }
  if (window.I18N) for (const s of I18N.missing) if (FR.test(clean(s))) out.add('manquant : ' + s);
  return [...out];
})()`;

app.whenReady().then(async () => {
  await wait(3500);
  const wins = BrowserWindow.getAllWindows();
  const main = wins.find((w) => w.webContents.getURL().includes('/src/renderer/index.html'));
  const overlay = wins.find((w) => w.webContents.getURL().includes('mode=overlay'));
  overlay.setOpacity(0);
  main.webContents.setBackgroundThrottling(false);
  const js = (code) => main.webContents.executeJavaScript(code);
  const frameOf = (part) => main.webContents.mainFrame.framesInSubtree.filter((f) => f.url.includes(part)).pop();
  const leaks = async (label, wc, part) => {
    const f = part ? frameOf(part) : wc.mainFrame;
    const list = f ? await f.executeJavaScript(LEAKS) : ['(page introuvable)'];
    check(`${label} : tout en anglais`, list.length === 0, list.slice(0, 12).join(' | '));
    return list;
  };
  const save = async (w, name) => {
    try { fs.writeFileSync(path.join(out, `${name}.png`), (await w.webContents.capturePage()).toPNG()); } catch { /* fenêtre en plein rechargement */ }
  };

  check('anglais par défaut', main.webContents.getURL().includes('lang=en'), main.webContents.getURL());
  check('scènes par défaut en anglais', (await js(`[...document.querySelectorAll('#scenes .row-name')].map((n) => n.textContent).join(',')`)) === 'Shower,BRB');
  check('sélecteur de langue sur EN', await js(`document.querySelector('#lang [data-v="en"]').classList.contains('on')`));
  await leaks('fenêtre SceneCue', main.webContents);
  await save(main, '01-scenecue-en');

  // une scène vide, puis un calque de chaque module
  await js(`document.querySelector('#add-scene').click()`);
  await wait(800);
  await js(`document.activeElement && document.activeElement.blur()`);
  // nom affiché, ou encore dans le champ de renommage ouvert à la création
  check('nouvelle scène nommée en anglais', (await js(`[...document.querySelectorAll('#scenes .row')].map((r) => { const i = r.querySelector('.row-input'); return i ? i.value : r.querySelector('.row-name').textContent; }).join(',')`)).includes('New scene'));
  await leaks('scène vide et catalogue', main.webContents);
  const cards = await js(`[...document.querySelectorAll('#catalog .mod-card b')].map((b) => b.textContent).join(', ')`);
  check('catalogue en anglais', cards.includes('Camera') && cards.includes('Image / video') && cards.includes('Animated text') && cards.includes('Now playing'), cards);

  const addModule = async (name, part) => {
    await js(`document.querySelector('#add-layer').click()`);
    await wait(300);
    await js(`[...document.querySelectorAll('#module-menu .mod-card')].find((c) => c.querySelector('b').textContent === ${JSON.stringify(name)}).click()`);
    const t = Date.now();
    while (!frameOf(part) && Date.now() - t < 8000) await wait(200);
    await wait(2500);
  };

  await addModule('Animated text', 'text-animated/src/renderer/index.html');
  await leaks('Texte animé', null, 'text-animated/src/renderer/index.html');
  check('Texte animé : texte par défaut en anglais', (await frameOf('text-animated/src/renderer/index.html').executeJavaScript(`document.querySelector('#text').value`)) === 'Be right back');
  await save(main, '02-texte-en');

  await addModule('Image / video', 'media/src/renderer/index.html');
  await leaks('Image / vidéo', null, 'media/src/renderer/index.html');
  await save(main, '03-media-en');

  await addModule('Now playing', 'music/src/renderer/index.html');
  await leaks('Musique en cours', null, 'music/src/renderer/index.html');
  await save(main, '04-musique-en');

  await addModule('Camera', 'cam/src/renderer/index.html');
  const cam = () => frameOf('cam/src/renderer/index.html');
  const t0 = Date.now();
  while (!(await cam().executeJavaScript('!!srv && srv.running')) && Date.now() - t0 < 8000) await wait(200);
  await wait(800);
  await leaks('Caméra (iPhone)', null, 'cam/src/renderer/index.html');
  await save(main, '05-camera-en');
  const url = (await cam().executeJavaScript('srv.url')).replace(/\/\/[^:/]+:/, '//127.0.0.1:');

  // page du téléphone, dans la langue du « téléphone » (ici l'anglais du système)
  const phone = new BrowserWindow({ show: false, width: 390, height: 844, webPreferences: { backgroundThrottling: false } });
  await phone.loadURL(url);
  await wait(500);
  await leaks('page du téléphone', phone.webContents);
  await phone.webContents.executeJavaScript(`document.querySelector('#go').click()`);
  const t1 = Date.now();
  while (!(await cam().executeJavaScript('info.live')) && Date.now() - t1 < 15000) await wait(300);
  await leaks('page du téléphone en marche', phone.webContents);
  await leaks('Caméra avec le téléphone connecté', null, 'cam/src/renderer/index.html');
  phone.destroy();

  await cam().executeJavaScript(`document.querySelector('[data-bind="source"] [data-v="device"]').click()`);
  await wait(2500);
  await leaks('Caméra (caméra du PC)', null, 'cam/src/renderer/index.html');

  // retour au français par le sélecteur
  await js(`document.querySelector('#lang [data-v="fr"]').click()`);
  await wait(2500);
  check('retour au français', main.webContents.getURL().includes('lang=fr') && (await js(`document.querySelector('#tb-status-text').textContent`)) === 'Hors antenne');
  await save(main, '06-retour-fr');

  fs.writeFileSync(path.join(out, 'results.txt'), results.join('\n'));
  console.log(results.join('\n'));
  app.quit();
});
