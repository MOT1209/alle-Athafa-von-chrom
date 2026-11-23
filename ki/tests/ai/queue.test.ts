import { describe, expect, it, vi } from 'vitest';
import { TaskQueue, type TaskSpec } from '../../src/ai/queue';
import { AppError } from '../../src/core/errors';

function makeQueue(overrides: {
  maxRetries?: number;
  maxQueueSize?: number;
  retryBaseDelayMs?: number;
  memoryGate?: (spec: TaskSpec) => { allowed: boolean; reason?: string };
  terminalHistoryLimit?: number;
} = {}) {
  const waits: number[] = [];
  let clock = 1000;
  const queue = new TaskQueue({
    maxRetries: overrides.maxRetries ?? 2,
    maxQueueSize: overrides.maxQueueSize ?? 20,
    retryBaseDelayMs: overrides.retryBaseDelayMs ?? 100,
    memoryGate: overrides.memoryGate,
    terminalHistoryLimit: overrides.terminalHistoryLimit,
    now: () => clock++,
    wait: async (ms, signal) => {
      waits.push(ms);
      if (signal.aborted) throw new AppError('CANCELLED', 'wait aborted');
      // Resolve immediately but stay abort-aware for cancellation tests.
      await Promise.resolve();
      if (signal.aborted) throw new AppError('CANCELLED', 'wait aborted');
    },
  });
  return { queue, waits };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function successSpec(label: string, run?: TaskSpec['run']): TaskSpec {
  return {
    kind: 'test',
    label,
    run: run ?? (async () => `${label}-result`),
  };
}

describe('TaskQueue — execution', () => {
  it('runs an enqueued task to success', async () => {
    const { queue } = makeQueue();
    const view = queue.enqueue(successSpec('a'));
    expect(view.status).toBe('queued');
    await vi.waitFor(() => {
      expect(queue.get(view.id)?.status).toBe('succeeded');
    });
    expect(queue.get(view.id)?.result).toBe('a-result');
  });

  it('never runs two tasks at the same time', async () => {
    const { queue } = makeQueue();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let active = 0;
    let maxActive = 0;
    const tracked = (label: string, waitGate?: Promise<void>): TaskSpec => ({
      kind: 'test',
      label,
      run: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (waitGate) await waitGate;
        active -= 1;
        return label;
      },
    });
    const a = queue.enqueue(tracked('a', gate));
    await flush();
    const b = queue.enqueue(tracked('b'));
    const c = queue.enqueue(tracked('c'));
    await flush();
    expect(queue.get(a.id)?.status).toBe('running');
    expect(queue.get(b.id)?.status).toBe('queued');
    expect(queue.get(c.id)?.status).toBe('queued');
    release();
    await vi.waitFor(() => {
      expect(queue.get(c.id)?.status).toBe('succeeded');
    });
    expect(maxActive).toBe(1);
    expect(queue.get(b.id)?.status).toBe('succeeded');
  });

  it('rejects invalid specs', () => {
    const { queue } = makeQueue();
    expect(() => queue.enqueue({ kind: 'x', label: 'x' } as unknown as TaskSpec)).toThrow(
      AppError,
    );
  });

  it('copies task metadata into views without sharing the object', async () => {
    const { queue } = makeQueue();
    const meta = { videoRecordId: 'yt_a' };
    const view = queue.enqueue({
      kind: 'video-summary',
      label: 'Summarize',
      meta,
      run: async () => 'done',
    });
    expect(view.meta).toEqual({ videoRecordId: 'yt_a' });
    meta.videoRecordId = 'mutated';
    expect(queue.get(view.id)?.meta).toEqual({ videoRecordId: 'yt_a' });
    await vi.waitFor(() => {
      expect(queue.get(view.id)?.status).toBe('succeeded');
    });
    expect(queue.get(view.id)?.meta).toEqual({ videoRecordId: 'yt_a' });
  });

  it('reports progress through events and the view', async () => {
    const { queue } = makeQueue();
    const progressEvents: Array<{ taskId: string; progress: { percent?: number } }> = [];
    queue.events.on('task-progress', (event) => progressEvents.push(event));
    const view = queue.enqueue({
      kind: 'test',
      label: 'progress',
      run: async (ctx) => {
        ctx.reportProgress({ percent: 40, message: 'downloading' });
        ctx.reportProgress({ percent: 80 });
        return 'done';
      },
    });
    await vi.waitFor(() => {
      expect(queue.get(view.id)?.status).toBe('succeeded');
    });
    expect(progressEvents.length).toBe(2);
    expect(progressEvents[0]?.progress.percent).toBe(40);
  });
});

describe('TaskQueue — cancellation', () => {
  it('cancels a queued task before it runs', async () => {
    const { queue } = makeQueue();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ran: string[] = [];
    const a = queue.enqueue({ kind: 't', label: 'a', run: async () => { await gate; ran.push('a'); } });
    await flush();
    const b = queue.enqueue({ kind: 't', label: 'b', run: async () => { ran.push('b'); } });
    expect(queue.cancel(b.id)).toBe(true);
    expect(queue.get(b.id)?.status).toBe('cancelled');
    release();
    await vi.waitFor(() => expect(queue.get(a.id)?.status).toBe('succeeded'));
    expect(ran).toEqual(['a']);
  });

  it('cancels a running task via AbortSignal', async () => {
    const { queue } = makeQueue();
    let sawAbort = false;
    const view = queue.enqueue({
      kind: 't',
      label: 'long',
      run: (ctx) =>
        new Promise((_resolve, reject) => {
          ctx.signal.addEventListener('abort', () => {
            sawAbort = true;
            reject(new AppError('CANCELLED', 'user cancelled'));
          });
        }),
    });
    await vi.waitFor(() => expect(queue.get(view.id)?.status).toBe('running'));
    expect(queue.cancel(view.id)).toBe(true);
    await vi.waitFor(() => expect(queue.get(view.id)?.status).toBe('cancelled'));
    expect(sawAbort).toBe(true);
  });

  it('cancel returns false for unknown or terminal tasks', async () => {
    const { queue } = makeQueue();
    expect(queue.cancel('nope')).toBe(false);
    const view = queue.enqueue(successSpec('a'));
    await vi.waitFor(() => expect(queue.get(view.id)?.status).toBe('succeeded'));
    expect(queue.cancel(view.id)).toBe(false);
  });
});

describe('TaskQueue — retries', () => {
  it('retries retryable failures with exponential backoff then succeeds', async () => {
    const { queue, waits } = makeQueue({ retryBaseDelayMs: 100 });
    let attempts = 0;
    const view = queue.enqueue({
      kind: 't',
      label: 'flaky',
      run: async () => {
        attempts += 1;
        if (attempts < 3) throw new AppError('NETWORK', 'connection refused');
        return 'recovered';
      },
    });
    await vi.waitFor(() => expect(queue.get(view.id)?.status).toBe('succeeded'));
    expect(attempts).toBe(3);
    expect(waits).toEqual([100, 200]);
    expect(queue.get(view.id)?.result).toBe('recovered');
  });

  it('does not retry non-retryable failures', async () => {
    const { queue, waits } = makeQueue();
    const view = queue.enqueue({
      kind: 't',
      label: 'bad-input',
      run: async () => {
        throw new AppError('INVALID_INPUT', 'nope');
      },
    });
    await vi.waitFor(() => expect(queue.get(view.id)?.status).toBe('failed'));
    expect(queue.get(view.id)?.attempts).toBe(1);
    expect(queue.get(view.id)?.error?.code).toBe('INVALID_INPUT');
    expect(waits).toEqual([]);
  });

  it('gives up after maxRetries and surfaces the last error', async () => {
    const { queue } = makeQueue({ maxRetries: 1 });
    const view = queue.enqueue({
      kind: 't',
      label: 'always-down',
      run: async () => {
        throw new AppError('NETWORK', 'still down');
      },
    });
    await vi.waitFor(() => expect(queue.get(view.id)?.status).toBe('failed'));
    expect(queue.get(view.id)?.attempts).toBe(2);
    expect(queue.get(view.id)?.error?.message).toBe('still down');
  });

  it('cancellation during retry wait stops the task', async () => {
    let releaseWait!: () => void;
    const waitGate = new Promise<void>((resolve) => {
      releaseWait = resolve;
    });
    const queue = new TaskQueue({
      maxRetries: 3,
      wait: async (_ms, signal) => {
        await waitGate;
        if (signal.aborted) throw new AppError('CANCELLED', 'wait aborted');
      },
    });
    const view = queue.enqueue({
      kind: 't',
      label: 'retry-wait',
      run: async () => {
        throw new AppError('NETWORK', 'down');
      },
    });
    await vi.waitFor(() => expect(queue.get(view.id)?.waitingRetry).toBe(true));
    queue.cancel(view.id);
    releaseWait();
    await vi.waitFor(() => expect(queue.get(view.id)?.status).toBe('cancelled'));
  });

  it('retry re-runs a failed task', async () => {
    const { queue } = makeQueue();
    let fail = true;
    const view = queue.enqueue({
      kind: 't',
      label: 'retryable',
      maxRetries: 0,
      run: async () => {
        if (fail) throw new AppError('INVALID_INPUT', 'first fails');
        return 'second works';
      },
    });
    await vi.waitFor(() => expect(queue.get(view.id)?.status).toBe('failed'));
    fail = false;
    const retried = queue.retry(view.id);
    expect(retried.status).toBe('queued');
    await vi.waitFor(() => expect(queue.get(view.id)?.status).toBe('succeeded'));
    expect(queue.get(view.id)?.result).toBe('second works');
  });

  it('retry rejects unknown, running and succeeded tasks', async () => {
    const { queue } = makeQueue();
    expect(() => queue.retry('missing')).toThrow(AppError);
    const view = queue.enqueue(successSpec('a'));
    await vi.waitFor(() => expect(queue.get(view.id)?.status).toBe('succeeded'));
    expect(() => queue.retry(view.id)).toThrow(/Only failed or cancelled/);
  });
});

describe('TaskQueue — admission control', () => {
  it('throws QUEUE_FULL at capacity', async () => {
    const { queue } = makeQueue({ maxQueueSize: 1 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    queue.enqueue({ kind: 't', label: 'a', run: () => gate });
    await flush();
    expect(() => queue.enqueue(successSpec('b'))).toThrow(/queue is full/i);
    release();
  });

  it('memory gate blocks oversize tasks before they enter', () => {
    const { queue } = makeQueue({
      memoryGate: (spec) =>
        (spec.estimatedSizeBytes ?? 0) > 1000
          ? { allowed: false, reason: 'too big for RAM' }
          : { allowed: true },
    });
    expect(() =>
      queue.enqueue({ kind: 't', label: 'big', estimatedSizeBytes: 2000, run: async () => 1 }),
    ).toThrow(/too big for RAM/);
    expect(queue.list().length).toBe(0);
    expect(() =>
      queue.enqueue({ kind: 't', label: 'small', estimatedSizeBytes: 500, run: async () => 1 }),
    ).not.toThrow();
  });
});

describe('TaskQueue — persistence & history', () => {
  it('restore marks in-flight tasks as interrupted failures (no fake resume)', () => {
    const { queue } = makeQueue();
    queue.restore([
      {
        id: 'task_old',
        kind: 'model-pull',
        label: 'Pull x',
        status: 'running',
        attempts: 1,
        maxRetries: 2,
        createdAt: 1,
      },
      {
        id: 'task_done',
        kind: 'model-test',
        label: 'Test y',
        status: 'succeeded',
        attempts: 1,
        maxRetries: 2,
        createdAt: 2,
        result: { ok: true },
      },
    ]);
    const interrupted = queue.get('task_old');
    expect(interrupted?.status).toBe('failed');
    expect(interrupted?.orphaned).toBe(true);
    expect(interrupted?.error?.code).toBe('INTERNAL');
    expect(interrupted?.error?.retryable).toBe(true);
    expect(queue.get('task_done')?.status).toBe('succeeded');
    expect(() => queue.retry('task_old')).toThrow(/browser restart/);
  });

  it('prune bounds terminal history', async () => {
    const { queue } = makeQueue({ terminalHistoryLimit: 2 });
    for (let i = 0; i < 5; i++) {
      const view = queue.enqueue(successSpec(`t${i}`));
      await vi.waitFor(() => expect(queue.get(view.id)?.status).toBe('succeeded'));
    }
    expect(queue.list().length).toBe(2);
    expect(queue.list().map((v) => v.label)).toEqual(['t3', 't4']);
  });

  it('onChange receives the full view list for persistence', async () => {
    const snapshots: number[] = [];
    const queue = new TaskQueue({
      onChange: (views) => snapshots.push(views.length),
      wait: async () => {},
    });
    const view = queue.enqueue(successSpec('a'));
    await vi.waitFor(() => expect(queue.get(view.id)?.status).toBe('succeeded'));
    expect(snapshots.length).toBeGreaterThan(0);
  });

  it('isBusy reflects pending work', async () => {
    const { queue } = makeQueue();
    expect(queue.isBusy()).toBe(false);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const view = queue.enqueue({ kind: 't', label: 'a', run: () => gate });
    expect(queue.isBusy()).toBe(true);
    release();
    await vi.waitFor(() => expect(queue.get(view.id)?.status).toBe('succeeded'));
    expect(queue.isBusy()).toBe(false);
  });
});
