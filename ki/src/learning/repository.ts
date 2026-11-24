import { newId } from '../core/ids';
import { AppError } from '../core/errors';
import type { KeyValueStore } from '../storage/kv';
import type { Flashcard, QuizQuestion, ReviewState } from '../ai/learning/schema';

export interface StoredFlashcard extends Flashcard {
  id: string;
  createdAt: number;
  review: ReviewState;
}

export interface StoredQuiz extends QuizQuestion {
  id: string;
}

export interface LearningRecord {
  videoRecordId: string;
  videoTitle: string;
  videoUrl: string;
  model: string;
  createdAt: number;
  flashcards: StoredFlashcard[];
  quizzes: StoredQuiz[];
}

export interface LearningListItem {
  videoRecordId: string;
  videoTitle: string;
  videoUrl: string;
  model: string;
  cardCount: number;
  quizCount: number;
  dueCount: number;
  createdAt: number;
}

export const LEARNING_INDEX_KEY = 'videoking.learning.index.v1';
export const learningRecordKey = (videoRecordId: string): string =>
  `videoking.learning.${videoRecordId}`;

const INDEX_LIMIT = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function defaultReview(now: number): ReviewState {
  return { dueAt: now, intervalDays: 0, ease: 2.5, repetitions: 0, lapses: 0 };
}

function isReviewState(value: unknown): value is ReviewState {
  if (!isRecord(value)) return false;
  return (
    isNonNegativeNumber(value.dueAt) &&
    isNonNegativeNumber(value.intervalDays) &&
    typeof value.ease === 'number' &&
    Number.isFinite(value.ease) &&
    isNonNegativeNumber(value.repetitions) &&
    isNonNegativeNumber(value.lapses)
  );
}

function isStoredFlashcard(value: unknown): value is StoredFlashcard {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.front) &&
    isNonEmptyString(value.back) &&
    isNonNegativeNumber(value.createdAt) &&
    isReviewState(value.review) &&
    (value.sourceTimestampMs === undefined || isNonNegativeNumber(value.sourceTimestampMs))
  );
}

function isStoredQuiz(value: unknown): value is StoredQuiz {
  if (!isRecord(value)) return false;
  if (!isNonEmptyString(value.id) || !isNonEmptyString(value.question)) return false;
  if (value.type !== 'mcq' && value.type !== 'open') return false;
  if (!isNonEmptyString(value.answer)) return false;
  if (value.options !== undefined) {
    if (!Array.isArray(value.options) || !value.options.every(isNonEmptyString)) return false;
  }
  if (value.explanation !== undefined && typeof value.explanation !== 'string') return false;
  if (value.sourceTimestampMs !== undefined && !isNonNegativeNumber(value.sourceTimestampMs)) return false;
  return true;
}

function isLearningRecord(value: unknown): value is LearningRecord {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.videoRecordId) &&
    isNonEmptyString(value.videoTitle) &&
    isNonEmptyString(value.videoUrl) &&
    isNonEmptyString(value.model) &&
    isNonNegativeNumber(value.createdAt) &&
    Array.isArray(value.flashcards) &&
    value.flashcards.every(isStoredFlashcard) &&
    Array.isArray(value.quizzes) &&
    value.quizzes.every(isStoredQuiz)
  );
}

function isLearningListItem(value: unknown): value is LearningListItem {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.videoRecordId) &&
    isNonEmptyString(value.videoTitle) &&
    isNonEmptyString(value.videoUrl) &&
    isNonEmptyString(value.model) &&
    isNonNegativeNumber(value.cardCount) &&
    isNonNegativeNumber(value.quizCount) &&
    isNonNegativeNumber(value.dueCount) &&
    isNonNegativeNumber(value.createdAt)
  );
}

function toListItem(record: LearningRecord, now: number): LearningListItem {
  const dueCount = record.flashcards.filter((card) => card.review.dueAt <= now).length;
  return {
    videoRecordId: record.videoRecordId,
    videoTitle: record.videoTitle,
    videoUrl: record.videoUrl,
    model: record.model,
    cardCount: record.flashcards.length,
    quizCount: record.quizzes.length,
    dueCount,
    createdAt: record.createdAt,
  };
}

export interface SaveLearningInput {
  videoRecordId: string;
  videoTitle: string;
  videoUrl: string;
  model: string;
  flashcards: Array<{ front: string; back: string; timestampMs?: number }>;
  quizzes: Array<{
    type: 'mcq' | 'open';
    question: string;
    options?: string[];
    answer: string;
    explanation?: string;
    timestampMs?: number;
  }>;
  now?: number;
}

export class LearningRepository {
  constructor(private kv: KeyValueStore) {}

  async save(input: SaveLearningInput): Promise<LearningRecord> {
    const videoRecordId = input.videoRecordId.trim();
    if (videoRecordId.length === 0) throw new AppError('INVALID_INPUT', 'A video record id is required');
    if (!input.videoTitle?.trim() || !input.videoUrl?.trim()) {
      throw new AppError('INVALID_INPUT', 'A video title and url are required');
    }
    const now = input.now ?? Date.now();
    const flashcards: StoredFlashcard[] = input.flashcards.map((card) => ({
      id: newId('card'),
      front: card.front.trim(),
      back: card.back.trim(),
      ...(card.timestampMs === undefined ? {} : { sourceTimestampMs: card.timestampMs }),
      createdAt: now,
      review: defaultReview(now),
    }));
    const quizzes: StoredQuiz[] = input.quizzes.map((quiz) => ({
      id: newId('quiz'),
      type: quiz.type,
      question: quiz.question.trim(),
      answer: quiz.answer.trim(),
      ...(quiz.options ? { options: quiz.options.map((o) => o.trim()) } : {}),
      ...(quiz.explanation ? { explanation: quiz.explanation.trim() } : {}),
      ...(quiz.timestampMs === undefined ? {} : { sourceTimestampMs: quiz.timestampMs }),
    }));

    const record: LearningRecord = {
      videoRecordId,
      videoTitle: input.videoTitle.trim(),
      videoUrl: input.videoUrl.trim(),
      model: input.model.trim(),
      createdAt: now,
      flashcards,
      quizzes,
    };
    if (!isLearningRecord(record)) {
      throw new AppError('INVALID_INPUT', 'Refusing to store invalid learning material');
    }
    await this.kv.set(learningRecordKey(videoRecordId), record);
    const index = await this.readIndex();
    const next = [toListItem(record, now), ...index.filter((e) => e.videoRecordId !== videoRecordId)].slice(0, INDEX_LIMIT);
    await this.kv.set(LEARNING_INDEX_KEY, next);
    return record;
  }

  async get(videoRecordId: string): Promise<LearningRecord | undefined> {
    const raw = await this.kv.get<unknown>(learningRecordKey(videoRecordId));
    if (raw === undefined) return undefined;
    if (!isLearningRecord(raw)) throw new AppError('STORAGE', `Stored learning material is corrupt: ${videoRecordId}`);
    return raw;
  }

  async list(now: number = Date.now()): Promise<LearningListItem[]> {
    const records = await this.readAllRecords();
    return records.map((r) => toListItem(r, now)).sort((a, b) => b.createdAt - a.createdAt);
  }

  async listWithDue(now: number = Date.now()): Promise<LearningListItem[]> {
    const records = await this.readAllRecords();
    return records.map((r) => toListItem(r, now)).sort((a, b) => b.createdAt - a.createdAt);
  }

  async remove(videoRecordId: string): Promise<boolean> {
    const key = learningRecordKey(videoRecordId);
    const [current, index] = await Promise.all([this.kv.get<unknown>(key), this.readIndex()]);
    const inIndex = index.some((e) => e.videoRecordId === videoRecordId);
    await this.kv.remove(key);
    await this.kv.set(LEARNING_INDEX_KEY, index.filter((e) => e.videoRecordId !== videoRecordId));
    return current !== undefined || inIndex;
  }

  /** Update review state for one flashcard. */
  async reviewCard(
    videoRecordId: string,
    cardId: string,
    rating: 'again' | 'hard' | 'good' | 'easy',
    now: number = Date.now(),
  ): Promise<boolean> {
    const record = await this.get(videoRecordId);
    if (!record) return false;
    const card = record.flashcards.find((c) => c.id === cardId);
    if (!card) return false;
    const updated = applyReview(card.review, rating, now);
    card.review = updated;
    await this.kv.set(learningRecordKey(videoRecordId), record);
    const index = await this.readIndex();
    await this.kv.set(
      LEARNING_INDEX_KEY,
      index.map((e) => (e.videoRecordId === videoRecordId ? toListItem(record, now) : e)),
    );
    return true;
  }

  async dueCards(videoRecordId: string, now: number = Date.now()): Promise<StoredFlashcard[]> {
    const record = await this.get(videoRecordId);
    if (!record) return [];
    return record.flashcards.filter((c) => c.review.dueAt <= now);
  }

  private async readIndex(): Promise<LearningListItem[]> {
    const raw = await this.kv.get<unknown>(LEARNING_INDEX_KEY);
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const items: LearningListItem[] = [];
    for (const entry of raw) {
      if (!isLearningListItem(entry) || seen.has(entry.videoRecordId)) continue;
      seen.add(entry.videoRecordId);
      items.push(entry);
    }
    return items.sort((a, b) => b.createdAt - a.createdAt);
  }

  private async readAllRecords(): Promise<LearningRecord[]> {
    const index = await this.readIndex();
    const records: LearningRecord[] = [];
    for (const item of index) {
      const r = await this.get(item.videoRecordId);
      if (r) records.push(r);
    }
    return records;
  }
}

function applyReview(prev: ReviewState, rating: string, now: number): ReviewState {
  // Simple SM-2-ish. Ratings: again/hard/good/easy.
  let ease = prev.ease;
  let interval = prev.intervalDays;
  let reps = prev.repetitions;
  let lapses = prev.lapses;
  if (rating === 'again') {
    lapses += 1;
    reps = 0;
    interval = 1;
    ease = Math.max(1.3, ease - 0.2);
  } else {
    reps += 1;
    if (reps === 1) interval = rating === 'hard' ? 1 : rating === 'good' ? 3 : 4;
    else interval = Math.round(interval * (rating === 'hard' ? 1.2 : rating === 'good' ? ease : ease * 1.3));
    if (rating === 'hard') ease = Math.max(1.3, ease - 0.15);
    if (rating === 'easy') ease += 0.15;
  }
  const dueAt = now + interval * 24 * 60 * 60 * 1000;
  return { dueAt, intervalDays: interval, ease, repetitions: reps, lapses };
}