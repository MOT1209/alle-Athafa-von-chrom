import { describe, expect, it } from 'vitest';
import {
  AppError,
  ERROR_CODES,
  isErrorCode,
  isSerializedError,
} from '../../src/core/errors';

describe('AppError', () => {
  it('defaults retryable for NETWORK and TIMEOUT', () => {
    expect(new AppError('NETWORK', 'x').retryable).toBe(true);
    expect(new AppError('TIMEOUT', 'x').retryable).toBe(true);
  });

  it('defaults non-retryable for logic errors', () => {
    expect(new AppError('INVALID_INPUT', 'x').retryable).toBe(false);
    expect(new AppError('MODEL_NOT_FOUND', 'x').retryable).toBe(false);
    expect(new AppError('CANCELLED', 'x').retryable).toBe(false);
  });

  it('honors explicit retryable override', () => {
    expect(new AppError('HTTP', 'x', { retryable: true }).retryable).toBe(true);
    expect(new AppError('NETWORK', 'x', { retryable: false }).retryable).toBe(
      false,
    );
  });

  it('round-trips through toJSON/fromJSON', () => {
    const original = new AppError('HTTP', 'boom', {
      retryable: true,
      hint: 'try again',
      detail: { status: 500 },
    });
    const restored = AppError.fromJSON(original.toJSON());
    expect(restored).toBeInstanceOf(AppError);
    expect(restored?.code).toBe('HTTP');
    expect(restored?.message).toBe('boom');
    expect(restored?.retryable).toBe(true);
    expect(restored?.hint).toBe('try again');
    expect(restored?.detail).toEqual({ status: 500 });
  });

  it('fromJSON rejects malformed payloads', () => {
    expect(AppError.fromJSON(null)).toBeUndefined();
    expect(AppError.fromJSON({})).toBeUndefined();
    expect(
      AppError.fromJSON({ name: 'AppError', code: 'NOPE', message: 'x', retryable: true }),
    ).toBeUndefined();
    expect(
      AppError.fromJSON({ name: 'AppError', code: 'HTTP', message: 5, retryable: true }),
    ).toBeUndefined();
  });

  it('wrap preserves AppError identity', () => {
    const err = new AppError('STORAGE', 'disk');
    expect(AppError.wrap(err)).toBe(err);
  });

  it('wrap maps DOMException AbortError to CANCELLED', () => {
    const wrapped = AppError.wrap(new DOMException('aborted', 'AbortError'));
    expect(wrapped.code).toBe('CANCELLED');
  });

  it('wrap maps Error with name AbortError to CANCELLED', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    expect(AppError.wrap(err).code).toBe('CANCELLED');
  });

  it('wrap uses fallback code for generic errors', () => {
    const wrapped = AppError.wrap(new Error('bad'), 'BAD_RESPONSE');
    expect(wrapped.code).toBe('BAD_RESPONSE');
    expect(wrapped.message).toBe('bad');
  });

  it('wrap stringifies non-error values', () => {
    expect(AppError.wrap('oops').message).toBe('oops');
    expect(AppError.wrap(42).code).toBe('INTERNAL');
  });
});

describe('guards', () => {
  it('isErrorCode accepts all declared codes and rejects others', () => {
    for (const code of ERROR_CODES) expect(isErrorCode(code)).toBe(true);
    expect(isErrorCode('WHATEVER')).toBe(false);
    expect(isErrorCode(7)).toBe(false);
  });

  it('isSerializedError validates shape', () => {
    expect(
      isSerializedError({ name: 'AppError', code: 'HTTP', message: 'x', retryable: false }),
    ).toBe(true);
    expect(isSerializedError({ name: 'Error' })).toBe(false);
    expect(isSerializedError(undefined)).toBe(false);
  });
});
