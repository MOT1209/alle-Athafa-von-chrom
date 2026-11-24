import { describe, expect, it } from 'vitest';
import {
  isChatCitation,
  MAX_ANSWER_CHARS,
  MAX_SOURCES_USED,
  parseChatAnswer,
} from '../../../src/ai/chat/schema';

describe('parseChatAnswer', () => {
  it('accepts a grounded answer and normalizes sources', () => {
    const answer = parseChatAnswer(
      JSON.stringify({
        found: true,
        answer: '  Tomatoes need six hours\n of sunlight.  ',
        usedSources: [3, 1, 3],
      }),
      3,
    );
    expect(answer).toEqual({
      found: true,
      answer: 'Tomatoes need six hours of sunlight.',
      usedSources: [1, 3],
    });
  });

  it('turns a model refusal into an empty not-found answer', () => {
    expect(
      parseChatAnswer(
        JSON.stringify({
          found: false,
          answer: 'The transcript does not say.',
          usedSources: [],
        }),
        2,
      ),
    ).toEqual({ found: false, answer: '', usedSources: [] });
  });

  it('rejects malformed JSON, non-objects and empty replies', () => {
    for (const raw of ['', '   ', 'not json', '[]', 'null', '"text"']) {
      expect(() => parseChatAnswer(raw, 1)).toThrowError(
        expect.objectContaining({ code: 'BAD_RESPONSE', retryable: true }),
      );
    }
  });

  it('rejects a non-boolean found flag', () => {
    expect(() =>
      parseChatAnswer(
        JSON.stringify({ found: 'yes', answer: 'x', usedSources: [1] }),
        1,
      ),
    ).toThrowError(expect.objectContaining({ code: 'BAD_RESPONSE' }));
  });

  it('rejects sources outside the supplied passage range', () => {
    for (const usedSources of [[0], [2], [-1], [1.5], ['1']]) {
      expect(() =>
        parseChatAnswer(
          JSON.stringify({ found: true, answer: 'x', usedSources }),
          1,
        ),
      ).toThrowError(expect.objectContaining({ code: 'BAD_RESPONSE' }));
    }
  });

  it('requires an answer and at least one source when found is true', () => {
    for (const payload of [
      { found: true, answer: '', usedSources: [1] },
      { found: true, answer: 'x', usedSources: [] },
      { found: true, usedSources: [1] },
    ]) {
      expect(() =>
        parseChatAnswer(JSON.stringify(payload), 1),
      ).toThrowError(expect.objectContaining({ code: 'BAD_RESPONSE' }));
    }
  });

  it('bounds the answer length and source count', () => {
    expect(() =>
      parseChatAnswer(
        JSON.stringify({
          found: true,
          answer: 'x'.repeat(MAX_ANSWER_CHARS + 1),
          usedSources: [1],
        }),
        1,
      ),
    ).toThrowError(expect.objectContaining({ code: 'BAD_RESPONSE' }));

    expect(() =>
      parseChatAnswer(
        JSON.stringify({
          found: true,
          answer: 'x',
          usedSources: Array.from(
            { length: MAX_SOURCES_USED + 1 },
            (_value, index) => index + 1,
          ),
        }),
        MAX_SOURCES_USED + 1,
      ),
    ).toThrowError(expect.objectContaining({ code: 'BAD_RESPONSE' }));
  });

  it('rejects a non-array usedSources field', () => {
    expect(() =>
      parseChatAnswer(
        JSON.stringify({ found: true, answer: 'x', usedSources: 1 }),
        1,
      ),
    ).toThrowError(expect.objectContaining({ code: 'BAD_RESPONSE' }));
  });
});

describe('isChatCitation', () => {
  it('accepts a real segment citation', () => {
    expect(
      isChatCitation({ startMs: 1000, endMs: 2000, text: 'A real quote.' }),
    ).toBe(true);
  });

  it('rejects reversed, negative, empty and malformed citations', () => {
    for (const value of [
      { startMs: 2000, endMs: 1000, text: 'x' },
      { startMs: -1, endMs: 1000, text: 'x' },
      { startMs: 0, endMs: 1000, text: '   ' },
      { startMs: 0, endMs: 1000 },
      { startMs: '0', endMs: 1000, text: 'x' },
      null,
      [],
    ]) {
      expect(isChatCitation(value)).toBe(false);
    }
  });
});
