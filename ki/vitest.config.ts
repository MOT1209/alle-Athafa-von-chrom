import { defineConfig } from 'vitest/config';

// Tests import source modules via relative paths and inject all browser
// dependencies, so no WXT vite plugin is required here. This also avoids
// vite/rolldown-vite type duplication between WXT and Vitest.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/ui/**', 'src/background/**', 'src/ai/types.ts', 'src/**/*.d.ts'],
      thresholds: { lines: 85, functions: 85, branches: 80, statements: 85 },
      reporter: ['text', 'json-summary'],
      reportsDirectory: 'coverage',
    },
  },
});
