/**
 * Secret-safe structured logger.
 *
 * Two invariants:
 *  1. Nothing that looks like a credential is ever written to a sink. Redaction
 *     runs on the message string and on every `data` value, on the way in.
 *  2. Sinks are injected, so the same logger works in a service worker, a
 *     content script, the devtools panel, and in tests.
 */

import type { LogEntry, LogLevel } from '@/core/types';
import { maskSecretsInString, maskSecretsInValue } from '@/security/masking';

export interface LogSink {
  write(entry: LogEntry): void;
}

export interface LoggerOptions {
  readonly module: string;
  readonly minLevel?: LogLevel;
  readonly sinks?: readonly LogSink[];
  /** Capture ring-buffer size for the diagnostics page. */
  readonly bufferSize?: number;
  readonly now?: () => number;
}

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Bounded in-memory ring buffer backing the diagnostics page. */
export class MemoryLogSink implements LogSink {
  private readonly entries: LogEntry[] = [];

  constructor(private readonly limit = 500) {}

  write(entry: LogEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.limit) {
      this.entries.splice(0, this.entries.length - this.limit);
    }
  }

  read(): readonly LogEntry[] {
    return [...this.entries];
  }

  clear(): void {
    this.entries.length = 0;
  }
}

/** Writes to the host console. Redaction is already applied upstream. */
export const consoleSink: LogSink = {
  write(entry) {
    const prefix = `[kingdev:${entry.module}]`;
    const line = `${prefix} ${entry.message}`;
    if (entry.level === 'error') console.error(line, entry.data ?? '');
    else if (entry.level === 'warn') console.warn(line, entry.data ?? '');
    else if (entry.level === 'debug') console.debug(line, entry.data ?? '');
    else console.info(line, entry.data ?? '');
  },
};

const memory = new MemoryLogSink();

export class Logger {
  private readonly module: string;
  private readonly minLevel: LogLevel;
  private readonly sinks: readonly LogSink[];
  private readonly now: () => number;

  constructor(options: LoggerOptions) {
    this.module = options.module;
    this.minLevel = options.minLevel ?? 'info';
    this.sinks = options.sinks ?? [memory, consoleSink];
    this.now = options.now ?? (() => Date.now());
  }

  child(module: string): Logger {
    return new Logger({
      module: `${this.module}/${module}`,
      minLevel: this.minLevel,
      sinks: this.sinks,
      now: this.now,
    });
  }

  debug(operation: string, message: string, data?: Record<string, unknown>): void {
    this.write('debug', operation, 'ok', message, undefined, data);
  }

  info(operation: string, message: string, data?: Record<string, unknown>): void {
    this.write('info', operation, 'ok', message, undefined, data);
  }

  warn(operation: string, message: string, data?: Record<string, unknown>): void {
    this.write('warn', operation, 'ok', message, undefined, data);
  }

  error(
    operation: string,
    message: string,
    data?: Record<string, unknown>,
    durationMs?: number,
  ): void {
    this.write('error', operation, 'error', message, durationMs, data);
  }

  /** Times an operation and records the outcome, success or failure. */
  async time<T>(
    operation: string,
    fn: () => Promise<T>,
  ): Promise<{ value: T; durationMs: number }> {
    const started = this.now();
    try {
      const value = await fn();
      // Measure once: reading the clock twice can straddle a tick, which would
      // make the logged duration disagree with the returned one.
      const durationMs = this.now() - started;
      this.write('info', operation, 'ok', 'completed', durationMs);
      return { value, durationMs };
    } catch (cause) {
      const durationMs = this.now() - started;
      this.write(
        'error',
        operation,
        'error',
        cause instanceof Error ? cause.message : String(cause),
        durationMs,
      );
      throw cause;
    }
  }

  private write(
    level: LogLevel,
    operation: string,
    status: 'ok' | 'error',
    message: string,
    durationMs?: number,
    data?: Record<string, unknown>,
  ): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.minLevel]) return;

    const entry: LogEntry = {
      timestamp: new Date(this.now()).toISOString(),
      level,
      module: this.module,
      operation,
      status,
      message: maskSecretsInString(message),
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(data === undefined ? {} : { data: maskSecretsInValue(data) as Record<string, unknown> }),
    };

    for (const sink of this.sinks) {
      try {
        sink.write(entry);
      } catch {
        // A failing sink must never break the caller.
      }
    }
  }
}

export function createLogger(module: string, minLevel: LogLevel = 'info'): Logger {
  return new Logger({ module, minLevel });
}

/** Reads the diagnostics ring buffer. */
export function readDiagnostics(): readonly LogEntry[] {
  return memory.read();
}

export function clearDiagnostics(): void {
  memory.clear();
}
