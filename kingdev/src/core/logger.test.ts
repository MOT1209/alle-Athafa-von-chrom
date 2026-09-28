import {
  Logger,
  MemoryLogSink,
  clearDiagnostics,
  consoleSink,
  createLogger,
  readDiagnostics,
} from '@/core/logger';
import type { LogEntry, LogLevel } from '@/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A fake credential assembled from fragments.
 *
 * It deliberately still matches the real `stripe-key` rule in masking.ts, so the
 * test exercises the genuine regex. The literal is never written whole because
 * GitHub push protection blocks commits containing anything that looks like a
 * live provider key, and a test fixture must not be able to block a release.
 */
const FAKE_KEY = ['sk', 'live', 'abcdefghijklmnopqrstuvwx'].join('_');

/** Collects entries so assertions can inspect exactly what reached a sink. */
class CollectingSink {
  readonly entries: LogEntry[] = [];
  write(entry: LogEntry): void {
    this.entries.push(entry);
  }
}

/** A clock the test advances by hand, so durations are exact. */
function fakeClock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

function loggerWith(
  sink: CollectingSink,
  overrides: { minLevel?: LogLevel; clock?: ReturnType<typeof fakeClock> } = {},
): Logger {
  return new Logger({
    module: 'test',
    sinks: [sink],
    now: overrides.clock?.now ?? (() => 1_000),
    ...(overrides.minLevel ? { minLevel: overrides.minLevel } : {}),
  });
}

describe('Logger — redaction', () => {
  it('never writes a credential to a sink', () => {
    const sink = new CollectingSink();
    const log = loggerWith(sink);

    log.info('auth', `failed for ${FAKE_KEY}`);

    expect(sink.entries).toHaveLength(1);
    const message = sink.entries[0]?.message ?? '';
    // Masking keeps a short prefix and suffix on purpose, so a developer can
    // still tell *which* key failed. The body must be gone.
    expect(message).not.toContain(FAKE_KEY);
    expect(message).toContain('*');
    expect(message).not.toContain('abcdefghijklmno');
  });

  it('redacts credentials inside structured data', () => {
    const sink = new CollectingSink();
    const log = loggerWith(sink);

    log.info('auth', 'token rejected', {
      apiKey: FAKE_KEY,
      retries: 2,
    });

    const data = sink.entries[0]?.data as Record<string, unknown>;
    expect(data.apiKey).not.toBe(FAKE_KEY);
    // Non-sensitive values must survive untouched, or the log is useless.
    expect(data.retries).toBe(2);
  });

  it('redacts nested data', () => {
    const sink = new CollectingSink();
    const log = loggerWith(sink);

    log.info('auth', 'nested', {
      request: { headers: { authorization: `Bearer ${FAKE_KEY}` } },
    });

    expect(JSON.stringify(sink.entries[0]?.data)).not.toContain(FAKE_KEY);
  });

  it('omits durationMs and data when they were not supplied', () => {
    const sink = new CollectingSink();
    const log = loggerWith(sink);

    log.info('scan', 'started');

    const entry = sink.entries[0];
    expect(entry).toBeDefined();
    expect('durationMs' in (entry ?? {})).toBe(false);
    expect('data' in (entry ?? {})).toBe(false);
  });
});

describe('Logger — levels', () => {
  it('drops entries below the minimum level', () => {
    const sink = new CollectingSink();
    const log = loggerWith(sink, { minLevel: 'warn' });

    log.debug('scan', 'noisy');
    log.info('scan', 'chatty');
    log.warn('scan', 'notable');
    log.error('scan', 'serious');

    expect(sink.entries.map((e) => e.level)).toEqual(['warn', 'error']);
  });

  it('keeps everything at the lowest level', () => {
    const sink = new CollectingSink();
    const log = loggerWith(sink, { minLevel: 'debug' });

    log.debug('scan', 'a');
    log.info('scan', 'b');
    log.warn('scan', 'c');
    log.error('scan', 'd');

    expect(sink.entries).toHaveLength(4);
  });

  it('marks errors with error status and the rest as ok', () => {
    const sink = new CollectingSink();
    const log = loggerWith(sink);

    log.info('scan', 'fine');
    log.error('scan', 'broken');

    expect(sink.entries[0]?.status).toBe('ok');
    expect(sink.entries[1]?.status).toBe('error');
  });
});

describe('Logger — child loggers', () => {
  it('namespaces the module path', () => {
    const sink = new CollectingSink();
    const log = loggerWith(sink).child('network');

    log.info('fetch', 'done');

    expect(sink.entries[0]?.module).toBe('test/network');
  });

  it('inherits the level of its parent', () => {
    const sink = new CollectingSink();
    const log = loggerWith(sink, { minLevel: 'error' }).child('deep');

    log.info('fetch', 'quiet please');

    expect(sink.entries).toHaveLength(0);
  });
});

describe('Logger.time', () => {
  it('returns the value and the measured duration', async () => {
    const sink = new CollectingSink();
    const clock = fakeClock();
    const log = loggerWith(sink, { clock });

    const result = await log.time('scan', async () => {
      clock.advance(42);
      return 'result';
    });

    expect(result.value).toBe('result');
    expect(result.durationMs).toBe(42);
  });

  it('logs the same duration it returns', async () => {
    const sink = new CollectingSink();
    const clock = fakeClock();
    const log = loggerWith(sink, { clock });

    const result = await log.time('scan', async () => {
      clock.advance(30);
      return null;
    });

    // Reading the clock twice could straddle a tick and report two different
    // durations for one measurement.
    expect(sink.entries).toHaveLength(1);
    expect(sink.entries[0]?.durationMs).toBe(result.durationMs);
  });

  it('logs the failure and rethrows the original error', async () => {
    const sink = new CollectingSink();
    const clock = fakeClock();
    const log = loggerWith(sink, { clock });
    const boom = new Error('scan exploded');

    const run = log.time('scan', async () => {
      clock.advance(5);
      throw boom;
    });

    await expect(run).rejects.toBe(boom);
    expect(sink.entries[0]?.level).toBe('error');
    expect(sink.entries[0]?.status).toBe('error');
    expect(sink.entries[0]?.message).toBe('scan exploded');
    expect(sink.entries[0]?.durationMs).toBe(5);
  });

  it('handles a thrown non-error value', async () => {
    const sink = new CollectingSink();
    const log = loggerWith(sink);

    await expect(
      log.time('scan', async () => {
        throw 'a bare string';
      }),
    ).rejects.toBe('a bare string');

    expect(sink.entries[0]?.message).toBe('a bare string');
  });
});

describe('Logger — sink isolation', () => {
  it('does not let a throwing sink break the caller', () => {
    const good = new CollectingSink();
    const hostile = {
      write(): void {
        throw new Error('sink is down');
      },
    };

    const log = new Logger({ module: 'test', sinks: [hostile, good] });

    expect(() => log.info('scan', 'still fine')).not.toThrow();
    // A failing sink must not stop the healthy ones from receiving the entry.
    expect(good.entries).toHaveLength(1);
  });
});

describe('MemoryLogSink', () => {
  it('drops the oldest entries past its limit', () => {
    const sink = new MemoryLogSink(3);

    for (let i = 0; i < 5; i++) {
      sink.write({
        timestamp: '2026-01-01T00:00:00.000Z',
        level: 'info',
        module: 'test',
        operation: 'op',
        status: 'ok',
        message: `entry ${i}`,
      });
    }

    expect(sink.read().map((e) => e.message)).toEqual(['entry 2', 'entry 3', 'entry 4']);
  });

  it('returns a copy that callers cannot use to mutate the buffer', () => {
    const sink = new MemoryLogSink();
    sink.write({
      timestamp: '2026-01-01T00:00:00.000Z',
      level: 'info',
      module: 'test',
      operation: 'op',
      status: 'ok',
      message: 'original',
    });

    (sink.read() as LogEntry[]).push({
      timestamp: '2026-01-01T00:00:00.000Z',
      level: 'error',
      module: 'test',
      operation: 'op',
      status: 'error',
      message: 'sneaky',
    });

    expect(sink.read()).toHaveLength(1);
  });

  it('clears', () => {
    const sink = new MemoryLogSink();
    sink.write({
      timestamp: '2026-01-01T00:00:00.000Z',
      level: 'info',
      module: 'test',
      operation: 'op',
      status: 'ok',
      message: 'x',
    });

    sink.clear();

    expect(sink.read()).toEqual([]);
  });
});

describe('consoleSink', () => {
  it.each([
    ['error', 'error'],
    ['warn', 'warn'],
    ['debug', 'debug'],
    ['info', 'info'],
  ] as const)('routes %s to console.%s', (level, method) => {
    const spy = vi.spyOn(console, method).mockImplementation(() => undefined);

    consoleSink.write({
      timestamp: '2026-01-01T00:00:00.000Z',
      level,
      module: 'net',
      operation: 'fetch',
      status: 'ok',
      message: 'hello',
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]?.[0])).toContain('[kingdev:net]');
    spy.mockRestore();
  });
});

describe('diagnostics ring buffer', () => {
  beforeEach(() => {
    clearDiagnostics();
  });

  it('records entries from a default logger and can be cleared', () => {
    const log = createLogger('diag', 'debug');

    log.info('scan', 'observed');

    expect(readDiagnostics().some((e) => e.message === 'observed')).toBe(true);

    clearDiagnostics();

    expect(readDiagnostics()).toEqual([]);
  });
});
