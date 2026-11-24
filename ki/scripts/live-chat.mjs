/**
 * Runs the live Phase 4 chat acceptance test against a real local Ollama.
 * Usage: npm run test:live:chat
 * Requires `ollama serve` and an installed model (qwen2.5:1.5b preferred).
 *
 * Optional environment variables:
 *   VM_OLLAMA_URL           default http://127.0.0.1:11434
 *   VM_LIVE_CHAT_MODEL      force a specific installed model
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const vitestBin = join(root, 'node_modules', 'vitest', 'vitest.mjs');

const result = spawnSync(
  process.execPath,
  [vitestBin, 'run', 'tests/integration/chat.live.test.ts'],
  {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      VM_LIVE_OLLAMA: '1',
      VM_LIVE_CHAT: '1',
    },
  },
);
process.exit(result.status ?? 1);
