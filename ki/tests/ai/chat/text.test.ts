import { describe, expect, it } from 'vitest';
import {
  indexTerms,
  isStopword,
  normalizeText,
  stem,
  tokenize,
} from '../../../src/ai/chat/text';

describe('chat text normalization', () => {
  it('folds case and strips Arabic diacritics and tatweel', () => {
    expect(normalizeText('  HELLO  ')).toBe('  hello  ');
    expect(normalizeText('مُحَمَّد')).toBe('محمد');
    expect(normalizeText('مـــحمد')).toBe('محمد');
  });

  it('folds Arabic letter variants', () => {
    expect(normalizeText('أحمد إسلام آدم')).toBe('احمد اسلام ادم');
    expect(normalizeText('مصطفى')).toBe('مصطفي');
    expect(normalizeText('مدرسة')).toBe('مدرسه');
    expect(normalizeText('مؤمن')).toBe('مومن');
    expect(normalizeText('رئيس')).toBe('رييس');
  });

  it('tokenizes letters and numbers only', () => {
    expect(tokenize('Hello, world! 42')).toEqual(['hello', 'world', '42']);
    expect(tokenize('  ...  ')).toEqual([]);
    expect(tokenize('مرحبا بالعالم')).toEqual(['مرحبا', 'بالعالم']);
  });

  it('removes English and Arabic stopwords', () => {
    expect(indexTerms('What is the plan?')).toEqual(['plan']);
    expect(indexTerms('ما هو الفيديو')).toEqual(['فيديو']);
    expect(isStopword('the')).toBe(true);
    expect(isStopword('هو')).toBe(true);
    expect(isStopword('sunlight')).toBe(false);
  });

  it('keeps numbers because specs are often the answer', () => {
    expect(indexTerms('2026')).toEqual(['2026']);
    expect(indexTerms('six hours')).toEqual(['six', 'hour']);
  });

  it('stems the same word written with different affixes to one term', () => {
    expect(indexTerms('videos')).toEqual(indexTerms('video'));
    expect(indexTerms('المدرسة')).toEqual(indexTerms('مدرسه'));
    expect(indexTerms('والفيديو')).toEqual(indexTerms('فيديو'));
  });

  it('is stable for empty and punctuation-only input', () => {
    expect(stem('')).toBe('');
    expect(indexTerms('')).toEqual([]);
    expect(indexTerms('!!!')).toEqual([]);
  });
});
