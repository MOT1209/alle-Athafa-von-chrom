import { AppError } from './errors';

/**
 * Abort/timeout helpers. All cancellable operations in VideoMind compose these
 * so a single user cancel propagates through fetch, streams and retry waits.
 */

export interface LinkedSignal {
  signal: AbortSignal;
  dispose: () => void;
}

/** Combine several abort signals into one. Aborting any source aborts the link. */
export function linkSignals(
  ...signals: Array<AbortSignal | undefined>
): LinkedSignal {
  const controller = new AbortController();
  const cleanups: Array<() => void> = [];
  for (const source of signals) {
    if (!source) continue;
    if (source.aborted) {
      controller.abort(source.reason);
      break;
    }
    const onAbort = () => controller.abort(source.reason);
    source.addEventListener('abort', onAbort, { once: true });
    cleanups.push(() => source.removeEventListener('abort', onAbort));
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const cleanup of cleanups) cleanup();
    },
  };
}

export interface TimeoutSignal extends LinkedSignal {
  timedOut: () => boolean;
}

/** A signal that aborts after `ms`, optionally linked to an external signal. */
export function timeoutSignal(
  ms: number,
  external?: AbortSignal,
): TimeoutSignal {
  const timeout = new AbortController();
  let didTimeout = false;
  const timer = setTimeout(() => {
    didTimeout = true;
    timeout.abort(new DOMException(`Timed out after ${ms} ms`, 'TimeoutError'));
  }, ms);
  const linked = linkSignals(external, timeout.signal);
  return {
    signal: linked.signal,
    timedOut: () => didTimeout,
    dispose: () => {
      clearTimeout(timer);
      linked.dispose();
    },
  };
}

/** Cancellable sleep. Rejects with CANCELLED when the signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AppError('CANCELLED', 'Cancelled during wait'));
      return;
    }
    const onAbort = () => {
      cleanup();
      reject(new AppError('CANCELLED', 'Cancelled during wait'));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
