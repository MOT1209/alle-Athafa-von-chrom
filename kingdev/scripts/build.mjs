/**
 * Build script (plan Phase 1).
 *
 * esbuild, four entry points, zero bundler plugins:
 *
 *   background/service-worker.js  <- src/background/service-worker.ts
 *   content/error-capture.js      <- src/browser/content/error-capture.ts
 *   devtools.js                   <- src/browser/devtools/panel.ts
 *   ui.js                         <- src/ui/main.tsx
 *
 * Static assets (manifest.json, *.html) are copied verbatim into dist/ so the
 * unpacked extension can be loaded directly from `kingdev/dist`.
 *
 * Fail behaviour: any missing entry or bundling error fails the script. The
 * plan's rule — never ship a build that "succeeded" while producing nothing —
 * is enforced here, not hoped for.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'dist');

/** Entry points copied to dist/ under the extension-root-relative name. */
const ENTRIES = [
  { in: 'src/background/service-worker.ts', out: 'background/service-worker' },
  { in: 'src/browser/content/error-capture.ts', out: 'content/error-capture' },
  { in: 'src/browser/devtools/panel.ts', out: 'devtools' },
  { in: 'src/ui/main.tsx', out: 'ui' },
];

const WATCH = process.argv.includes('--watch');

function copyStaticAssets() {
  const manifest = join(root, 'manifest.json');
  if (!existsSync(manifest)) {
    throw new Error('manifest.json missing at the project root — cannot build an extension.');
  }
  cpSync(manifest, join(dist, 'manifest.json'));

  for (const dir of ['src/browser/devtools', 'src/ui']) {
    const abs = join(root, dir);
    if (!existsSync(abs)) continue;
    for (const name of readdirSync(abs)) {
      if (name.endsWith('.html')) {
        cpSync(join(abs, name), join(dist, name));
      }
    }
  }

  // Icons are referenced by the manifest. Absence is not fatal while the
  // project has no icon set yet, but the fact must be visible.
  const icons = join(root, 'icons');
  if (existsSync(icons)) {
    cpSync(icons, join(dist, 'icons'), { recursive: true });
  } else {
    console.warn('[build] no icons/ directory — manifest icon entries will 404');
  }
}

function verifyOutput() {
  const required = [
    'manifest.json',
    'background/service-worker.js',
    'content/error-capture.js',
    'devtools.js',
    'devtools.html',
    'panel.html',
    'options.html',
    'ui.js',
  ];
  const missing = required.filter((name) => !existsSync(join(dist, name)));
  if (missing.length > 0) {
    throw new Error(`build produced an incomplete package, missing: ${missing.join(', ')}`);
  }

  const serviceWorker = statSync(join(dist, 'background/service-worker.js'));
  if (serviceWorker.size < 200) {
    throw new Error('service-worker.js is suspiciously small — the bundle is probably empty.');
  }
}

async function runOnce() {
  mkdirSync(dist, { recursive: true });

  const result = await build({
    entryPoints: ENTRIES.map((entry) => ({
      in: join(root, entry.in),
      out: entry.out,
    })),
    outdir: dist,
    outbase: root,
    bundle: true,
    format: 'esm',
    target: ['chrome116'],
    platform: 'browser',
    sourcemap: true,
    minify: false,
    jsx: 'automatic',
    logLevel: 'info',
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    },
  });

  if (result.errors.length > 0) {
    throw new Error(`esbuild reported ${result.errors.length} error(s)`);
  }

  copyStaticAssets();
  verifyOutput();
  console.log('[build] package complete in dist/');
}

try {
  if (WATCH) {
    // esbuild's watch mode with a rebuild hook that re-copies static assets.
    const ctx = await (await import('esbuild')).context({
      entryPoints: ENTRIES.map((entry) => ({
        in: join(root, entry.in),
        out: entry.out,
      })),
      outdir: dist,
      outbase: root,
      bundle: true,
      format: 'esm',
      target: ['chrome116'],
      platform: 'browser',
      sourcemap: true,
      minify: false,
      jsx: 'automatic',
    });
    await ctx.watch();
    copyStaticAssets();
    console.log('[build] watching for changes…');
  } else {
    await runOnce();
  }
} catch (cause) {
  console.error('[build] failed:', cause instanceof Error ? cause.message : cause);
  process.exitCode = 1;
}
