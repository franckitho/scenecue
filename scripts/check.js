// Vérifie la syntaxe de tous les fichiers JavaScript du projet (SceneCue, modules, scripts, site).
// Usage : npm run check — utilisé aussi par la pipeline avant de construire l'exécutable.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKIP = new Set(['node_modules', 'dist', '_site', '.git']);

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith('.js')) yield p;
  }
}

let failed = 0;
let count = 0;
for (const file of walk(ROOT)) {
  count++;
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (e) {
    failed++;
    console.error(`✗ ${path.relative(ROOT, file)}\n${String(e.stderr).trim()}\n`);
  }
}
console.log(failed ? `${failed} fichier(s) en erreur sur ${count}` : `${count} fichiers JavaScript : syntaxe correcte`);
process.exit(failed ? 1 : 0);
