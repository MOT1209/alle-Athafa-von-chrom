import { describe, expect, it } from 'vitest';
import { parseTranslationBatch } from '../../../src/ai/translate/schema';

describe('ai/translate/schema', () => {
  it('parses valid batch', () => {
    const raw = JSON.stringify({
      segments: [
        { key: '0', text: 'translated zero' },
        { key: '1', text: 'translated one' },
      ],
    });
    const result = parseTranslationBatch(raw, ['0', '1']);
    expect(result.segments).toHaveLength(2);
  });

  it('rejects missing keys', () => {
    const raw = JSON.stringify({ segments: [{ key: '0', text: 'x' }] });
    expect(() => parseTranslationBatch(raw, ['0', '1'])).toThrow();
  });

  it('rejects extra keys', () => {
    const raw = JSON.stringify({
      segments: [
        { key: '0', text: 'x' },
        { key: '1', text: 'y' },
        { key: '2', text: 'z' },
      ],
    });
    expect(() => parseTranslationBatch(raw, ['0', '1'])).toThrow();
  });

  it('rejects duplicates', () => {
    const raw = JSON.stringify({
      segments: [
        { key: '0', text: 'x' },
        { key: '0', text: 'y' },
      ],
    });
    expect(() => parseTranslationBatch(raw, ['0'])).toThrow();
  });

  it('rejects empty response', () => {
    expect(() => parseTranslationBatch('', ['0'])).toThrow();
  });

  it('rejects unexpected top-level key', () => {
    const raw = JSON.stringify({ segments: [{ key: '0', text: 'x' }], extra: 1 });
    expect(() => parseTranslationBatch(raw, ['0'])).toThrow();
  });
});