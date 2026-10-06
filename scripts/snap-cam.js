// Vérification du module « Caméra » : lance SceneCue avec un profil temporaire et une caméra factice de Chromium
// (aucune vraie caméra n'est ouverte), ouvre la page « téléphone » dans une fenêtre cachée comme le ferait
// Safari sur l'iPhone, et vérifie serveur HTTPS, certificat, signalisation et vidéo WebRTC jusqu'à l'overlay.
// L'overlay est rendu invisible (opacité 0). Usage : npx electron scripts/snap-cam.js <dossier-de-sortie>
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

const out = path.resolve(process.argv[process.argv.length - 1]);
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(out, 'userdata'));
app.commandLine.appendSwitch('lang', 'fr-FR'); // le scénario vérifie les textes français (SceneCue est en anglais par défaut)
app.commandLine.appendSwitch('use-fake-device-for-media-stream'); // caméra de test de Chromium
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');

// ports de test, pour ne pas gêner un SceneCue déjà lancé
const PORT = 18443, HTTP_PORT = 18080;
const camData = path.join(out, 'userdata', 'modules', 'camera');
fs.mkdirSync(camData, { recursive: true });
fs.writeFileSync(path.join(camData, 'config.json'), JSON.stringify({ port: PORT, httpPort: HTTP_PORT, host: '127.0.0.1' })); // local : pas de fenêtre du pare-feu
// comme l'utilisateur sur l'iPhone : on accepte le certificat auto-signé de SceneCue
app.on('certificate-error', (e, _wc, url, _err, _cert, cb) => {
  if (url.startsWith(`https://127.0.0.1:${PORT}/`)) { e.preventDefault(); cb(true); } else cb(false);
});

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

require(process.env.SCENECUE_MAIN || '../src/main.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function get(url, opts = {}) {
  const lib = url.startsWith('https') ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(url, { rejectUnauthorized: false, ...opts }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end(opts.body);
  });
}

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
  const pjs = (code) => inFrame(main.webContents, 'cam/src/renderer/index.html', code);
  const ojs = (code) => inFrame(overlay.webContents, 'cam/src/renderer/layer.html', code);
  const until = async (fn, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await wait(200); } return false; };
  const videoSize = (run) => run(`view.video.videoWidth + 'x' + view.video.videoHeight`);

  // nouvelle scène → module Caméra
  await js(`document.querySelector('#add-scene').click()`);
  await wait(800);
  await js(`document.activeElement && document.activeElement.blur()`);
  const card = await js(`(() => { const c = [...document.querySelectorAll('#catalog .mod-card')].find((b) => b.textContent.includes('Caméra')); if (c) c.click(); return !!c; })()`);
  check('module listé dans le catalogue', card);
  await until(() => pjs(`!!srv && srv.running`), 8000);
  const st = await pjs('JSON.stringify(srv)').then(JSON.parse);
  check('serveur HTTPS démarré', st && st.running && st.port === PORT, st && (st.error || st.url));
  check('adresse réseau choisie (pas une carte virtuelle)', st && st.addresses.length > 0 && !st.addresses.find((a) => a.ip === st.ip).virtual, st && `${st.ip} parmi ${st.addresses.map((a) => `${a.ip}${a.virtual ? '*' : ''}`).join(' ')}`);
  check('QR code affiché', (await pjs(`(document.querySelector('#qr path') || {}).getAttribute ? document.querySelector('#qr path').getAttribute('d').length : 0`)) > 100);
  check('calque nommé « iPhone »', (await js(`[...document.querySelectorAll('#layers .row-name')].map((n) => n.textContent).join('|')`)).includes('iPhone'));
  await save(main, '01-attente-iphone');

  // serveur vu depuis le réseau
  const page = await get(`https://127.0.0.1:${PORT}/`);
  check('page du téléphone servie', page.status === 200 && page.body.includes('SceneCue · Caméra'));
  const redirect = await get(`http://127.0.0.1:${HTTP_PORT}/`);
  check('http:// renvoie vers https:// avec le code', redirect.status === 301 && redirect.headers.location === `https://127.0.0.1:${PORT}/?k=${st.key}`, redirect.headers.location);
  const badKey = await get(`https://127.0.0.1:${PORT}/api/hello`, { method: 'POST', body: JSON.stringify({ key: 'nope' }) });
  check('mauvais code refusé', badKey.status === 403, String(badKey.status));
  const x509 = new crypto.X509Certificate(fs.readFileSync(path.join(camData, 'cert.pem')));
  const days = (Date.parse(x509.validTo) - Date.parse(x509.validFrom)) / 86400000;
  check('certificat : adresses du PC, serverAuth, validité acceptée par iOS',
    x509.subjectAltName.includes('IP Address:127.0.0.1') && x509.subjectAltName.includes(`IP Address:${st.ip}`) && x509.keyUsage.includes('1.3.6.1.5.5.7.3.1') && days <= 825 && x509.verify(x509.publicKey),
    `${x509.subjectAltName} · ${Math.round(days)} jours`);

  // « iPhone » : la page ouverte dans une fenêtre cachée, avec la caméra factice
  const phone = new BrowserWindow({ show: false, width: 390, height: 844, webPreferences: { backgroundThrottling: false } });
  const phoneUrl = st.url.replace(st.ip, '127.0.0.1');
  await phone.loadURL(phoneUrl);
  const ph = (code) => phone.webContents.executeJavaScript(code);
  await ph(`document.querySelector('#go').click()`);
  const previewLive = await until(() => pjs('info.live'), 15000);
  check('aperçu : vidéo du téléphone reçue', previewLive, await pjs('JSON.stringify(info)'));
  check('aperçu en petite image (économie pour le téléphone)', previewLive && (await pjs('view.video.videoWidth')) <= 960, await videoSize(pjs));
  await until(() => pjs(`!!(srv.phone && srv.phone.info && srv.phone.info.viewers)`), 5000);
  check('SceneCue voit le téléphone', await pjs(`!!(srv.phone && srv.phone.connected)`), await pjs(`document.querySelector('#phone-text').textContent`));
  await wait(1200);
  await save(main, '02-iphone-apercu');
  fs.writeFileSync(path.join(out, '03-telephone.png'), (await phone.webContents.capturePage()).toPNG());

  // à l'écran : la sortie reçoit la pleine qualité
  await js(`document.querySelector('#onair').click()`);
  const outLive = await until(() => ojs('view.live'), 15000);
  const outSize = await videoSize(ojs);
  check('sortie : vidéo du téléphone à l\'écran', outLive, outSize);
  await until(async () => (await ojs('view.video.videoWidth')) > (await pjs('view.video.videoWidth')), 8000);
  check('sortie en pleine qualité', (await ojs('view.video.videoWidth')) > (await pjs('view.video.videoWidth')), `${await videoSize(ojs)} contre ${await videoSize(pjs)} dans l'aperçu`);
  check('le téléphone indique « À l\'écran »', await until(() => ph(`document.querySelector('#pill-text').textContent === "À l'écran"`), 5000));
  await save(overlay, '04-overlay');

  // commandes depuis SceneCue
  await pjs(`document.querySelector('#facing [data-v="environment"]').click()`);
  check('caméra arrière demandée depuis SceneCue', await until(() => ph(`document.querySelector('#facing .on') && document.querySelector('#facing .on').dataset.v === 'environment'`), 5000));
  check('vidéo toujours reçue après le changement de caméra', await until(() => ojs('view.live'), 8000));

  // hors antenne : le téléphone arrête d'encoder pour la sortie
  await js(`document.querySelector('#onair').click()`);
  check('hors antenne : sortie mise en pause sur le téléphone', await until(() => ph(`document.querySelector('#pill-text').textContent === 'Aperçu dans SceneCue'`), 5000),
    await ph(`document.querySelector('#pill-text').textContent`));
  await js(`document.querySelector('#onair').click()`);
  check('retour à l\'écran : la sortie reprend', await until(() => ph(`document.querySelector('#pill-text').textContent === "À l'écran"`), 5000));

  // Safari rechargé : tout se reconnecte
  phone.webContents.reload();
  await wait(1500);
  await ph(`document.querySelector('#go').click()`);
  check('téléphone rechargé : l\'aperçu revient', await until(() => pjs('info.live'), 20000));
  check('téléphone rechargé : la sortie revient', await until(() => ojs('view.live'), 20000));

  // un second appareil prend le relais
  const phone2 = new BrowserWindow({ show: false, width: 390, height: 844, webPreferences: { backgroundThrottling: false } });
  await phone2.loadURL(phoneUrl);
  await phone2.webContents.executeJavaScript(`document.querySelector('#go').click()`);
  check('second appareil : le premier est prévenu', await until(() => ph(`!document.querySelector('#msg').hidden && document.querySelector('#msg').textContent.includes('autre appareil')`), 8000));
  check('second appareil : la vidéo continue', await until(() => ojs('view.live'), 20000));
  phone2.destroy();
  phone.destroy();
  await js(`document.querySelector('#onair').click()`);
  await wait(500);

  // caméra branchée au PC (la caméra factice de Chromium)
  await pjs(`document.querySelector('[data-bind="source"] [data-v="device"]').click()`);
  check('caméra du PC : image reçue', await until(() => pjs('info.live'), 10000), await pjs('JSON.stringify(info)'));
  check('caméra du PC : listée', (await pjs(`devices.length`)) > 0, await pjs(`devices.map((d) => d.label).join(', ')`));
  check('calque renommé d\'après la caméra', !(await js(`[...document.querySelectorAll('#layers .row-name')].map((n) => n.textContent).join('|')`)).includes('iPhone'));
  await pjs(`state.shape = 'circle'; state.border = true; state.borderColor = '#FF4D1F'; state.zoom = 1.6; state.panX = 0.3; sync(); commit();`);
  await wait(800);
  check('cercle : image carrée', await pjs(`Math.abs(view.rect.w - view.rect.h) < 0.5`));
  await save(main, '05-peripherique-cercle');

  fs.writeFileSync(path.join(out, 'console.log'), logs.join('\n'));
  fs.writeFileSync(path.join(out, 'results.txt'), results.join('\n'));
  console.log(results.join('\n'));
  app.quit();
});
