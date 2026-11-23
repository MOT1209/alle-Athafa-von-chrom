import { describe, expect, it, vi } from 'vitest';
import { RuntimeManager } from '../../src/runtime/manager';
import { TaskQueue } from '../../src/ai/queue';
import { SettingsStore } from '../../src/storage/settings';
import { MemoryStore } from '../../src/storage/kv';
import type { OllamaProvider, PullProgress } from '../../src/ai/providers/ollama';
import type { ChatResult, LoadedModel, ModelInfo, ProviderHealth } from '../../src/ai/types';
import { AppError } from '../../src/core/errors';

interface FakeBehavior {
  health?: ProviderHealth;
  models?: ModelInfo[];
  loaded?: LoadedModel[];
  chat?: (messages: unknown[], options: unknown) => Promise<ChatResult>;
  pull?: (model: string, onProgress?: (p: PullProgress) => void) => Promise<void>;
  deleteModel?: (model: string) => Promise<void>;
  version?: () => Promise<string>;
}

function makeManager(behavior: FakeBehavior = {}, queueOptions: {
  memoryGate?: (spec: { estimatedSizeBytes?: number }) => { allowed: boolean; reason?: string };
} = {}) {
  const settings = new SettingsStore(new MemoryStore());
  const queue = new TaskQueue({
    wait: async () => {},
    memoryGate: queueOptions.memoryGate as never,
  });
  const chatCalls: Array<{ messages: unknown[]; options: Record<string, unknown> }> = [];
  const provider = {
    id: 'ollama',
    health: async () => behavior.health ?? { ok: true, version: '0.40.6' },
    version: behavior.version ?? (async () => '0.40.6'),
    listModels: async () => behavior.models ?? [],
    loadedModels: async () => behavior.loaded ?? [],
    chat: async (messages: never[], options: never) => {
      chatCalls.push({ messages, options: options as Record<string, unknown> });
      if (behavior.chat) return behavior.chat(messages, options);
      return { content: 'OK', model: 'qwen2.5:1.5b', done: true };
    },
    chatStream: async () => ({ content: '', model: 'x', done: true }),
    pull: async (model: string, onProgress?: (p: PullProgress) => void) => {
      if (behavior.pull) return behavior.pull(model, onProgress);
      onProgress?.({ status: 'success' });
    },
    deleteModel: async (model: string) => {
      if (behavior.deleteModel) return behavior.deleteModel(model);
    },
  } as unknown as OllamaProvider;
  const manager = new RuntimeManager({
    settings,
    queue,
    makeProvider: () => provider,
  });
  return { manager, queue, settings, chatCalls };
}

const qwen: ModelInfo = { name: 'qwen2.5:1.5b', sizeBytes: 986_000_000 };

describe('RuntimeManager.status', () => {
  it('aggregates health, models, memory, queue and settings', async () => {
    const { manager } = makeManager({
      models: [qwen],
      loaded: [{ name: 'qwen2.5:1.5b', sizeBytes: 986_000_000, sizeVramBytes: 0 }],
    });
    const status = await manager.status();
    expect(status.ollama.reachable).toBe(true);
    expect(status.ollama.version).toBe('0.40.6');
    expect(status.models).toHaveLength(1);
    expect(status.loadedModels).toHaveLength(1);
    expect(status.settings.generation.model).toBe('qwen2.5:1.5b');
    expect(status.memory.reserveMb).toBe(3072);
    expect(status.queue).toEqual([]);
  });

  it('degrades honestly when Ollama is unreachable', async () => {
    const { manager } = makeManager({
      health: { ok: false, error: new AppError('NETWORK', 'down').toJSON() },
    });
    const status = await manager.status();
    expect(status.ollama.reachable).toBe(false);
    expect(status.ollama.error?.code).toBe('NETWORK');
    expect(status.models).toEqual([]);
    expect(status.loadedModels).toEqual([]);
  });
});

describe('RuntimeManager.testConnection', () => {
  it('reports version, model count and latency on success', async () => {
    const { manager } = makeManager({ models: [qwen] });
    const result = await manager.testConnection();
    expect(result.ok).toBe(true);
    expect(result.version).toBe('0.40.6');
    expect(result.modelCount).toBe(1);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('reports typed failure without throwing', async () => {
    const { manager } = makeManager({
      version: () => Promise.reject(new AppError('NETWORK', 'down')),
    });
    const result = await manager.testConnection();
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('NETWORK');
  });
});

describe('RuntimeManager.testModel', () => {
  it('rejects models that are not installed', async () => {
    const { manager } = makeManager({ models: [] });
    await expect(manager.testModel('qwen2.5:1.5b')).rejects.toMatchObject({
      code: 'MODEL_NOT_FOUND',
    });
  });

  it('rejects empty model names', async () => {
    const { manager } = makeManager();
    await expect(manager.testModel('  ')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('enqueues a real tiny generation and stores the reply', async () => {
    const { manager, queue, chatCalls } = makeManager({ models: [qwen] });
    const { taskId } = await manager.testModel('qwen2.5:1.5b');
    await vi.waitFor(() => expect(queue.get(taskId)?.status).toBe('succeeded'));
    const result = queue.get(taskId)?.result as { ok: boolean; reply: string };
    expect(result.ok).toBe(true);
    expect(result.reply).toBe('OK');
    expect(chatCalls[0]?.options.numPredict).toBe(8);
    expect(chatCalls[0]?.options.temperature).toBe(0);
    expect(chatCalls[0]?.options.model).toBe('qwen2.5:1.5b');
  });

  it('respects the memory gate via estimated model size', async () => {
    const { manager } = makeManager(
      { models: [{ name: 'big:70b', sizeBytes: 40_000_000_000 }] },
      {
        memoryGate: (spec) =>
          (spec.estimatedSizeBytes ?? 0) > 1_000_000_000
            ? { allowed: false, reason: 'too big' }
            : { allowed: true },
      },
    );
    await expect(manager.testModel('big:70b')).rejects.toMatchObject({
      code: 'MEMORY_BUDGET',
    });
  });

  it('surfaces model failures as failed tasks, not exceptions', async () => {
    const { manager, queue } = makeManager({
      models: [qwen],
      chat: () => Promise.reject(new AppError('MODEL_NOT_FOUND', 'gone')),
    });
    const { taskId } = await manager.testModel('qwen2.5:1.5b');
    await vi.waitFor(() => expect(queue.get(taskId)?.status).toBe('failed'));
    expect(queue.get(taskId)?.error?.code).toBe('MODEL_NOT_FOUND');
  });
});

describe('RuntimeManager.pullModel', () => {
  it('enqueues a pull with streaming progress', async () => {
    const { manager, queue } = makeManager({
      pull: async (_model, onProgress) => {
        onProgress?.({ status: 'downloading', percent: 50 });
        onProgress?.({ status: 'success' });
      },
    });
    const { taskId } = await manager.pullModel('qwen2.5:1.5b');
    await vi.waitFor(() => expect(queue.get(taskId)?.status).toBe('succeeded'));
    expect(queue.get(taskId)?.result).toEqual({ pulled: 'qwen2.5:1.5b' });
  });

  it('validates the model name', async () => {
    const { manager } = makeManager();
    await expect(manager.pullModel('')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('RuntimeManager.deleteModel', () => {
  it('deletes an unused model', async () => {
    const deleted: string[] = [];
    const { manager } = makeManager({
      deleteModel: async (model) => {
        deleted.push(model);
      },
    });
    expect(await manager.deleteModel('qwen2.5:1.5b')).toEqual({ deleted: true });
    expect(deleted).toEqual(['qwen2.5:1.5b']);
  });

  it('refuses to delete a model used by a pending task', async () => {
    const { manager, queue } = makeManager();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    queue.enqueue({ kind: 'model-test', label: 'x', model: 'qwen2.5:1.5b', run: () => gate });
    await expect(manager.deleteModel('qwen2.5:1.5b')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    release();
  });
});
