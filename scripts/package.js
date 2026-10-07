// Construit SceneCue avec tous les modules trouvés, pour Windows ou Linux :
//   npm run package                        → le système en cours (Linux sous Linux, Windows sinon)
//   npm run package -- --platform=win32    → dist/SceneCue-win32-x64/SceneCue.exe
//   npm run package -- --platform=linux    → dist/SceneCue-linux-x64/scenecue (puis scripts/make-deb.js pour le .deb)
// De chaque module, on n'embarque que son code et les node_modules listés dans "include" (module.json) :
// ni son Electron, ni son propre dist.
const path = require('path');
const fs = require('fs');
const lib = require('@electron/packager');

const packager = lib.packager || lib.default || lib;
const ROOT = path.join(__dirname, '..');
const arg = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || '').split('=')[1];
const platform = arg('platform') || (process.platform === 'linux' ? 'linux' : 'win32');
if (platform !== 'win32' && platform !== 'linux') {
  console.error(`Plateforme non prise en charge : ${platform} (win32 ou linux)`);
  process.exit(1);
}

const modules = new Map(); // chemin relatif (posix) -> chemins node_modules à garder
for (const base of ['', 'modules']) {
  let entries = [];
  try { entries = fs.readdirSync(path.join(ROOT, base), { withFileTypes: true }); } catch { continue; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const manifest = path.join(ROOT, base, e.name, 'module.json');
    if (!fs.existsSync(manifest)) continue;
    const m = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    modules.set(base ? `${base}/${e.name}` : e.name, Array.isArray(m.include) ? m.include : []);
  }
}

function ignore(p) {
  if (!p) return false;
  p = p.replace(/\\/g, '/');
  if (/^\/(dist|scripts|site|_site|docs|\.git|\.github|\.claude)(\/|$)/.test(p)) return true;
  for (const [rel, include] of modules) {
    const prefix = `/${rel}/`;
    if (!p.startsWith(prefix)) continue;
    const sub = p.slice(prefix.length);
    if (/^(dist|scripts|out|\.git|\.claude)(\/|$)/.test(sub)) return true;
    if (sub === 'node_modules') return false;
    if (sub.startsWith('node_modules/')) {
      return !include.some((inc) => sub === inc || sub.startsWith(`${inc}/`) || inc.startsWith(`${sub}/`));
    }
    return false;
  }
  return false;
}

(async () => {
  console.log(`Modules embarqués : ${[...modules.keys()].join(', ') || 'aucun'}`);
  const out = await packager({
    dir: ROOT,
    name: 'SceneCue',
    // sous Linux, un exécutable en minuscules, comme les autres commandes
    executableName: platform === 'linux' ? 'scenecue' : 'SceneCue',
    platform,
    arch: 'x64',
    out: path.join(ROOT, 'dist'),
    overwrite: true,
    asar: true,
    prune: true,
    icon: platform === 'win32' ? path.join(ROOT, 'assets', 'icon.ico') : undefined,
    appCopyright: 'SceneCue',
    win32metadata: { ProductName: 'SceneCue', FileDescription: 'SceneCue' },
    ignore,
  });
  // Linux : l'icône à côté de l'exécutable, pour un raccourci (.desktop) fait à la main ou par make-deb.js ;
  // le dossier sort en 700 du packager, lisible par tous comme le reste
  if (platform === 'linux') {
    for (const dir of out) {
      fs.chmodSync(dir, 0o755);
      fs.copyFileSync(path.join(ROOT, 'assets', 'icon.png'), path.join(dir, 'scenecue.png'));
    }
  }
  console.log('Écrit dans', out.join(', '));
})().catch((e) => { console.error(e); process.exit(1); });
