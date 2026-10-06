// Écran virtuel (pilote Virtual Display Driver) : SceneCue le branche pour la diffusion et le débranche ensuite.
// Passe par vdisplay.ps1 dans Windows PowerShell 5.1 (ChangeDisplaySettingsEx, sans droits administrateur).
// Le script est envoyé en -EncodedCommand : PowerShell ne sait pas lire un fichier dans app.asar.
const { execFile, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SCRIPT = fs.readFileSync(path.join(__dirname, 'vdisplay.ps1'), 'utf8');
const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'];

const encode = (args) => {
  const command = `$Command = @(${args.map((a) => `'${String(a).replace(/'/g, "''")}'`).join(', ')})`;
  return Buffer.from(SCRIPT.replace(/^\$Command = .*$/m, () => command), 'utf16le').toString('base64');
};

// dernière ligne JSON écrite par le script
function parse(stdout, err) {
  const line = String(stdout || '').trim().split(/\r?\n/).pop() || '';
  try { return JSON.parse(line); } catch { return { ok: false, error: (err && err.message) || line || 'réponse illisible' }; }
}

const run = (...args) => new Promise((resolve) => {
  execFile('powershell.exe', [...PS_ARGS, encode(args)], { windowsHide: true, timeout: 20000 }, (err, stdout) => resolve(parse(stdout, err)));
});

// à la fermeture de SceneCue, quand on ne peut plus attendre
function runSync(...args) {
  try { return parse(execFileSync('powershell.exe', [...PS_ARGS, encode(args)], { windowsHide: true, timeout: 15000 })); } catch (e) { return { ok: false, error: e.message }; }
}

module.exports = {
  list: () => run('list'), // { ok, outputs: [{ name, adapter, attached, primary, virtual, x, y, w, h, hz, placed }] }
  attach: (name, w, h) => run('attach', name, w, h), // dans un coin, à cette résolution si le pilote la propose
  detach: (name) => run('detach', name),
  detachSync: (name) => runSync('detach', name),
};
