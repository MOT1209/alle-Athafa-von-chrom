/**
 * Runs the live Ollama integration tests against a real local server.
 * Usage: npm run test:live   (requires `ollama serve` to be running)
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const vitestBin = join(root, 'node_modules', 'vitest', 'vitest.mjs');

const result = spawnSync(
  process.execPath,
  [vitestBin, 'run', 'tests/integration'],
  {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, VM_LIVE_OLLAMA: '1' },
  },
);
process.exit(result.status ?? 1);
