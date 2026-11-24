import { describe, expect, it } from 'vitest';
import { parseGeneratedLearning } from '../../../src/ai/learning/schema';

describe('ai/learning/schema', () => {
  it('parses valid material', () => {
    const raw = JSON.stringify({
      flashcards: [{ front: 'Q', back: 'A', timestampMs: 1000 }],
      quizzes: [{ type: 'mcq', question: 'Q?', options: ['a', 'b'], answer: 'a' }],
    });
    const result = parseGeneratedLearning(raw, 5000);
    expect(result.flashcards).toHaveLength(1);
    expect(result.quizzes).toHaveLength(1);
  });

  it('rejects empty', () => {
    expect(() => parseGeneratedLearning('', 5000)).toThrow();
  });

  it('rejects mcq answer not in options', () => {
    const raw = JSON.stringify({
      flashcards: [{ front: 'Q', back: 'A' }],
      quizzes: [{ type: 'mcq', question: 'Q?', options: ['a', 'b'], answer: 'c' }],
    });
    expect(() => parseGeneratedLearning(raw, 5000)).toThrow();
  });

  it('rejects no flashcards and no quizzes', () => {
    const raw = JSON.stringify({ flashcards: [], quizzes: [] });
    expect(() => parseGeneratedLearning(raw, 5000)).toThrow();
  });

  it('allows open quiz without options', () => {
    const raw = JSON.stringify({
      flashcards: [{ front: 'Q', back: 'A' }],
      quizzes: [{ type: 'open', question: 'Q?', answer: 'A' }],
    });
    const result = parseGeneratedLearning(raw, 5000);
    expect(result.quizzes[0]?.type).toBe('open');
  });
});