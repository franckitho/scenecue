// Certificat HTTPS auto-signé, sans dépendance (encodage ASN.1 DER à la main).
// Safari sur iPhone n'autorise la caméra que sur une page HTTPS : l'utilisateur accepte l'avertissement une fois.
// Respecte les exigences d'iOS : clé ECDSA P-256, SHA-256, noms dans subjectAltName, usage serverAuth, validité < 825 jours.
const crypto = require('crypto');

function len(n) {
  if (n < 0x80) return Buffer.from([n]);
  if (n < 0x100) return Buffer.from([0x81, n]);
  return Buffer.from([0x82, n >> 8, n & 0xff]);
}
const tlv = (tag, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), len(body.length), body]);
};
const seq = (...p) => tlv(0x30, ...p);
const set = (...p) => tlv(0x31, ...p);
function oid(s) {
  const a = s.split('.').map(Number);
  const out = [40 * a[0] + a[1]];
  for (const n of a.slice(2)) {
    const b = [n & 0x7f];
    for (let v = n >>> 7; v; v >>>= 7) b.unshift((v & 0x7f) | 0x80);
    out.push(...b);
  }
  return tlv(0x06, Buffer.from(out));
}
const int = (buf) => tlv(0x02, buf[0] & 0x80 ? Buffer.concat([Buffer.from([0]), buf]) : buf);
const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
const time = (d) => tlv(0x17, Buffer.from(`${d.toISOString().replace(/[-:T]/g, '').slice(2, 14)}Z`)); // UTCTime
const ext = (id, critical, value) => seq(oid(id), ...(critical ? [tlv(0x01, Buffer.from([0xff]))] : []), tlv(0x04, value));
const ipBytes = (ip) => Buffer.from(ip.split('.').map(Number));

const ECDSA_SHA256 = '1.2.840.10045.4.3.2';
const VALID_DAYS = 800;

// → { key, cert } au format PEM, valable pour les noms et adresses IPv4 donnés
function makeCert({ name = 'Regie camera', dns = ['localhost'], ips = ['127.0.0.1'] } = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const serial = crypto.randomBytes(16);
  serial[0] &= 0x7f;
  const now = Date.now();
  const subject = seq(set(seq(oid('2.5.4.3'), utf8(name))));
  const san = seq(...dns.map((d) => tlv(0x82, Buffer.from(d, 'ascii'))), ...ips.map((ip) => tlv(0x87, ipBytes(ip))));
  const tbs = seq(
    tlv(0xa0, int(Buffer.from([2]))), // version 3
    int(serial),
    seq(oid(ECDSA_SHA256)),
    subject, // émetteur = sujet (auto-signé)
    seq(time(new Date(now - 86400000)), time(new Date(now + VALID_DAYS * 86400000))),
    subject,
    publicKey.export({ type: 'spki', format: 'der' }),
    tlv(0xa3, seq(
      ext('2.5.29.19', true, seq()), // basicConstraints : pas une autorité
      ext('2.5.29.15', true, tlv(0x03, Buffer.from([0x07, 0x80]))), // keyUsage : digitalSignature
      ext('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1'))), // extKeyUsage : serverAuth
      ext('2.5.29.17', false, san),
    )),
  );
  const sig = crypto.sign('sha256', tbs, privateKey); // ECDSA en DER, comme l'attend X.509
  const der = seq(tbs, seq(oid(ECDSA_SHA256)), tlv(0x03, Buffer.concat([Buffer.from([0]), sig])));
  const pem = `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
  return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }), cert: pem };
}

// le certificat couvre-t-il ces adresses, et reste-t-il valable au moins un mois ?
function certCovers(pem, ips) {
  try {
    const x = new crypto.X509Certificate(pem);
    if (Date.parse(x.validTo) - Date.now() < 30 * 86400000) return false;
    const san = x.subjectAltName || '';
    return ips.every((ip) => san.includes(`IP Address:${ip}`));
  } catch { return false; }
}

module.exports = { makeCert, certCovers };
