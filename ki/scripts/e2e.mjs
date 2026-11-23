/**
 * Package integrity / Web Store readiness checks on the built output.
 * Runs against .output/chrome-mv3 after `wxt build`. No browser required.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, '.output', 'chrome-mv3');

let checks = 0;
let failures = 0;

function check(name, condition, detail) {
  checks += 1;
  if (condition) {
    console.log(`  ok  ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files;
}

if (!existsSync(outDir)) {
  console.error(`Build output missing: ${outDir}. Run "npm run build" first.`);
  process.exit(1);
}

const manifestPath = join(outDir, 'manifest.json');
check('manifest.json exists', existsSync(manifestPath));
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

check('manifest_version is 3', manifest.manifest_version === 3);
check('name is videoKING AI', manifest.name === 'videoKING AI');
check(
  'version matches package.json',
  manifest.version === pkg.version,
  `${manifest.version} vs ${pkg.version}`,
);
check(
  'description is ASCII printable',
  typeof manifest.description === 'string' &&
    [...manifest.description].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) <= 126),
);
check(
  'permissions are minimal (storage, alarms)',
  JSON.stringify([...(manifest.permissions ?? [])].sort()) ===
    JSON.stringify(['alarms', 'storage']),
  JSON.stringify(manifest.permissions),
);
const hosts = manifest.host_permissions ?? [];
check(
  'host_permissions are loopback-only',
  hosts.length > 0 &&
    hosts.every((h) => /^http:\/\/(localhost|127\.0\.0\.1):11434\/\*$/.test(h)),
  JSON.stringify(hosts),
);
check(
  'no optional remote host permissions',
  (manifest.optional_host_permissions ?? []).every((h) =>
    /^http:\/\/(localhost|127\.0\.0\.1)/.test(h),
  ),
);
const cs = manifest.content_scripts ?? [];
check('content scripts declared (phase 2)', cs.length > 0);
check(
  'content scripts restricted to YouTube',
  cs.every((entry) =>
    (entry.matches ?? []).every((m) => /^\*:\/\/\*\.youtube\.com\/\*$/.test(m)),
  ),
  JSON.stringify(cs.map((e) => e.matches)),
);
for (const entry of cs) {
  for (const js of entry.js ?? []) {
    check(`content script file exists: ${js}`, existsSync(join(outDir, js)));
  }
}
check(
  'no externally_connectable',
  manifest.externally_connectable === undefined,
);

const sw = manifest.background?.service_worker;
check('background.service_worker declared', typeof sw === 'string');
check('service worker file exists', sw && existsSync(join(outDir, sw)));

const popup = manifest.action?.default_popup;
check('action.default_popup declared', typeof popup === 'string');
check('popup file exists', popup && existsSync(join(outDir, popup)));

for (const size of [16, 48, 128]) {
  const iconRel = manifest.icons?.[String(size)];
  check(`icon ${size} declared`, typeof iconRel === 'string');
  if (!iconRel) continue;
  const iconPath = join(outDir, iconRel);
  const exists = existsSync(iconPath);
  check(`icon ${size} file exists`, exists);
  if (!exists) continue;
  const buf = readFileSync(iconPath);
  const isPng =
    buf.length > 24 &&
    buf[0] === 137 &&
    buf[1] === 80 &&
    buf[2] === 78 &&
    buf[3] === 71;
  check(`icon ${size} is PNG`, isPng);
  if (isPng) {
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    check(`icon ${size} dimensions`, width === size && height === size, `${width}x${height}`);
  }
}

const files = walk(outDir);
const rel = (f) => relative(outDir, f).replaceAll('\\', '/');

check(
  'no source maps shipped',
  files.every((f) => !f.endsWith('.map')),
);
check(
  'no OS junk files',
  files.every((f) => !/(^|\/)(\.DS_Store|Thumbs\.db)$/.test(rel(f))),
);

const jsFiles = files.filter((f) => f.endsWith('.js'));
check('JS bundle present', jsFiles.length > 0);
for (const file of jsFiles) {
  const code = readFileSync(file, 'utf8');
  const name = rel(file);
  check(`${name}: no eval`, !/\beval\s*\(/.test(code));
  check(`${name}: no new Function`, !/new\s+Function\s*\(/.test(code));
  check(`${name}: no document.write`, !/document\.write\s*\(/.test(code));
  check(`${name}: no remote dynamic import`, !/import\s*\(\s*["']https?:/.test(code));
  check(`${name}: no sourceMappingURL`, !/sourceMappingURL/.test(code));
}

if (popup) {
  const html = readFileSync(join(outDir, popup), 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((r) => !r.startsWith('http') && !r.startsWith('data:'));
  for (const ref of refs) {
    check(`popup asset exists: ${ref}`, existsSync(join(outDir, popup, '..', ref)));
  }
}

const manifestText = JSON.stringify(manifest);
check(
  'no remote code URLs in manifest',
  !/https?:\/\//.test(
    manifestText.replace(/http:\/\/(localhost|127\.0\.0\.1):11434\/\*/g, ''),
  ),
);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('Package is ready for chrome://extensions (load unpacked).');
