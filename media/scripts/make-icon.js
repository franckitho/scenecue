// Génère assets/icon.png sans dépendance : une photo (montagnes, soleil) posée sur une seconde, sur fond sombre.
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
function inTri(x, y, [ax, ay], [bx, by], [cx, cy]) {
  const s = (px, py, qx, qy, rx, ry) => (px - rx) * (qy - ry) - (qx - rx) * (py - ry);
  const d1 = s(x, y, ax, ay, bx, by), d2 = s(x, y, bx, by, cx, cy), d3 = s(x, y, cx, cy, ax, ay);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

const card = (cx, cy) => (x, y) => sdBox(x - cx, y - cy, 0.29, 0.21, 0.045) < 0;
const front = card(0.46, 0.56);
const LAYERS = [
  { c: hex('#17140F'), inside: (x, y) => sdBox(x - 0.5, y - 0.5, 0.5, 0.5, 0.22) < 0 },
  { c: hex('#5A5048'), inside: card(0.56, 0.44) },
  { c: hex('#F3EBDD'), inside: front },
  { c: hex('#2A2420'), inside: (x, y) => front(x, y) && (inTri(x, y, [0.15, 0.79], [0.34, 0.54], [0.53, 0.79]) || inTri(x, y, [0.39, 0.79], [0.55, 0.6], [0.77, 0.79])) },
  { c: hex('#FF4D1F'), inside: (x, y) => Math.hypot(x - 0.6, y - 0.46) < 0.055 },
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
