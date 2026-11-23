import { AppError, type SerializedError } from '../core/errors';
import { Emitter } from '../core/events';
import { newId } from '../core/ids';
import { sleep } from '../core/abort';

/**
 * Sequential AI task queue.
 *
 * Guarantees:
 *  - At most ONE task executes at any time (hardware constraint: 8 GB RAM,
 *    never load several models simultaneously).
 *  - Cancellation propagates via AbortSignal into fetch/stream/retry-wait.
 *  - Retryable failures retry with exponential backoff, bounded by maxRetries.
 *  - An optional memory gate rejects tasks before they start.
 *  - Terminal history is bounded (prune) and exportable for SW-restart restore.
 *
 * The queue is runtime-agnostic: it executes `spec.run` closures, so LLM chat,
 * model pulls, Whisper transcription and Piper synthesis all share one lane.
 */

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface TaskProgress {
  percent?: number;
  message?: string;
}

export interface TaskContext {
  signal: AbortSignal;
  reportProgress: (progress: TaskProgress) => void;
}

export interface TaskSpec {
  kind: string;
  label: string;
  model?: string;
  estimatedSizeBytes?: number;
  maxRetries?: number;
  run: (ctx: TaskContext) => Promise<unknown>;
}

export interface TaskView {
  id: string;
  kind: string;
  label: string;
  model?: string;
  status: TaskStatus;
  attempts: number;
  maxRetries: number;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  progress?: TaskProgress;
  error?: SerializedError;
  result?: unknown;
  waitingRetry?: boolean;
  /** True when restored after a service-worker restart (spec lost). */
  orphaned?: boolean;
}

export type QueueEvents = {
  'task-added': TaskView;
  'task-updated': TaskView;
  'task-progress': { taskId: string; progress: TaskProgress };
  'queue-changed': TaskView[];
};

export interface MemoryGateVerdict {
  allowed: boolean;
  reason?: string;
}

export type MemoryGate = (spec: TaskSpec) => MemoryGateVerdict;

export interface TaskQueueOptions {
  maxQueueSize?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  memoryGate?: MemoryGate;
  events?: Emitter<QueueEvents>;
  now?: () => number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  onChange?: (views: TaskView[]) => void;
  terminalHistoryLimit?: number;
}

interface InternalTask {
  view: TaskView;
  spec: TaskSpec | null;
  controller?: AbortController;
}

const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'succeeded',
  'failed',
  'cancelled',
]);

export class TaskQueue {
  readonly events: Emitter<QueueEvents>;
  private tasks = new Map<string, InternalTask>();
  private order: string[] = [];
  private runningId: string | null = null;
  private pumping = false;
  private maxQueueSize: number;
  private maxRetries: number;
  private retryBaseDelayMs: number;
  private terminalHistoryLimit: number;
  private memoryGate?: MemoryGate;
  private now: () => number;
  private wait: (ms: number, signal: AbortSignal) => Promise<void>;
  private onChange?: (views: TaskView[]) => void;

  constructor(options: TaskQueueOptions = {}) {
    this.maxQueueSize = options.maxQueueSize ?? 20;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 1500;
    this.terminalHistoryLimit = options.terminalHistoryLimit ?? 25;
    this.memoryGate = options.memoryGate;
    this.events = options.events ?? new Emitter<QueueEvents>();
    this.now = options.now ?? Date.now;
    this.wait = options.wait ?? sleep;
    this.onChange = options.onChange;
  }

  configure(options: {
    maxQueueSize?: number;
    maxRetries?: number;
    retryBaseDelayMs?: number;
    memoryGate?: MemoryGate;
  }): void {
    if (options.maxQueueSize !== undefined)
      this.maxQueueSize = options.maxQueueSize;
    if (options.maxRetries !== undefined) this.maxRetries = options.maxRetries;
    if (options.retryBaseDelayMs !== undefined)
      this.retryBaseDelayMs = options.retryBaseDelayMs;
    if (options.memoryGate !== undefined) this.memoryGate = options.memoryGate;
  }

  /* ---------------- public API ---------------- */

  enqueue(spec: TaskSpec): TaskView {
    if (!spec || typeof spec.run !== 'function') {
      throw new AppError('INVALID_INPUT', 'Task spec must provide run()');
    }
    this.assertCapacity();
    this.assertMemory(spec);
    const view: TaskView = {
      id: newId('task'),
      kind: spec.kind,
      label: spec.label,
      status: 'queued',
      attempts: 0,
      maxRetries: spec.maxRetries ?? this.maxRetries,
      createdAt: this.now(),
    };
    if (spec.model !== undefined) view.model = spec.model;
    this.tasks.set(view.id, { view, spec });
    this.order.push(view.id);
    this.emitAdded(view);
    const snapshot = structuredClone(view);
    void this.pump();
    return snapshot;
  }

  cancel(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    if (task.view.status === 'queued') {
      task.view.status = 'cancelled';
      task.view.finishedAt = this.now();
      task.view.error = new AppError(
        'CANCELLED',
        'Cancelled before start',
      ).toJSON();
      this.emitUpdated(task.view);
      return true;
    }
    if (task.view.status === 'running') {
      task.controller?.abort();
      return true;
    }
    return false;
  }

  retry(taskId: string): TaskView {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new AppError('INVALID_INPUT', `Unknown task: ${taskId}`);
    }
    if (task.view.status !== 'failed' && task.view.status !== 'cancelled') {
      throw new AppError(
        'INVALID_INPUT',
        'Only failed or cancelled tasks can be retried',
      );
    }
    if (!task.spec) {
      throw new AppError(
        'INVALID_INPUT',
        'This task was interrupted by a browser restart and cannot be retried automatically. Run it again from the UI.',
      );
    }
    this.assertCapacity();
    this.assertMemory(task.spec);
    const view = task.view;
    view.status = 'queued';
    view.attempts = 0;
    view.createdAt = this.now();
    delete view.startedAt;
    delete view.finishedAt;
    delete view.progress;
    delete view.error;
    delete view.result;
    delete view.waitingRetry;
    this.emitUpdated(view);
    const snapshot = structuredClone(view);
    void this.pump();
    return snapshot;
  }

  get(taskId: string): TaskView | undefined {
    const task = this.tasks.get(taskId);
    return task ? structuredClone(task.view) : undefined;
  }

  list(): TaskView[] {
    const views: TaskView[] = [];
    for (const id of this.order) {
      const task = this.tasks.get(id);
      if (task) views.push(structuredClone(task.view));
    }
    return views;
  }

  pendingCount(): number {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (task.view.status === 'queued' || task.view.status === 'running')
        count += 1;
    }
    return count;
  }

  isBusy(): boolean {
    return this.pendingCount() > 0;
  }

  /**
   * Restore persisted views after a service-worker restart. In-flight work
   * cannot survive an SW kill, so running/queued views become failed with a
   * retryable INTERNAL error and no spec (honest: we do not pretend to resume).
   */
  restore(views: TaskView[]): void {
    for (const raw of views) {
      if (!raw || typeof raw.id !== 'string') continue;
      if (this.tasks.has(raw.id)) continue;
      const view = structuredClone(raw);
      if (view.status === 'running' || view.status === 'queued') {
        view.status = 'failed';
        view.finishedAt = this.now();
        view.orphaned = true;
        view.error = new AppError(
          'INTERNAL',
          'Task interrupted by a browser/service-worker restart',
          { retryable: true },
        ).toJSON();
        delete view.progress;
        delete view.waitingRetry;
      }
      this.tasks.set(view.id, { view, spec: null });
      this.order.push(view.id);
    }
    this.prune();
    this.notifyChange();
  }

  /** Drop oldest terminal tasks beyond the history limit. */
  prune(): void {
    const terminalIds = this.order.filter((id) => {
      const task = this.tasks.get(id);
      return task && TERMINAL_STATUSES.has(task.view.status);
    });
    const excess = terminalIds.length - this.terminalHistoryLimit;
    if (excess <= 0) return;
    for (const id of terminalIds.slice(0, excess)) {
      this.tasks.delete(id);
      this.order = this.order.filter((entry) => entry !== id);
    }
  }

  /* ---------------- internals ---------------- */

  private assertCapacity(): void {
    if (this.pendingCount() >= this.maxQueueSize) {
      throw new AppError(
        'QUEUE_FULL',
        `Task queue is full (${this.maxQueueSize} pending tasks). Wait for tasks to finish or cancel one.`,
      );
    }
  }

  private assertMemory(spec: TaskSpec): void {
    if (!this.memoryGate) return;
    const verdict = this.memoryGate(spec);
    if (!verdict.allowed) {
      throw new AppError(
        'MEMORY_BUDGET',
        verdict.reason ?? 'Task exceeds the memory budget',
        {
          hint: 'Use a smaller model or quantization, close other apps, or adjust the memory settings.',
        },
      );
    }
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (;;) {
        if (this.runningId !== null) break;
        const next = this.firstQueued();
        if (!next) break;
        this.runningId = next.view.id;
        await this.runTask(next);
        this.runningId = null;
        this.prune();
      }
    } finally {
      this.pumping = false;
    }
  }

  private firstQueued(): InternalTask | undefined {
    for (const id of this.order) {
      const task = this.tasks.get(id);
      if (task && task.view.status === 'queued') return task;
    }
    return undefined;
  }

  private async runTask(task: InternalTask): Promise<void> {
    const view = task.view;
    const spec = task.spec;
    if (!spec) return;
    view.status = 'running';
    view.startedAt = this.now();
    delete view.error;
    delete view.progress;
    this.emitUpdated(view);

    for (;;) {
      view.attempts += 1;
      const controller = new AbortController();
      task.controller = controller;
      const ctx: TaskContext = {
        signal: controller.signal,
        reportProgress: (progress) => {
          if (task.controller !== controller) return;
          view.progress = progress;
          this.events.emit('task-progress', {
            taskId: view.id,
            progress: structuredClone(progress),
          });
          this.emitUpdated(view);
        },
      };
      try {
        const result = await spec.run(ctx);
        if (controller.signal.aborted) {
          this.finishCancelled(task, 'Cancelled while finishing');
          return;
        }
        view.status = 'succeeded';
        view.result = result;
        view.finishedAt = this.now();
        view.waitingRetry = false;
        this.emitUpdated(view);
        return;
      } catch (err) {
        const appError = AppError.wrap(err);
        if (appError.code === 'CANCELLED' || controller.signal.aborted) {
          this.finishCancelled(task, appError.message);
          return;
        }
        const canRetry = appError.retryable && view.attempts <= view.maxRetries;
        if (canRetry) {
          view.waitingRetry = true;
          view.progress = {
            message: `Attempt ${view.attempts} failed (${appError.code}). Retrying…`,
          };
          this.emitUpdated(view);
          const delay = this.retryBaseDelayMs * 2 ** (view.attempts - 1);
          try {
            await this.wait(delay, controller.signal);
          } catch {
            this.finishCancelled(task, 'Cancelled during retry wait');
            return;
          }
          view.waitingRetry = false;
          continue;
        }
        view.status = 'failed';
        view.error = appError.toJSON();
        view.finishedAt = this.now();
        view.waitingRetry = false;
        this.emitUpdated(view);
        return;
      } finally {
        task.controller = undefined;
      }
    }
  }

  private finishCancelled(task: InternalTask, message: string): void {
    const view = task.view;
    view.status = 'cancelled';
    view.finishedAt = this.now();
    view.waitingRetry = false;
    view.error = new AppError('CANCELLED', message).toJSON();
    this.emitUpdated(view);
  }

  private emitAdded(view: TaskView): void {
    this.events.emit('task-added', structuredClone(view));
    this.notifyChange();
  }

  private emitUpdated(view: TaskView): void {
    this.events.emit('task-updated', structuredClone(view));
    this.notifyChange();
  }

  private notifyChange(): void {
    const views = this.list();
    this.events.emit('queue-changed', views);
    this.onChange?.(views);
  }
}
