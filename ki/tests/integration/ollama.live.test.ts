/**
 * LIVE integration tests against a real local Ollama server.
 * Skipped by default; run with: npm run test:live  (needs `ollama serve`).
 * These prove the provider works end-to-end on the target hardware.
 */
import { describe, expect, it } from 'vitest';
import { OllamaProvider } from '../../src/ai/providers/ollama';

const live = process.env.VM_LIVE_OLLAMA === '1';
const baseUrl = process.env.VM_OLLAMA_URL ?? 'http://127.0.0.1:11434';

const provider = new OllamaProvider({ baseUrl, requestTimeoutMs: 120_000 });

// Discover installed models once (only when live).
const installed = live
  ? await provider.listModels().catch(() => [])
  : [];
const targetModel =
  installed.find((m) => m.name === 'qwen2.5:1.5b')?.name ??
  installed[0]?.name;

describe.skipIf(!live)('Ollama LIVE integration', () => {
  it('reads the real server version', async () => {
    const version = await provider.version();
    expect(version).toMatch(/^\d+\.\d+/);
    console.log(`[live] Ollama version: ${version}`);
  });

  it('health() reports reachable', async () => {
    const health = await provider.health();
    expect(health.ok).toBe(true);
  });

  it('lists real installed models', async () => {
    expect(installed.length).toBeGreaterThan(0);
    for (const model of installed) {
      expect(model.sizeBytes).toBeGreaterThan(0);
    }
    console.log(`[live] installed: ${installed.map((m) => m.name).join(', ')}`);
  });

  it('reads loaded models (/api/ps)', async () => {
    const loaded = await provider.loadedModels();
    expect(Array.isArray(loaded)).toBe(true);
  });

  it.runIf(Boolean(targetModel))(
    `runs a real tiny generation with ${targetModel ?? 'no model'}`,
    async () => {
      const startedAt = Date.now();
      const result = await provider.chat(
        [
          { role: 'system', content: 'You are a connection test. Reply with one word only.' },
          { role: 'user', content: 'Reply with exactly: OK' },
        ],
        { model: targetModel, numPredict: 8, temperature: 0, numCtx: 2048, keepAlive: '0' },
      );
      const elapsed = Date.now() - startedAt;
      expect(result.done).toBe(true);
      expect(result.content.trim().length).toBeGreaterThan(0);
      console.log(
        `[live] model=${targetModel} reply="${result.content.trim()}" latency=${elapsed}ms evalCount=${result.evalCount}`,
      );
    },
    180_000,
  );

  it.runIf(Boolean(targetModel))(
    'streams real tokens via chatStream',
    async () => {
      const tokens: string[] = [];
      const result = await provider.chatStream(
        [{ role: 'user', content: 'Count from 1 to 5, digits only, separated by spaces.' }],
        { model: targetModel, numPredict: 24, temperature: 0, keepAlive: '0' },
        (token) => tokens.push(token),
      );
      expect(result.done).toBe(true);
      expect(tokens.length).toBeGreaterThan(0);
      expect(result.content.length).toBeGreaterThan(0);
      console.log(`[live] streamed ${tokens.length} chunks: "${result.content.trim()}"`);
    },
    180_000,
  );
});
