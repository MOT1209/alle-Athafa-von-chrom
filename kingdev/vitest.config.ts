import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@': r('./src'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environmentMatchGlobs: [['src/**/*.dom.test.ts', 'jsdom']],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: [
        '**/*.test.ts',
        '**/*.test.tsx',
        'src/browser/content/**',
        'src/browser/devtools/**',
        'src/background/**',
        // Phase 1 UI shell: rendering is exercised by the e2e package checks;
        // jsdom-based component tests land with Phase 2 consent wiring.
        'src/ui/**',
        '**/*.d.ts',
      ],
      // Enforced at 80%+ per project standard, with a little headroom above
      // the current 95.8/92.0/81.8/95.8 so ordinary work does not trip it.
      // The old 60/55/50/60 floor let untested modules (logger, event-bus)
      // ship at 0% while the suite still "passed".
      thresholds: {
        lines: 90,
        functions: 85,
        branches: 80,
        statements: 90,
      },
    },
  },
});
