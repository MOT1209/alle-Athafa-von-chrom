/**
 * Generates the KingDev extension icons (16/48/128 px) as real PNG files.
 *
 * Runs on plain Node with zero dependencies — the PNG is written by hand:
 * a filled rounded-ish disc with a crown silhouette, derived from the
 * product name (KingDev). Deterministic output: same bytes every run, so
 * re-running never dirties the working tree.
 *
 * Usage: node scripts/icons.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const outDir = join(root, 'icons');

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  c = (c ^ 0xffffffff) >>> 0;
  return c;
}

function writeUint32(buf, value, offset) {
  buf.writeUInt32BE(value >>> 0, offset);
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  writeUint32(length, data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  writeUint32(crc, crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}
function png(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  writeUint32(ihdr, width, 0);
  writeUint32(ihdr, height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  // zlib store blocks — no compression, valid stream, no dependencies.
  const maxBlock = 0xffff;
  const blocks = Math.ceil(raw.length / maxBlock) || 1;
  const stored = Buffer.alloc(2 + blocks * 5 + raw.length + 4);
  let at = 0;
  stored[at++] = 0x78;
  stored[at++] = 0x01;
  for (let i = 0; i < blocks; i++) {
    const size = Math.min(maxBlock, raw.length - i * maxBlock);
    stored[at++] = i === blocks - 1 ? 1 : 0;
    stored[at++] = size & 0xff;
    stored[at++] = size >> 8;
    stored[at++] = ~size & 0xff;
    stored[at++] = (~size >>> 8) & 0xff;
    raw.copy(stored, at, i * maxBlock, i * maxBlock + size);
    at += size;
  }
  // Adler-32 over raw
  let a = 1;
  let b = 0;
  for (const byte of raw) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  writeUint32(stored, ((b & 0xffff) << 16) | (a & 0xffff), stored.length - 4);
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', stored),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* --- drawing --------------------------------------------------------- */

const BG = [15, 18, 26, 255]; // near-black blue
const FG = [250, 204, 21, 255]; // amber crown
const EDGE = [59, 130, 246, 255]; // blue rim

function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const centre = (size - 1) / 2;
  const radius = size / 2 - 1;
  const unit = size / 16;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - centre;
      const dy = y - centre;
      const dist = Math.hypot(dx, dy);
      const i = (y * size + x) * 4;
      let px = [0, 0, 0, 0];

      // Background disc with a thin rim.
      if (dist <= radius) {
        px = dist >= radius - Math.max(1, unit * 0.7) ? EDGE : BG;
      }

      // Crown silhouette (filled): three points + base bar, sized in units.
      const nx = dx / unit;
      const ny = dy / unit;
      const inCrownBase = ny >= 3.4 && ny <= 5.2 && nx >= -4.6 && nx <= 4.6;
      const leftSpike = nx >= -4.4 && nx <= -1.5 && ny >= -3.8 && ny <= 3.4 && ny >= 1.4 * nx + 2.4;
      const midSpike = nx >= -1.4 && nx <= 1.4 && ny >= -4.6 && ny <= 3.4;
      const rightSpike = nx >= 1.5 && nx <= 4.4 && ny >= -3.8 && ny <= 3.4 && ny >= -1.4 * nx + 2.4;
      if (px[3] === 255 && (inCrownBase || leftSpike || midSpike || rightSpike)) {
        px = FG;
      }

      rgba[i] = px[0];
      rgba[i + 1] = px[1];
      rgba[i + 2] = px[2];
      rgba[i + 3] = px[3];
    }
  }
  return rgba;
}

mkdirSync(outDir, { recursive: true });
for (const size of [16, 48, 128]) {
  const file = join(outDir, `kingdev-${size}.png`);
  writeFileSync(file, png(size, size, drawIcon(size)));
  console.log(`[icons] wrote ${file}`);
}
