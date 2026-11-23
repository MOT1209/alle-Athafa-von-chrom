/**
 * Centralized, typed error system.
 * Every failure surfaced to the UI or crossing the message boundary is an AppError
 * (or its serialized form). No raw exceptions leak into user-facing code paths.
 */

export const ERROR_CODES = [
  'NETWORK',
  'TIMEOUT',
  'HTTP',
  'BAD_RESPONSE',
  'CANCELLED',
  'NOT_CONFIGURED',
  'MODEL_NOT_FOUND',
  'MEMORY_BUDGET',
  'STORAGE',
  'QUEUE_FULL',
  'INVALID_INPUT',
  'CONSENT_REQUIRED',
  'CAPTURE_UNAVAILABLE',
  'PAGE_UNREACHABLE',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const DEFAULT_RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'NETWORK',
  'TIMEOUT',
]);

export interface AppErrorOptions {
  retryable?: boolean;
  hint?: string;
  detail?: unknown;
  cause?: unknown;
}

export interface SerializedError {
  name: 'AppError';
  code: ErrorCode;
  message: string;
  retryable: boolean;
  hint?: string;
  detail?: unknown;
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return (
    typeof value === 'string' &&
    (ERROR_CODES as readonly string[]).includes(value)
  );
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly hint?: string;
  readonly detail?: unknown;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(
      message,
      options.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.name = 'AppError';
    this.code = code;
    this.retryable = options.retryable ?? DEFAULT_RETRYABLE.has(code);
    if (options.hint !== undefined) this.hint = options.hint;
    if (options.detail !== undefined) this.detail = options.detail;
  }

  toJSON(): SerializedError {
    const out: SerializedError = {
      name: 'AppError',
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
    if (this.hint !== undefined) out.hint = this.hint;
    if (this.detail !== undefined) out.detail = this.detail;
    return out;
  }

  static fromJSON(value: unknown): AppError | undefined {
    if (!isSerializedError(value)) return undefined;
    return new AppError(value.code, value.message, {
      retryable: value.retryable,
      hint: value.hint,
      detail: value.detail,
    });
  }

  /** Normalize any thrown value into an AppError without losing its type. */
  static wrap(err: unknown, fallback: ErrorCode = 'INTERNAL'): AppError {
    if (err instanceof AppError) return err;
    if (err instanceof DOMException && err.name === 'AbortError') {
      return new AppError('CANCELLED', 'Operation cancelled', { cause: err });
    }
    if (err instanceof Error) {
      if (err.name === 'AbortError') {
        return new AppError('CANCELLED', 'Operation cancelled', { cause: err });
      }
      return new AppError(fallback, err.message, { cause: err });
    }
    return new AppError(fallback, String(err));
  }
}

export function isSerializedError(value: unknown): value is SerializedError {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.name === 'AppError' &&
    isErrorCode(v.code) &&
    typeof v.message === 'string' &&
    typeof v.retryable === 'boolean'
  );
}
