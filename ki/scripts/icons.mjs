/**
 * Deterministic icon generator (no dependencies).
 * Draws the videoKING mark: dark rounded square, indigo->cyan play triangle,
 * neural spark nodes. Renders at 4x supersampling, boxes down to target size.
 * Output bytes are identical across runs.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public');
mkdirSync(outDir, { recursive: true });

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([length, typeBuf, data, crc]);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function mixColor(c1, c2, t) {
  return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
}

const BG_TOP = [15, 23, 42];
const BG_BOTTOM = [30, 41, 59];
const TRI_LEFT = [99, 102, 241];
const TRI_RIGHT = [34, 211, 238];
const SPARK = [34, 211, 238];

const TRI = [
  [0.34, 0.26],
  [0.34, 0.74],
  [0.72, 0.5],
];

function sign(p, a, b) {
  return (p[0] - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (p[1] - b[1]);
}

function inTriangle(u, v) {
  const p = [u, v];
  const d1 = sign(p, TRI[0], TRI[1]);
  const d2 = sign(p, TRI[1], TRI[2]);
  const d3 = sign(p, TRI[2], TRI[0]);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

function inRoundedSquare(u, v) {
  const min = 0.02;
  const max = 0.98;
  const r = 0.22;
  const cx = Math.min(Math.max(u, min + r), max - r);
  const cy = Math.min(Math.max(v, min + r), max - r);
  const dx = u - cx;
  const dy = v - cy;
  return Math.sqrt(dx * dx + dy * dy) <= r;
}

const SPARKS = [
  [0.8, 0.2, 0.045],
  [0.88, 0.32, 0.028],
  [0.72, 0.1, 0.022],
];

function distToSegment(u, v, a, b) {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const apx = u - a[0];
  const apy = v - a[1];
  const len2 = abx * abx + aby * aby;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (apx * abx + apy * aby) / len2));
  const dx = u - (a[0] + abx * t);
  const dy = v - (a[1] + aby * t);
  return Math.sqrt(dx * dx + dy * dy);
}

function pixelAt(u, v) {
  if (!inRoundedSquare(u, v)) return [0, 0, 0, 0];
  let color = mixColor(BG_TOP, BG_BOTTOM, v);
  if (inTriangle(u, v)) {
    const t = Math.max(0, Math.min(1, (u - 0.34) / (0.72 - 0.34)));
    color = mixColor(TRI_LEFT, TRI_RIGHT, t);
  }
  for (const [sx, sy, sr] of SPARKS) {
    const dx = u - sx;
    const dy = v - sy;
    if (Math.sqrt(dx * dx + dy * dy) <= sr) color = SPARK;
  }
  for (let i = 0; i < SPARKS.length - 1; i++) {
    if (distToSegment(u, v, SPARKS[i], SPARKS[i + 1]) <= 0.006) {
      color = mixColor(color, SPARK, 0.8);
    }
  }
  return [color[0], color[1], color[2], 1];
}

function encodePng(size) {
  const ss = 4;
  const big = size * ss;
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    row[0] = 0;
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const px = (x * ss + sx + 0.5) / big;
          const py = (y * ss + sy + 0.5) / big;
          const [pr, pg, pb, pa] = pixelAt(px, py);
          r += pr * pa;
          g += pg * pa;
          b += pb * pa;
          a += pa;
        }
      }
      const n = ss * ss;
      const alpha = a / n;
      const offset = 1 + x * 4;
      if (a > 0) {
        row[offset] = Math.round(r / a);
        row[offset + 1] = Math.round(g / a);
        row[offset + 2] = Math.round(b / a);
      }
      row[offset + 3] = Math.round(alpha * 255);
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [16, 48, 128]) {
  const file = join(outDir, `icon-${size}.png`);
  writeFileSync(file, encodePng(size));
  console.log(`wrote ${file}`);
}
