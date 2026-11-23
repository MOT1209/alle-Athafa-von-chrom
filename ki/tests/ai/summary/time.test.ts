import { describe, expect, it } from 'vitest';
import { formatClock, parseTimestampMs } from '../../../src/ai/summary/time';

describe('formatClock', () => {
  it('formats sub-hour times as m:ss', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(59_999)).toBe('0:59');
    expect(formatClock(60_000)).toBe('1:00');
    expect(formatClock(754_000)).toBe('12:34');
  });

  it('formats hour-long times as h:mm:ss', () => {
    expect(formatClock(3_661_000)).toBe('1:01:01');
    expect(formatClock(36_000_000)).toBe('10:00:00');
  });

  it('never produces negative or NaN output', () => {
    expect(formatClock(-500)).toBe('0:00');
    expect(formatClock(Number.NaN)).toBe('0:00');
    expect(formatClock(Number.POSITIVE_INFINITY)).toBe('0:00');
  });
});

describe('parseTimestampMs', () => {
  it('accepts milliseconds as numbers', () => {
    expect(parseTimestampMs(0)).toBe(0);
    expect(parseTimestampMs(754_000)).toBe(754_000);
    expect(parseTimestampMs(1234.6)).toBe(1235);
  });

  it('accepts clock strings', () => {
    expect(parseTimestampMs('12:34')).toBe(754_000);
    expect(parseTimestampMs('1:02:03')).toBe(3_723_000);
    expect(parseTimestampMs('00:00')).toBe(0);
  });

  it('accepts bare numbers and explicit units', () => {
    expect(parseTimestampMs('754000')).toBe(754_000);
    expect(parseTimestampMs('750 ms')).toBe(750);
    expect(parseTimestampMs('12.5 s')).toBe(12_500);
    expect(parseTimestampMs('1 s')).toBe(1000);
  });

  it('trims surrounding whitespace', () => {
    expect(parseTimestampMs('  1:00  ')).toBe(60_000);
  });

  it('rejects ambiguous or invalid values', () => {
    expect(parseTimestampMs(-1)).toBeUndefined();
    expect(parseTimestampMs(Number.NaN)).toBeUndefined();
    expect(parseTimestampMs(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(parseTimestampMs('')).toBeUndefined();
    expect(parseTimestampMs('   ')).toBeUndefined();
    expect(parseTimestampMs('abc')).toBeUndefined();
    expect(parseTimestampMs('-5')).toBeUndefined();
    expect(parseTimestampMs('12:60')).toBeUndefined();
    expect(parseTimestampMs('1:2')).toBeUndefined();
    expect(parseTimestampMs('1:02:03:04')).toBeUndefined();
    expect(parseTimestampMs(null)).toBeUndefined();
    expect(parseTimestampMs(undefined)).toBeUndefined();
    expect(parseTimestampMs({})).toBeUndefined();
  });
});
