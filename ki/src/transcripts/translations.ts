import type { TranscriptSegment } from '../ai/types';
import { AppError } from '../core/errors';
import type { KeyValueStore } from '../storage/kv';
import { isTranscriptSegment, normalizeSegmentText } from './editor';

/**
 * Local translation bundles: one record per captured video holding at most one
 * translation per target language. A small metadata index powers the list
 * without reading every transcript-sized bundle.
 *
 * Every translation stores the signature of the source transcript it was made
 * from. When the source text is edited the stored work is kept and flagged as
 * stale instead of being deleted silently.
 */

export interface TranslationRecord {
  targetLanguage: string;
  sourceLanguage?: string;
  model: string;
  createdAt: number;
  /** Signature of the source transcript at translation time. */
  sourceSignature: string;
  /** Timestamps are copied verbatim from the source segments. */
  segments: TranscriptSegment[];
}

export interface TranslationBundle {
  videoRecordId: string;
  videoTitle: string;
  videoUrl: string;
  updatedAt: number;
  translations: Record<string, TranslationRecord>;
}

export interface TranslationListItem {
  videoRecordId: string;
  videoTitle: string;
  videoUrl: string;
  languages: string[];
  updatedAt: number;
}

export const TRANSLATIONS_INDEX_KEY = 'videoking.translations.index.v1';
export const translationBundleKey = (videoRecordId: string): string =>
  `videoking.translations.${videoRecordId}`;

const INDEX_LIMIT = 200;
const LANGUAGE_CODE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/;

/** Lowercase BCP-47-ish code, or undefined when the value is not a language. */
export function normalizeLanguageCode(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const code = value.trim().toLowerCase();
  return LANGUAGE_CODE.test(code) ? code : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isTranslationRecord(value: unknown): value is TranslationRecord {
  if (!isRecord(value)) return false;
  const target = normalizeLanguageCode(value.targetLanguage);
  return (
    target !== undefined &&
    target === value.targetLanguage &&
    (value.sourceLanguage === undefined ||
      normalizeLanguageCode(value.sourceLanguage) === value.sourceLanguage) &&
    isNonEmptyString(value.model) &&
    isNonNegativeNumber(value.createdAt) &&
    isNonEmptyString(value.sourceSignature) &&
    Array.isArray(value.segments) &&
    value.segments.length > 0 &&
    value.segments.every(isTranscriptSegment)
  );
}

function isTranslationBundle(value: unknown): value is TranslationBundle {
  if (!isRecord(value)) return false;
  if (
    !isNonEmptyString(value.videoRecordId) ||
    !isNonEmptyString(value.videoTitle) ||
    !isNonEmptyString(value.videoUrl) ||
    !isNonNegativeNumber(value.updatedAt) ||
    !isRecord(value.translations)
  ) {
    return false;
  }
  const entries = Object.entries(value.translations);
  if (entries.length === 0) return false;
  return entries.every(
    ([code, translation]) =>
      normalizeLanguageCode(code) === code &&
      isTranslationRecord(translation) &&
      translation.targetLanguage === code,
  );
}

function isTranslationListItem(value: unknown): value is TranslationListItem {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.videoRecordId) &&
    isNonEmptyString(value.videoTitle) &&
    isNonEmptyString(value.videoUrl) &&
    isNonNegativeNumber(value.updatedAt) &&
    Array.isArray(value.languages) &&
    value.languages.length > 0 &&
    value.languages.every(
      (code) => typeof code === 'string' && normalizeLanguageCode(code) === code,
    )
  );
}

function normalizeSegment(segment: TranscriptSegment): TranscriptSegment {
  return {
    startMs: Math.max(0, Math.round(segment.startMs)),
    endMs: Math.max(0, Math.round(segment.endMs)),
    text: normalizeSegmentText(segment.text),
  };
}

function normalizeTranslation(record: TranslationRecord): TranslationRecord {
  const target = normalizeLanguageCode(record.targetLanguage);
  if (target === undefined) {
    throw new AppError('INVALID_INPUT', 'A valid target language is required');
  }
  const segments = record.segments.map(normalizeSegment);
  if (segments.length === 0 || !segments.every(isTranscriptSegment)) {
    throw new AppError(
      'INVALID_INPUT',
      'A translation must contain at least one readable segment',
    );
  }
  const normalized: TranslationRecord = {
    targetLanguage: target,
    model: record.model.trim(),
    createdAt: Math.max(0, Math.round(record.createdAt)),
    sourceSignature: record.sourceSignature.trim(),
    segments,
  };
  if (record.sourceLanguage !== undefined) {
    const source = normalizeLanguageCode(record.sourceLanguage);
    if (source === undefined) {
      throw new AppError('INVALID_INPUT', 'Invalid source language');
    }
    normalized.sourceLanguage = source;
  }
  if (!isTranslationRecord(normalized)) {
    throw new AppError('INVALID_INPUT', 'Refusing to store an invalid translation');
  }
  return normalized;
}

function toListItem(bundle: TranslationBundle): TranslationListItem {
  return {
    videoRecordId: bundle.videoRecordId,
    videoTitle: bundle.videoTitle,
    videoUrl: bundle.videoUrl,
    languages: Object.keys(bundle.translations).sort(),
    updatedAt: bundle.updatedAt,
  };
}

export interface SaveTranslationInput {
  videoRecordId: string;
  videoTitle: string;
  videoUrl: string;
  translation: TranslationRecord;
}

/**
 * Language codes whose stored translation no longer matches the current source
 * transcript signature. The caller decides whether to warn or re-translate.
 */
export function staleLanguages(
  bundle: TranslationBundle,
  currentSignature: string,
): string[] {
  return Object.values(bundle.translations)
    .filter((translation) => translation.sourceSignature !== currentSignature)
    .map((translation) => translation.targetLanguage)
    .sort();
}

export class TranslationRepository {
  constructor(private kv: KeyValueStore) {}

  async save(input: SaveTranslationInput): Promise<TranslationBundle> {
    const videoRecordId = input.videoRecordId.trim();
    if (videoRecordId.length === 0) {
      throw new AppError('INVALID_INPUT', 'A video record id is required');
    }
    if (
      typeof input.videoTitle !== 'string' ||
      input.videoTitle.trim().length === 0 ||
      typeof input.videoUrl !== 'string' ||
      input.videoUrl.trim().length === 0
    ) {
      throw new AppError('INVALID_INPUT', 'A video title and url are required');
    }
    const translation = normalizeTranslation(input.translation);
    const existing = await this.get(videoRecordId);
    const bundle: TranslationBundle = {
      videoRecordId,
      videoTitle: input.videoTitle.trim(),
      videoUrl: input.videoUrl.trim(),
      updatedAt: Date.now(),
      translations: {
        ...(existing?.translations ?? {}),
        [translation.targetLanguage]: translation,
      },
    };
    if (!isTranslationBundle(bundle)) {
      throw new AppError('INVALID_INPUT', 'Refusing to store an invalid translation bundle');
    }
    await this.kv.set(translationBundleKey(videoRecordId), bundle);
    const index = await this.readIndex();
    await this.kv.set(
      TRANSLATIONS_INDEX_KEY,
      [toListItem(bundle), ...index.filter((entry) => entry.videoRecordId !== videoRecordId)].slice(
        0,
        INDEX_LIMIT,
      ),
    );
    return bundle;
  }

  async get(videoRecordId: string): Promise<TranslationBundle | undefined> {
    const raw = await this.kv.get<unknown>(translationBundleKey(videoRecordId));
    if (raw === undefined) return undefined;
    if (!isTranslationBundle(raw)) {
      throw new AppError(
        'STORAGE',
        `Stored translations are corrupt: ${videoRecordId}`,
      );
    }
    return raw;
  }

  async getTranslation(
    videoRecordId: string,
    targetLanguage: string,
  ): Promise<TranslationRecord | undefined> {
    const code = normalizeLanguageCode(targetLanguage);
    if (code === undefined) return undefined;
    const bundle = await this.get(videoRecordId);
    return bundle?.translations[code];
  }

  async list(): Promise<TranslationListItem[]> {
    return this.readIndex();
  }

  /** Remove one language; the bundle is deleted when it becomes empty. */
  async removeLanguage(
    videoRecordId: string,
    targetLanguage: string,
  ): Promise<boolean> {
    const code = normalizeLanguageCode(targetLanguage);
    if (code === undefined) return false;
    const bundle = await this.get(videoRecordId);
    if (!bundle || bundle.translations[code] === undefined) return false;
    const translations = { ...bundle.translations };
    delete translations[code];
    if (Object.keys(translations).length === 0) {
      await this.remove(videoRecordId);
      return true;
    }
    const next: TranslationBundle = {
      ...bundle,
      translations,
      updatedAt: Date.now(),
    };
    await this.kv.set(translationBundleKey(videoRecordId), next);
    const index = await this.readIndex();
    await this.kv.set(
      TRANSLATIONS_INDEX_KEY,
      index.map((entry) =>
        entry.videoRecordId === videoRecordId ? toListItem(next) : entry,
      ),
    );
    return true;
  }

  async remove(videoRecordId: string): Promise<boolean> {
    const key = translationBundleKey(videoRecordId);
    const [current, index] = await Promise.all([
      this.kv.get<unknown>(key),
      this.readIndex(),
    ]);
    const inIndex = index.some((entry) => entry.videoRecordId === videoRecordId);
    await this.kv.remove(key);
    await this.kv.set(
      TRANSLATIONS_INDEX_KEY,
      index.filter((entry) => entry.videoRecordId !== videoRecordId),
    );
    return current !== undefined || inIndex;
  }

  private async readIndex(): Promise<TranslationListItem[]> {
    const raw = await this.kv.get<unknown>(TRANSLATIONS_INDEX_KEY);
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const items: TranslationListItem[] = [];
    for (const entry of raw) {
      if (!isTranslationListItem(entry) || seen.has(entry.videoRecordId)) {
        continue;
      }
      seen.add(entry.videoRecordId);
      items.push(entry);
    }
    return items.sort((a, b) => b.updatedAt - a.updatedAt);
  }
}
