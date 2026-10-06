// Assemble le site GitHub Pages dans _site/ : pages de site/, captures de docs/images, icône, polices.
// Le dépôt (compte/nom) vient de GITHUB_REPOSITORY dans la pipeline, ou de --repo=compte/nom en local ;
// il sert aux liens de téléchargement et à l'aperçu affiché quand on colle le lien dans Discord.
// Usage : npm run site  (ou node scripts/build-site.js --repo=compte/nom)
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, '_site');
const arg = process.argv.find((a) => a.startsWith('--repo='));
const repo = (arg ? arg.slice(7) : process.env.GITHUB_REPOSITORY || '').trim();
if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`dépôt invalide : ${repo}`);

const FONTS = [
  ['archivo', [400, 500, 600, 700, 800]],
  ['jetbrains-mono', [400, 500]],
];

fs.rmSync(OUT, { recursive: true, force: true });
fs.cpSync(path.join(ROOT, 'site'), OUT, { recursive: true });
fs.cpSync(path.join(ROOT, 'docs', 'images'), path.join(OUT, 'images'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'assets', 'icon.png'), path.join(OUT, 'icon.png'));
fs.mkdirSync(path.join(OUT, 'fonts'));
for (const [family, weights] of FONTS) {
  for (const w of weights) {
    const name = `${family}-latin-${w}-normal.woff2`;
    fs.copyFileSync(path.join(ROOT, 'node_modules', '@fontsource', family, 'files', name), path.join(OUT, 'fonts', name));
  }
}

// adresse publique du site : https://compte.github.io/dépôt/ (ou https://compte.github.io/ pour le dépôt compte.github.io)
let base = '';
if (repo) {
  const [owner, name] = repo.split('/');
  base = name.toLowerCase() === `${owner.toLowerCase()}.github.io` ? `https://${owner}.github.io/` : `https://${owner}.github.io/${name}/`;
}
const page = path.join(OUT, 'index.html');
const html = fs.readFileSync(page, 'utf8')
  .replace('data-repo=""', `data-repo="${repo}"`)
  .replace(/__BASE__/g, base); // adresses absolues pour l'aperçu des liens (Discord, réseaux sociaux)
fs.writeFileSync(page, html);

const size = (dir) => fs.readdirSync(dir, { withFileTypes: true })
  .reduce((n, e) => n + (e.isDirectory() ? size(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size), 0);
console.log(`Site écrit dans ${OUT} (${Math.round(size(OUT) / 1024)} Ko)${repo ? ` pour ${repo} — ${base}` : ' — sans dépôt : liens de téléchargement désactivés'}`);
