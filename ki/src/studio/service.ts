import { AppError } from '../core/errors';
import { generateStory } from '../ai/studio/generator';
import type { TaskQueue, TaskView } from '../ai/queue';
import type { LlmProvider } from '../ai/types';
import type { Settings, SettingsStore } from '../storage/settings';
import type { StoryRepository } from './repository';

export interface StoryServiceDeps {
  settings: SettingsStore;
  stories: StoryRepository;
  queue: TaskQueue;
  makeProvider: (settings: Settings) => LlmProvider;
  now?: () => number;
}

export interface GenerateStoryResult { taskId: string; deduped: boolean; }

const TASK_KIND = 'kids-story';

export class StoryService {
  private readonly settings: SettingsStore;
  private readonly stories: StoryRepository;
  private readonly queue: TaskQueue;
  private readonly makeProvider: StoryServiceDeps['makeProvider'];
  private readonly now: () => number;
  private readonly inflight = new Map<string, string>();

  constructor(deps: StoryServiceDeps) {
    this.settings = deps.settings;
    this.stories = deps.stories;
    this.queue = deps.queue;
    this.makeProvider = deps.makeProvider;
    this.now = deps.now ?? Date.now;
  }

  async generate(concept: string, transcriptHint?: string): Promise<GenerateStoryResult> {
    const cleanConcept = (concept || '').trim();
    if (cleanConcept.length === 0) throw new AppError('INVALID_INPUT', 'A concept is required');
    const key = cleanConcept.toLowerCase();
    const running = this.inflight.get(key);
    if (running) {
      const view = this.queue.get(running);
      if (view && (view.status === 'queued' || view.status === 'running')) return { taskId: running, deduped: true };
      this.inflight.delete(key);
    }

    const settings = await this.settings.load();
    const token = { id: '' };
    let task: TaskView;
    try {
      task = this.queue.enqueue({
        kind: TASK_KIND,
        label: `Kids story: ${cleanConcept}`,
        model: settings.generation.model,
        meta: { concept: cleanConcept },
        run: async (ctx) => {
          const current = await this.settings.load();
          const provider = this.makeProvider(current);
          const story = await generateStory(
            { concept: cleanConcept, ...(transcriptHint ? { transcriptHint } : {}) },
            {
              provider,
              model: current.generation.model,
              numCtx: current.generation.numCtx,
              numPredict: current.generation.numPredict,
              temperature: current.generation.temperature,
              keepAlive: current.memory.unloadAfterTask ? '0' : current.ollama.keepAlive,
              signal: ctx.signal,
            },
          );
          if (ctx.signal.aborted) throw new AppError('CANCELLED', 'Story generation cancelled');
          await this.stories.save({ concept: cleanConcept, story, model: current.generation.model, safe: true, now: this.now() });
          if (ctx.signal.aborted) throw new AppError('CANCELLED', 'Story generation cancelled');
          return { concept: cleanConcept };
        },
      });
    } catch (err) {
      throw err;
    }
    token.id = task.id;
    this.inflight.set(key, task.id);
    return { taskId: task.id, deduped: false };
  }

  async list() { return this.stories.list(); }
  async get(id: string) { return this.stories.get(id); }
  async remove(id: string) { return { removed: await this.stories.remove(id) }; }
}