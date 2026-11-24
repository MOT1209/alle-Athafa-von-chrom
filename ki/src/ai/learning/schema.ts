import { AppError } from '../../core/errors';
import { parseTimestampMs } from '../summary/time';

export interface ReviewState {
  dueAt: number;
  intervalDays: number;
  ease: number;
  repetitions: number;
  lapses: number;
}

export interface Flashcard {
  id?: string;
  front: string;
  back: string;
  sourceTimestampMs?: number;
  createdAt?: number;
  review?: ReviewState;
}

export interface QuizQuestion {
  question: string;
  type: 'mcq' | 'open';
  options?: string[];
  answer: string;
  explanation?: string;
  sourceTimestampMs?: number;
}

export interface GeneratedLearning {
  flashcards: Array<{
    front: string;
    back: string;
    timestampMs?: number;
  }>;
  quizzes: Array<{
    type: 'mcq' | 'open';
    question: string;
    options?: string[];
    answer: string;
    explanation?: string;
    timestampMs?: number;
  }>;
}

export const MAX_FLASHCARDS = 20;
export const MAX_QUIZZES = 15;
export const MAX_CARD_CHARS = 400;
export const MAX_QUIZ_CHARS = 600;
export const MAX_OPTION_CHARS = 200;

function invalid(problem: string, detail?: unknown): AppError {
  return new AppError('BAD_RESPONSE', `The local model returned invalid learning material: ${problem}`, {
    retryable: true,
    hint: 'The invalid result was discarded and will be retried automatically.',
    ...(detail === undefined ? {} : { detail }),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readText(source: Record<string, unknown>, key: string, max: number, required: boolean, _stage: string): string | undefined {
  const raw = source[key];
  if (raw === undefined || raw === null) {
    if (required) throw invalid(`"${key}" is required`);
    return undefined;
  }
  if (typeof raw !== 'string') throw invalid(`"${key}" must be a string`);
  const text = raw.replace(/\s+/g, ' ').trim();
  if (text.length === 0) {
    if (required) throw invalid(`"${key}" is empty`);
    return undefined;
  }
  if (text.length > max) throw invalid(`"${key}" is longer than ${max} characters`);
  return text;
}

function readTimestamp(source: Record<string, unknown>, maxTimestampMs: number): number | undefined {
  for (const key of ['timestampMs', 'timestamp', 'startMs', 'start', 'time']) {
    if (key in source && source[key] !== undefined) {
      const ms = parseTimestampMs(source[key]);
      if (ms === undefined) throw invalid('timestamp must be milliseconds or a clock value');
      if (ms < 0 || ms > maxTimestampMs) return undefined;
      return ms;
    }
  }
  return undefined;
}

export function parseGeneratedLearning(raw: string, maxTimestampMs: number): GeneratedLearning {
  const stage = 'learning material';
  if (typeof raw !== 'string' || raw.trim().length === 0) throw invalid('the response was empty');
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch {
    throw invalid('the response was not valid JSON', { preview: raw.slice(0, 160) });
  }
  if (!isRecord(parsed)) throw invalid('the response was not a JSON object');
  for (const key of Object.keys(parsed)) {
    if (key !== 'flashcards' && key !== 'quizzes') throw invalid(`unexpected top-level key "${key}"`);
  }

  const rawCards = parsed.flashcards;
  if (!Array.isArray(rawCards)) throw invalid('"flashcards" must be an array');
  if (rawCards.length > MAX_FLASHCARDS) throw invalid(`at most ${MAX_FLASHCARDS} flashcards`);

  const flashcards: GeneratedLearning['flashcards'] = [];
  const seenFronts = new Set<string>();
  for (const entry of rawCards) {
    if (!isRecord(entry)) throw invalid('each flashcard must be an object');
    const front = readText(entry, 'front', MAX_CARD_CHARS, true, stage);
    const back = readText(entry, 'back', MAX_CARD_CHARS, true, stage);
    if (front === undefined || back === undefined) continue;
    const dedupe = front.toLocaleLowerCase();
    if (seenFronts.has(dedupe)) continue;
    seenFronts.add(dedupe);
    const timestampMs = readTimestamp(entry, maxTimestampMs);
    const card: GeneratedLearning['flashcards'][number] = { front, back };
    if (timestampMs !== undefined) card.timestampMs = timestampMs;
    flashcards.push(card);
  }
  if (flashcards.length === 0) throw invalid('at least one flashcard is required');

  const rawQuizzes = parsed.quizzes;
  if (!Array.isArray(rawQuizzes)) throw invalid('"quizzes" must be an array');
  if (rawQuizzes.length > MAX_QUIZZES) throw invalid(`at most ${MAX_QUIZZES} quizzes`);

  const quizzes: GeneratedLearning['quizzes'] = [];
  for (const entry of rawQuizzes) {
    if (!isRecord(entry)) throw invalid('each quiz must be an object');
    const type = entry.type;
    if (type !== 'mcq' && type !== 'open') throw invalid('"type" must be "mcq" or "open"');
    const question = readText(entry, 'question', MAX_QUIZ_CHARS, true, stage);
    if (question === undefined) continue;
    const answer = readText(entry, 'answer', MAX_QUIZ_CHARS, true, stage);
    if (answer === undefined) continue;
    const explanation = readText(entry, 'explanation', MAX_QUIZ_CHARS, false, stage);
    const timestampMs = readTimestamp(entry, maxTimestampMs);

    let options: string[] | undefined;
    if (type === 'mcq') {
      const rawOpts = entry.options;
      if (!Array.isArray(rawOpts) || rawOpts.length < 2 || rawOpts.length > 6) {
        throw invalid('mcq must have 2-6 options');
      }
      options = [];
      const seen = new Set<string>();
      for (const opt of rawOpts) {
        if (typeof opt !== 'string') throw invalid('each option must be a string');
        const clean = opt.replace(/\s+/g, ' ').trim();
        if (clean.length === 0) throw invalid('option cannot be empty');
        if (clean.length > MAX_OPTION_CHARS) throw invalid('option too long');
        if (seen.has(clean.toLocaleLowerCase())) continue;
        seen.add(clean.toLocaleLowerCase());
        options.push(clean);
      }
      if (options.length < 2) throw invalid('mcq needs at least 2 distinct options');
      if (!options.some((o) => o.toLocaleLowerCase() === answer.toLocaleLowerCase())) {
        throw invalid('mcq answer must be one of the options');
      }
    }

    const quiz: GeneratedLearning['quizzes'][number] = { type, question, answer };
    if (options !== undefined) quiz.options = options;
    if (explanation !== undefined) quiz.explanation = explanation;
    if (timestampMs !== undefined) quiz.timestampMs = timestampMs;
    quizzes.push(quiz);
  }
  if (quizzes.length === 0 && flashcards.length === 0) throw invalid('no material generated');

  return { flashcards, quizzes };
}