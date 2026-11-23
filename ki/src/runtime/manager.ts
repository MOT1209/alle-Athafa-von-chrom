import { AppError } from '../core/errors';
import { buildBudget } from '../ai/memory';
import type { TaskQueue, TaskView } from '../ai/queue';
import type { OllamaProvider } from '../ai/providers/ollama';
import type {
  ConnectionTest,
  ModelTestResult,
  RuntimeStatus,
} from '../messaging/protocol';
import type { Settings, SettingsStore } from '../storage/settings';

/**
 * Runtime manager: the single business-logic entry point for the Local AI
 * Runtime module. UI and background handlers call these methods; nothing here
 * touches chrome.* so the whole module is unit-testable.
 */

export interface RuntimeManagerDeps {
  settings: SettingsStore;
  queue: TaskQueue;
  makeProvider: (settings: Settings) => OllamaProvider;
  now?: () => number;
}

export class RuntimeManager {
  private settings: SettingsStore;
  private queue: TaskQueue;
  private makeProvider: (settings: Settings) => OllamaProvider;
  private now: () => number;

  constructor(deps: RuntimeManagerDeps) {
    this.settings = deps.settings;
    this.queue = deps.queue;
    this.makeProvider = deps.makeProvider;
    this.now = deps.now ?? Date.now;
  }

  async status(): Promise<RuntimeStatus> {
    const settings = await this.settings.load();
    const provider = this.makeProvider(settings);
    const health = await provider.health();
    let models: RuntimeStatus['models'] = [];
    let loadedModels: RuntimeStatus['loadedModels'] = [];
    if (health.ok) {
      // Metadata endpoints only — no model inference happens here.
      const [loaded, installed] = await Promise.all([
        provider.loadedModels().catch(() => []),
        provider.listModels().catch(() => []),
      ]);
      loadedModels = loaded;
      models = installed;
    }
    const ollama: RuntimeStatus['ollama'] = { reachable: health.ok };
    if (health.version !== undefined) ollama.version = health.version;
    if (health.error !== undefined) ollama.error = health.error;
    return {
      ollama,
      models,
      loadedModels,
      memory: buildBudget(settings.memory.reserveMb),
      queue: this.queue.list(),
      settings,
    };
  }

  async testConnection(): Promise<ConnectionTest> {
    const settings = await this.settings.load();
    const provider = this.makeProvider(settings);
    const startedAt = this.now();
    try {
      const version = await provider.version();
      const models = await provider.listModels();
      return {
        ok: true,
        version,
        modelCount: models.length,
        latencyMs: this.now() - startedAt,
      };
    } catch (err) {
      return {
        ok: false,
        latencyMs: this.now() - startedAt,
        error: AppError.wrap(err).toJSON(),
      };
    }
  }

  /** Enqueue a real tiny generation to prove the model loads and replies. */
  async testModel(model: string): Promise<{ taskId: string }> {
    const name = this.requireModelName(model);
    const settings = await this.settings.load();
    const provider = this.makeProvider(settings);
    const installed = await provider.listModels();
    const info = installed.find((entry) => entry.name === name);
    if (!info) {
      throw new AppError(
        'MODEL_NOT_FOUND',
        `Model "${name}" is not installed in Ollama`,
        { hint: `Pull it first: ollama pull ${name}` },
      );
    }
    const task = this.queue.enqueue({
      kind: 'model-test',
      label: `Test ${name}`,
      model: name,
      estimatedSizeBytes: info.sizeBytes,
      run: async (ctx) => {
        const current = await this.settings.load();
        const liveProvider = this.makeProvider(current);
        const startedAt = this.now();
        const result = await liveProvider.chat(
          [
            {
              role: 'system',
              content: 'You are a connection test. Reply with one word only.',
            },
            { role: 'user', content: 'Reply with exactly: OK' },
          ],
          {
            model: name,
            numPredict: 8,
            temperature: 0,
            numCtx: Math.min(current.generation.numCtx, 2048),
            keepAlive: current.memory.unloadAfterTask
              ? '0'
              : current.ollama.keepAlive,
            signal: ctx.signal,
          },
        );
        const outcome: ModelTestResult = {
          ok: true,
          reply: result.content.trim(),
          latencyMs: this.now() - startedAt,
        };
        return outcome;
      },
    });
    return { taskId: task.id };
  }

  /** Enqueue a real model pull with streaming progress. */
  async pullModel(model: string): Promise<{ taskId: string }> {
    const name = this.requireModelName(model);
    const task = this.queue.enqueue({
      kind: 'model-pull',
      label: `Pull ${name}`,
      model: name,
      // Size is unknown before pulling; Ollama streams total/completed and the
      // memory gate applies when the model is later used for inference.
      maxRetries: 1,
      run: async (ctx) => {
        const current = await this.settings.load();
        const provider = this.makeProvider(current);
        await provider.pull(
          name,
          (progress) => {
            ctx.reportProgress({
              percent: progress.percent,
              message: progress.status,
            });
          },
          ctx.signal,
        );
        return { pulled: name };
      },
    });
    return { taskId: task.id };
  }

  async deleteModel(model: string): Promise<{ deleted: boolean }> {
    const name = this.requireModelName(model);
    const inUse = this.queue
      .list()
      .some(
        (task: TaskView) =>
          task.model === name &&
          (task.status === 'queued' || task.status === 'running'),
      );
    if (inUse) {
      throw new AppError(
        'INVALID_INPUT',
        `Model "${name}" is used by a queued or running task. Cancel the task first.`,
      );
    }
    const settings = await this.settings.load();
    const provider = this.makeProvider(settings);
    await provider.deleteModel(name);
    return { deleted: true };
  }

  private requireModelName(model: string): string {
    if (typeof model !== 'string' || model.trim().length === 0) {
      throw new AppError('INVALID_INPUT', 'A model name is required');
    }
    return model.trim();
  }
}
