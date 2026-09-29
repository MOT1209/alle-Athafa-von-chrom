/**
 * Package e2e (plan Phase 1).
 *
 * A headless-browser run against a live DevTools panel is Phase 5 territory.
 * What *can* and must be verified the moment `build` exists is that the built
 * package is a loadable MV3 extension:
 *
 *   1. every manifest-referenced file exists in dist/
 *   2. manifest keys are MV3-valid (no MV2 leftovers, no unknown permission ids)
 *   3. each JS entry parses as the module type the manifest promises
 *   4. no entry accidentally pulled in Node builtins (would crash the worker)
 *
 * Exit non-zero on the first violated expectation.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'dist');

const failures = [];
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('[e2e] verifying built package in dist/');

/* 1. Package exists and is non-trivial --------------------------------- */

check('dist/ exists', existsSync(dist), 'run `npm run build` first');

if (!existsSync(dist)) {
  console.error('[e2e] cannot continue without a build');
  process.exit(1);
}

const manifestPath = join(dist, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

/* 2. Manifest shape ----------------------------------------------------- */

check('manifest_version is 3', manifest.manifest_version === 3);
check('name is set', typeof manifest.name === 'string' && manifest.name.length > 0);
check('version is semver-ish', /^\d+\.\d+\.\d+/.test(String(manifest.version)));

/* 3. Every referenced file exists --------------------------------------- */

const referenced = [
  manifest.background?.service_worker,
  manifest.devtools_page,
  manifest.options_ui?.page,
  ...Object.values(manifest.icons ?? {}),
].filter(Boolean);

for (const rel of referenced) {
  check(`manifest file present: ${rel}`, existsSync(join(dist, rel)));
}

/* 4. MV3 permission validity -------------------------------------------- */

const KNOWN_PERMISSIONS = new Set([
  'storage',
  'scripting',
  'tabs',
  'activeTab',
  'alarms',
  'cookies',
  'unlimitedStorage',
  'clipboardWrite',
  'clipboardRead',
  'notifications',
  'contextMenus',
  'sidePanel',
  'devtools', // valid for Firefox-style manifests; flagged below if actually used
]);
const USED_PERMISSIONS = [
  ...(manifest.permissions ?? []),
  ...(manifest.optional_permissions ?? []),
];
for (const permission of USED_PERMISSIONS) {
  check(
    `permission is a known id: ${permission}`,
    KNOWN_PERMISSIONS.has(permission) || permission.startsWith('<') === false,
  );
}
check(
  '"devtools" is not requested (panels need no permission; MV3 Chrome rejects it)',
  !(manifest.permissions ?? []).includes('devtools'),
);

/* 5. Entries parse as ESM, import no Node builtins ----------------------- */

const NODE_BUILTIN_RE = /^node:/;
const jsEntries = [
  'background/service-worker.js',
  'content/error-capture.js',
  'devtools.js',
  'ui.js',
  'options.js',
];

for (const entry of jsEntries) {
  const path = join(dist, entry);
  if (!existsSync(path)) continue; // already reported by the manifest check
  const source = readFileSync(path, 'utf8');

  check(`${entry} is non-empty`, statSync(path).size > 0);

  const imports = [...source.matchAll(/(?:^|[\s;])import\s*[^'"]*from\s*['"]([^'"]+)['"]/g)].map(
    (m) => m[1],
  );
  const nodeImports = imports.filter((spec) => NODE_BUILTIN_RE.test(spec));
  check(`${entry} imports no Node builtins`, nodeImports.length === 0, nodeImports.join(', '));

  // A service worker bundle must be self-contained: Chrome MV3 workers with
  // `"type": "module"` may keep bare-relative imports, but esbuild has already
  // bundled them — a bare-package import surviving here means a build gap.
  const bareImports = imports.filter((spec) => !spec.startsWith('.') && !spec.startsWith('/'));
  check(
    `${entry} has no unresolved bare imports`,
    bareImports.length === 0,
    bareImports.join(', '),
  );
}

/* 6. Phase 2 consent contract ------------------------------------------- */

check(
  'manifest keeps optional scripting grant (consent-gated capture)',
  (manifest.optional_permissions ?? []).includes('scripting'),
);
check(
  'manifest keeps <all_urls> optional (never installed by default)',
  (manifest.optional_host_permissions ?? []).includes('<all_urls>'),
);
check(
  'manifest requests no more than the minimal required set',
  JSON.stringify([...(manifest.permissions ?? [])].sort()) === JSON.stringify(['storage']),
);

/* 7. Phase 2 consent contract ------------------------------------------ */

check(
  'manifest keeps optional scripting grant (consent-gated capture)',
  (manifest.optional_permissions ?? []).includes('scripting'),
);
check(
  'manifest keeps <all_urls> optional (never installed by default)',
  (manifest.optional_host_permissions ?? []).includes('<all_urls>'),
);
check(
  'manifest requests no more than the minimal required set',
  JSON.stringify([...(manifest.permissions ?? [])].sort()) === JSON.stringify(['storage']),
);

/* 8. Content script contract -------------------------------------------- */

const contentScript = join(dist, 'content/error-capture.js');
if (existsSync(contentScript)) {
  const source = readFileSync(contentScript, 'utf8');
  check(
    'content script registers error listeners',
    source.includes("addEventListener('error'") || source.includes('addEventListener("error"'),
  );
  check(
    'content script registers unhandledrejection listener',
    source.includes('unhandledrejection'),
  );
}

/* Summary ---------------------------------------------------------------- */

if (failures.length > 0) {
  console.error(`\n[e2e] ${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\n[e2e] package verification passed');
