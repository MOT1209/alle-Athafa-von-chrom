import { AppError } from '../core/errors';
import type { KeyValueStore } from '../storage/kv';
import type { KidsStory } from '../ai/studio/schema';

export interface StoredStory {
  id: string;
  concept: string;
  title: string;
  segments: KidsStory['segments'];
  model: string;
  createdAt: number;
  safe: boolean;
}

export interface StoryListItem {
  id: string;
  concept: string;
  title: string;
  segmentCount: number;
  createdAt: number;
}

export const STORIES_INDEX_KEY = 'videoking.stories.index.v1';
export const storyKey = (id: string): string => `videoking.story.${id}`;

const INDEX_LIMIT = 100;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function isNonNegativeNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

function isStoredStory(v: unknown): v is StoredStory {
  if (!isRecord(v)) return false;
  return (
    isNonEmptyString(v.id) &&
    isNonEmptyString(v.concept) &&
    isNonEmptyString(v.title) &&
    Array.isArray(v.segments) &&
    v.segments.length > 0 &&
    v.segments.every((s) => isRecord(s) && isNonEmptyString(s.text)) &&
    isNonEmptyString(v.model) &&
    isNonNegativeNumber(v.createdAt) &&
    typeof v.safe === 'boolean'
  );
}

function isStoryListItem(v: unknown): v is StoryListItem {
  if (!isRecord(v)) return false;
  return (
    isNonEmptyString(v.id) &&
    isNonEmptyString(v.concept) &&
    isNonEmptyString(v.title) &&
    isNonNegativeNumber(v.segmentCount) &&
    isNonNegativeNumber(v.createdAt)
  );
}

export class StoryRepository {
  constructor(private kv: KeyValueStore) {}

  async save(input: {
    concept: string;
    story: KidsStory;
    model: string;
    safe: boolean;
    now?: number;
  }): Promise<StoredStory> {
    const now = input.now ?? Date.now();
    const id = `story_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const record: StoredStory = {
      id,
      concept: input.concept.trim(),
      title: input.story.title,
      segments: input.story.segments,
      model: input.model.trim(),
      createdAt: now,
      safe: input.safe,
    };
    if (!isStoredStory(record)) throw new AppError('INVALID_INPUT', 'Invalid story record');
    await this.kv.set(storyKey(id), record);
    const index = await this.readIndex();
    const item: StoryListItem = { id, concept: record.concept, title: record.title, segmentCount: record.segments.length, createdAt: now };
    await this.kv.set(STORIES_INDEX_KEY, [item, ...index.filter((e) => e.id !== id)].slice(0, INDEX_LIMIT));
    return record;
  }

  async get(id: string): Promise<StoredStory | undefined> {
    const raw = await this.kv.get<unknown>(storyKey(id));
    if (raw === undefined) return undefined;
    if (!isStoredStory(raw)) throw new AppError('STORAGE', `Corrupt story: ${id}`);
    return raw;
  }

  async list(): Promise<StoryListItem[]> {
    const raw = await this.kv.get<unknown>(STORIES_INDEX_KEY);
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const items: StoryListItem[] = [];
    for (const e of raw) {
      if (!isStoryListItem(e) || seen.has(e.id)) continue;
      seen.add(e.id);
      items.push(e);
    }
    return items.sort((a, b) => b.createdAt - a.createdAt);
  }

  async remove(id: string): Promise<boolean> {
    const key = storyKey(id);
    const [current, index] = await Promise.all([this.kv.get<unknown>(key), this.readIndex()]);
    const inIndex = index.some((e) => e.id === id);
    await this.kv.remove(key);
    await this.kv.set(STORIES_INDEX_KEY, index.filter((e) => e.id !== id));
    return current !== undefined || inIndex;
  }

  private async readIndex(): Promise<StoryListItem[]> {
    const raw = await this.kv.get<unknown>(STORIES_INDEX_KEY);
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const items: StoryListItem[] = [];
    for (const e of raw) {
      if (!isStoryListItem(e) || seen.has(e.id)) continue;
      seen.add(e.id);
      items.push(e);
    }
    return items.sort((a, b) => b.createdAt - a.createdAt);
  }
}