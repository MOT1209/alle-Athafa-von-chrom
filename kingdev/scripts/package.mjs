/**
 * Packaging (plan Phase 6 — release readiness).
 *
 * Deterministic, dependency-free zip of dist/ with self-verification:
 *
 *   - One `zip` entry per file, freshly stamped. CRC32 computed here — no
 *     `zip` binary, no `archiver`, nothing to trust.
 *   - Stored entries (no deflate). The extension payload is ~1.5 MB of JS
 *     that Chrome's Web Store re-compresses anyway; determinism beats the
 *     ~1.4 MB we would save.
 *   - Fixed timestamps (2026-01-01 00:00:00), fixed entry order (sorted),
 *     no external attributes. Same tree -> same bytes, every time.
 *
 * Self-verification — the packager does not take its own word for it:
 *
 *   - Every manifest-referenced file must exist in the zip.
 *   - Forbidden patterns are grepped out of the shipped JS (eval, new
 *     Function, remote code imports). The store review will look for these;
 *     we look first.
 *   - No source maps ship (.map files and sourceMappingURL comments are
 *     excluded — they leak the source tree layout into a public artifact).
 *   - The finished zip is re-read and each entry's CRC32 is recomputed and
 *     matched. A zip that fails its own read is never left on disk claiming
 *     to be a release.
 *
 * Usage: node scripts/package.mjs [--out <path>]
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'dist');

/* --- CRC32 (same table recipe as icons.mjs — proven here, reused there) --- */

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
  return (c ^ 0xffffffff) >>> 0;
}

/* --- zip writing --------------------------------------------------------- */

function u16(value) {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(value >>> 0, 0);
  return buf;
}

function u32(value) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value >>> 0, 0);
  return buf;
}

/**
 * One local file header + data, plus the central-directory record fields
 * the trailer needs later. `name` is already zip-relative (forward slashes).
 */
function zipEntry(name, data) {
  const nameBuf = Buffer.from(name, 'utf8');
  const crc = crc32(data);
  const size = data.length;

  // DOS time/date for 2026-01-01 00:00:00 local — fixed so bytes never shift.
  const dosTime = 0;
  const dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;

  const local = Buffer.concat([
    u32(0x04034b50), // local file header signature
    u16(20), // version needed (2.0 — stored dirs)
    u16(0x0800), // flags: UTF-8 names; sizes known up front (no data descriptor)
    u16(0), // method: stored
    u16(dosTime),
    u16(dosDate),
    u32(crc),
    u32(size), // compressed (= stored)
    u32(size), // uncompressed
    u16(nameBuf.length),
    u16(0), // extra field length
    nameBuf,
    data,
  ]);

  return { local, central: { name, nameBuf, crc, size } };
}

function centralHeader(entry, localOffset) {
  const { nameBuf, crc, size } = entry;
  return Buffer.concat([
    u32(0x02014b50), // central directory header signature
    u16(20), // version made by
    u16(20), // version needed
    u16(0x0800), // flags: UTF-8
    u16(0), // method: stored
    u16(0), // dos time
    u16(((2026 - 1980) << 9) | (1 << 5) | 1), // dos date
    u32(crc),
    u32(size),
    u32(size),
    u16(nameBuf.length),
    u16(0), // extra
    u16(0), // comment
    u16(0), // disk number start
    u16(0), // internal attrs
    u32(0), // external attrs — nothing about the host leaks
    u32(localOffset),
    nameBuf,
  ]);
}

/** Builds a complete zip buffer from an ordered name->bytes map. */
function buildZip(files) {
  const locals = [];
  const centrals = [];
  const centralMeta = [];
  let offset = 0;

  for (const [name, data] of files) {
    const entry = zipEntry(name, data);
    locals.push(entry.local);
    centralMeta.push({ entry, localOffset: offset });
    offset += entry.local.length;
  }
  for (const { entry, localOffset } of centralMeta) {
    const central = centralHeader(entry.central, localOffset);
    centrals.push(central);
    offset += central.length;
  }

  const trailer = Buffer.concat([
    u32(0x06054b50), // end of central directory
    u16(0), // disk number
    u16(0), // disk with central dir
    u16(files.length),
    u16(files.length),
    u32(centrals.reduce((sum, buf) => sum + buf.length, 0)),
    u32(offset), // central directory offset from start
    u16(0), // comment length
  ]);

  return Buffer.concat([...locals, ...centrals, trailer]);
}

/* --- tree walk and shipping rules ---------------------------------------- */

function walk(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...walk(abs, base));
    else out.push(relative(base, abs).split('\\').join('/'));
  }
  return out;
}

const SOURCE_MAP_RE = /\.map$/i;
const FORBIDDEN = [
  { label: 'eval() call', re: /\beval\s*\(/ },
  { label: 'new Function()', re: /\bnew\s+Function\s*\(/ },
  { label: 'remote code import', re: /\bimport\s*\(\s*['"]https?:/i },
  { label: 'document.write', re: /\bdocument\s*\.\s*write\s*\(/ },
];

/* --- self-verification: re-read the finished zip -------------------------- */

/** Recomputes CRC32 of every entry by walking local headers; throws on drift. */
function verifyZip(buffer, expectedNames) {
  let at = 0;
  const seen = [];
  while (buffer.readUInt32LE(at) === 0x04034b50) {
    const flags = buffer.readUInt16LE(at + 6);
    const method = buffer.readUInt16LE(at + 8);
    const crcStored = buffer.readUInt32LE(at + 14);
    const sizeCompressed = buffer.readUInt32LE(at + 18);
    const sizeUncompressed = buffer.readUInt32LE(at + 22);
    const nameLen = buffer.readUInt16LE(at + 26);
    const extraLen = buffer.readUInt16LE(at + 28);
    const name = buffer.subarray(at + 30, at + 30 + nameLen).toString('utf8');

    if (method !== 0) throw new Error(`entry ${name}: method ${method} — expected stored`);
    if (sizeCompressed !== sizeUncompressed) {
      throw new Error(`entry ${name}: compressed != uncompressed`);
    }
    const data = buffer.subarray(
      at + 30 + nameLen + extraLen,
      at + 30 + nameLen + extraLen + sizeUncompressed,
    );
    const crcActual = crc32(data);
    if (crcActual !== crcStored) {
      throw new Error(
        `entry ${name}: CRC drift (stored ${crcStored.toString(16)}, actual ${crcActual.toString(16)})`,
      );
    }
    if ((flags & 0x0800) === 0) throw new Error(`entry ${name}: UTF-8 flag missing`);
    seen.push(name);
    at += 30 + nameLen + extraLen + sizeUncompressed;
  }
  if (seen.length !== expectedNames.length) {
    throw new Error(`zip holds ${seen.length} entries, expected ${expectedNames.length}`);
  }
  for (let i = 0; i < seen.length; i++) {
    if (seen[i] !== expectedNames[i]) throw new Error(`entry order drifted at ${i}: ${seen[i]}`);
  }
}

/* --- run ------------------------------------------------------------------ */

// Output name: derived from the shipped manifest's version — one source of
// truth. `npm run release` expands $npm_package_version in its own arg, but a
// shell that does not expand it must never silently rename the artifact to
// the literal placeholder (that bit us once: kingdev-v$npm_package_version.zip).
const manifestForName = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
const defaultName = `kingdev-v${manifestForName.version}.zip`;
const outArgIdx = process.argv.indexOf('--out');
const rawOut = outArgIdx !== -1 ? process.argv[outArgIdx + 1] : undefined;
const outPath = resolve(
  root,
  !rawOut || rawOut.includes('$npm_package_version') ? defaultName : rawOut,
);

if (!existsSync(dist)) {
  console.error('[package] dist/ missing — run `npm run build` first');
  process.exit(1);
}

const allFiles = walk(dist);

// Shipping exclusions, visible not silent:
const skipped = allFiles.filter((f) => SOURCE_MAP_RE.test(f));
const files = allFiles.filter((f) => !SOURCE_MAP_RE.test(f));

// Forbidden patterns must not ride along inside the shipped JS.
for (const rel of files) {
  if (!rel.endsWith('.js')) continue;
  const source = readFileSync(join(dist, rel), 'utf8');
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  for (const rule of FORBIDDEN) {
    if (rule.re.test(stripped)) {
      console.error(`[package] forbidden pattern "${rule.label}" in dist/${rel}`);
      process.exit(1);
    }
  }
  const maps = /\/\/[#@]\s*sourceMappingURL/.test(source);
  if (maps) {
    console.error(`[package] sourceMappingURL left in dist/${rel} — source maps must not ship`);
    process.exit(1);
  }
}

// Manifest-referenced files must all be inside the package.
const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
const referenced = [
  manifest.background?.service_worker,
  manifest.devtools_page,
  manifest.options_ui?.page,
  ...Object.values(manifest.icons ?? {}),
].filter(Boolean);
const fileSet = new Set(files);
const missing = referenced.filter((rel) => !fileSet.has(rel));
if (missing.length > 0) {
  console.error(`[package] manifest references files missing from dist/: ${missing.join(', ')}`);
  process.exit(1);
}

const zipFiles = files
  .slice()
  .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  .map((name) => [name, readFileSync(join(dist, name))]);

const zip = buildZip(zipFiles);

// Self-verify before calling anything a release.
verifyZip(
  zip,
  zipFiles.map(([name]) => name),
);

writeFileSync(outPath, zip);

const sha = createHash('sha256').update(zip).digest('hex');
console.log(`[package] wrote ${relative(root, outPath).split('\\').join('/')}`);
console.log(`[package] entries: ${zipFiles.length} · size: ${(zip.length / 1024).toFixed(1)} KiB`);
console.log(`[package] sha256: ${sha}`);
if (skipped.length > 0) console.log(`[package] excluded source maps: ${skipped.join(', ')}`);
