import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { linkSignals, sleep, timeoutSignal } from '../../src/core/abort';
import { AppError } from '../../src/core/errors';

describe('linkSignals', () => {
  it('aborts the link when any source aborts', () => {
    const a = new AbortController();
    const b = new AbortController();
    const linked = linkSignals(a.signal, b.signal);
    expect(linked.signal.aborted).toBe(false);
    b.abort();
    expect(linked.signal.aborted).toBe(true);
    linked.dispose();
  });

  it('is immediately aborted when a source is already aborted', () => {
    const a = new AbortController();
    a.abort();
    const linked = linkSignals(a.signal, undefined);
    expect(linked.signal.aborted).toBe(true);
    linked.dispose();
  });

  it('dispose detaches listeners', () => {
    const a = new AbortController();
    const linked = linkSignals(a.signal);
    linked.dispose();
    a.abort();
    expect(linked.signal.aborted).toBe(false);
  });
});

describe('timeoutSignal', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('aborts after the timeout and reports timedOut', () => {
    const timeout = timeoutSignal(1000);
    expect(timeout.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1001);
    expect(timeout.signal.aborted).toBe(true);
    expect(timeout.timedOut()).toBe(true);
    timeout.dispose();
  });

  it('external abort wins without marking timedOut', () => {
    const external = new AbortController();
    const timeout = timeoutSignal(1000, external.signal);
    external.abort();
    expect(timeout.signal.aborted).toBe(true);
    expect(timeout.timedOut()).toBe(false);
    timeout.dispose();
  });

  it('dispose clears the timer', () => {
    const timeout = timeoutSignal(1000);
    timeout.dispose();
    vi.advanceTimersByTime(5000);
    expect(timeout.signal.aborted).toBe(false);
  });
});

describe('sleep', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('resolves after the delay', async () => {
    const promise = sleep(500);
    vi.advanceTimersByTime(500);
    await expect(promise).resolves.toBeUndefined();
  });

  it('rejects CANCELLED when aborted mid-wait', async () => {
    const controller = new AbortController();
    const promise = sleep(5000, controller.signal);
    const assertion = expect(promise).rejects.toMatchObject({ code: 'CANCELLED' });
    controller.abort();
    await assertion;
  });

  it('rejects immediately when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(sleep(5000, controller.signal)).rejects.toBeInstanceOf(AppError);
  });
});
