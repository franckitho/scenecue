// Génère assets/icon.png sans dépendance : les barres d'un égaliseur (claires, une orange) sur fond sombre.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'assets');
fs.mkdirSync(OUT, { recursive: true });

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

function sdBox(px, py, bx, by, r) {
  const qx = Math.abs(px) - bx + r, qy = Math.abs(py) - by + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
// barre arrondie posée sur la ligne de base, de hauteur h
const bar = (cx, h) => (x, y) => sdBox(x - cx, y - (0.75 - h / 2), 0.052, h / 2, 0.052) < 0;
const LAYERS = [
  { c: hex('#17140F'), inside: (x, y) => sdBox(x - 0.5, y - 0.5, 0.5, 0.5, 0.22) < 0 },
  { c: hex('#F3EBDD'), inside: bar(0.275, 0.34) },
  { c: hex('#F3EBDD'), inside: bar(0.425, 0.5) },
  { c: hex('#FF4D1F'), inside: bar(0.575, 0.26) },
  { c: hex('#F3EBDD'), inside: bar(0.725, 0.42) },
];

function render(size) {
  const S = 4;
  const buf = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const x = (px + (sx + 0.5) / S) / size, y = (py + (sy + 0.5) / S) / size;
          let col = null;
          for (const l of LAYERS) if (l.inside(x, y)) col = l.c;
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
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.writeFileSync(path.join(OUT, 'icon.png'), render(256));
console.log('Icône générée dans', OUT);
