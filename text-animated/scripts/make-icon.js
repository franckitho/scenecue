// Génère assets/icon.png, assets/icon.ico et assets/tray(@2x).png sans dépendance.
// Dessin : une pancarte crème sur un manche, avec un voyant rouge, sur fond sombre.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'assets');
fs.mkdirSync(OUT, { recursive: true });

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

function sdBox(px, py, bx, by, r) {
  const qx = Math.abs(px) - bx + r, qy = Math.abs(py) - by + r;
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}
function rot(x, y, deg) {
  const a = (-deg * Math.PI) / 180;
  return [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];
}

// couches dessinées dans l'ordre ; inside(x, y) en coordonnées 0..1
function layers(withBg) {
  const signAt = (x, y) => rot(x - 0.5, y - 0.4, -6);
  const L = [];
  if (withBg) L.push({ c: hex('#17140F'), inside: (x, y) => sdBox(x - 0.5, y - 0.5, 0.5, 0.5, 0.22) < 0 });
  L.push({ c: hex('#B08D63'), inside: (x, y) => sdBox(x - 0.5, y - 0.73, 0.05, 0.2, 0.02) < 0 });
  L.push({ c: hex('#F3EBDD'), inside: (x, y) => { const [u, v] = signAt(x, y); return sdBox(u, v, 0.36, 0.21, 0.05) < 0; } });
  L.push({ c: hex('#FF4D1F'), inside: (x, y) => { const [u, v] = signAt(x, y); return Math.hypot(u + 0.2, v) < 0.08; } });
  L.push({ c: hex('#2A2420'), inside: (x, y) => { const [u, v] = signAt(x, y); return sdBox(u - 0.08, v + 0.06, 0.15, 0.027, 0.027) < 0; } });
  L.push({ c: hex('#2A2420'), inside: (x, y) => { const [u, v] = signAt(x, y); return sdBox(u - 0.04, v - 0.06, 0.11, 0.027, 0.027) < 0; } });
  return L;
}

function render(size, withBg = true) {
  const L = layers(withBg);
  const S = 4; // sur-échantillonnage
  const buf = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const x = (px + (sx + 0.5) / S) / size, y = (py + (sy + 0.5) / S) / size;
          let col = null;
          for (const l of L) if (l.inside(x, y)) col = l.c;
          if (col) { r += col[0]; g += col[1]; b += col[2]; a += 1; }
        }
      }
      const i = (py * size + px) * 4;
      buf[i] = a ? r / a : 0;
      buf[i + 1] = a ? g / a : 0;
      buf[i + 2] = a ? b / a : 0;
      buf[i + 3] = Math.round((a / (S * S)) * 255);
    }
  }
  return encodePng(size, size, buf);
}

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function encodeIco(images) { // [{ size, png }]
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(images.length, 4);
  const dir = Buffer.alloc(16 * images.length);
  let offset = 6 + dir.length;
  images.forEach(({ size, png }, i) => {
    const o = i * 16;
    dir[o] = size >= 256 ? 0 : size;
    dir[o + 1] = size >= 256 ? 0 : size;
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += png.length;
  });
  return Buffer.concat([head, dir, ...images.map((x) => x.png)]);
}

const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = sizes.map((size) => ({ size, png: render(size) }));
fs.writeFileSync(path.join(OUT, 'icon.png'), pngs.find((p) => p.size === 256).png);
fs.writeFileSync(path.join(OUT, 'icon.ico'), encodeIco(pngs));
fs.writeFileSync(path.join(OUT, 'tray.png'), render(16));
fs.writeFileSync(path.join(OUT, 'tray@2x.png'), render(32));
console.log('Icônes générées dans', OUT);
