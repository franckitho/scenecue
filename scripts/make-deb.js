// Construit dist/SceneCue-linux-x64.deb (Debian, Ubuntu…) à partir de dist/SceneCue-linux-x64 :
//   npm run package -- --platform=linux && node scripts/make-deb.js
// Sans dépendance npm : il faut dpkg-deb (présent sur Debian et Ubuntu). Le paquet installe SceneCue dans
// /opt/SceneCue, la commande scenecue, son entrée dans le menu des applications et son icône.
// chrome-sandbox y est setuid root : sans ça, Chromium refuse de démarrer là où les espaces de noms
// utilisateur sont bridés (Ubuntu 24.04 et suivants).
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'dist', 'SceneCue-linux-x64');
const STAGE = path.join(ROOT, 'dist', 'deb');
const OUT = path.join(ROOT, 'dist', 'SceneCue-linux-x64.deb');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const arg = process.argv.find((a) => a.startsWith('--repo='));
const repo = (arg ? arg.slice(7) : process.env.GITHUB_REPOSITORY || 'franckitho/scenecue').trim();

if (!fs.existsSync(path.join(SRC, 'scenecue'))) {
  console.error(`${path.relative(ROOT, SRC)}/scenecue introuvable : lance d'abord npm run package -- --platform=linux`);
  process.exit(1);
}

const write = (rel, text, mode = 0o644) => {
  const file = path.join(STAGE, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  fs.chmodSync(file, mode);
};

fs.rmSync(STAGE, { recursive: true, force: true });
const app = path.join(STAGE, 'opt', 'SceneCue');
fs.cpSync(SRC, app, { recursive: true });
fs.chmodSync(path.join(app, 'chrome-sandbox'), 0o4755);
fs.mkdirSync(path.join(STAGE, 'usr', 'bin'), { recursive: true });
fs.symlinkSync('/opt/SceneCue/scenecue', path.join(STAGE, 'usr', 'bin', 'scenecue'));

const icon = path.join(STAGE, 'usr', 'share', 'icons', 'hicolor', '256x256', 'apps', 'scenecue.png');
fs.mkdirSync(path.dirname(icon), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'assets', 'icon.png'), icon);

// --ozone-platform=x11 : sous Wayland, SceneCue passe par XWayland (voir main.js), autant le demander tout de suite
write('usr/share/applications/scenecue.desktop', `[Desktop Entry]
Type=Application
Name=SceneCue
GenericName=Stream scenes
GenericName[fr]=Scènes pour stream
Comment=Scene control for streaming on Discord
Comment[fr]=La régie de scènes pour stream sur Discord
Exec=/opt/SceneCue/scenecue --ozone-platform=x11
Icon=scenecue
Terminal=false
Categories=AudioVideo;Video;
StartupWMClass=scenecue
`);

// taille installée, en Kio
let size = 0;
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p); else if (e.isFile()) size += fs.statSync(p).size;
  }
})(STAGE);

// t64 (Ubuntu 24.04) : libgtk-3-0t64, libasound2t64… fournissent les anciens noms, qui suffisent donc partout
write('DEBIAN/control', `Package: scenecue
Version: ${pkg.version}
Section: video
Priority: optional
Architecture: amd64
Installed-Size: ${Math.ceil(size / 1024)}
Depends: libgtk-3-0, libnss3, libasound2, libgbm1, libdrm2, libxkbcommon0, libcups2, libatspi2.0-0, libxcomposite1, libxdamage1, libxrandr2
Maintainer: SceneCue <https://github.com/${repo}>
Homepage: https://github.com/${repo}
Description: Scene control for streaming on Discord
 Animated text, images, videos and camera, shown on top of your screen
 on a transparent background, on demand or with a keyboard shortcut.
`);

execFileSync('dpkg-deb', ['--root-owner-group', '-Zxz', '--build', STAGE, OUT], { stdio: 'inherit' });
fs.rmSync(STAGE, { recursive: true, force: true });
console.log('Écrit dans', OUT);
