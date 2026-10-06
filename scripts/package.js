// Construit dist/Regie-win32-x64/Regie.exe avec tous les modules trouvés.
// De chaque module, on n'embarque que son code et les node_modules listés dans "include" (module.json) :
// ni son Electron, ni son propre dist.
const path = require('path');
const fs = require('fs');
const lib = require('@electron/packager');

const packager = lib.packager || lib.default || lib;
const ROOT = path.join(__dirname, '..');

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
    name: 'Regie',
    executableName: 'Regie',
    platform: 'win32',
    arch: 'x64',
    out: path.join(ROOT, 'dist'),
    overwrite: true,
    asar: true,
    prune: true,
    icon: path.join(ROOT, 'assets', 'icon.ico'),
    appCopyright: 'Régie',
    win32metadata: { ProductName: 'Régie', FileDescription: 'Régie' },
    ignore,
  });
  console.log('Écrit dans', out.join(', '));
})().catch((e) => { console.error(e); process.exit(1); });
