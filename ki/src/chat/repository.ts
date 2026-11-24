import { isChatCitation, type ChatCitation } from '../ai/chat/schema';
import { AppError } from '../core/errors';
import { newId } from '../core/ids';
import type { KeyValueStore } from '../storage/kv';

/**
 * Local chat transcripts, one conversation per captured video. Records live
 * under their own key; a small metadata index powers the conversation list
 * without reading every message. Older messages are trimmed so storage stays
 * bounded on long-running conversations.
 */

export interface ChatMessageRecord {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: number;
  /** Assistant only: citations resolved from real transcript segments. */
  citations?: ChatCitation[];
  /** Assistant only: retrieval/model found no support in the transcript. */
  notInVideo?: boolean;
}

export interface ChatRecord {
  videoRecordId: string;
  videoTitle: string;
  videoUrl: string;
  messages: ChatMessageRecord[];
  updatedAt: number;
}

export interface ChatListItem {
  videoRecordId: string;
  videoTitle: string;
  videoUrl: string;
  messageCount: number;
  updatedAt: number;
}

export type ChatAnswerRecord =
  | { kind: 'answer'; text: string; citations: ChatCitation[] }
  | { kind: 'notInVideo' };

export interface AppendExchangeInput {
  videoRecordId: string;
  videoTitle: string;
  videoUrl: string;
  question: string;
  answer: ChatAnswerRecord;
}

export interface ChatExchange {
  record: ChatRecord;
  /** Ids of the two messages just written (used to undo on cancel). */
  messageIds: [string, string];
}

export const CHAT_INDEX_KEY = 'videoking.chat.index.v1';
export const chatRecordKey = (videoRecordId: string): string =>
  `videoking.chat.${videoRecordId}`;
export const MAX_CHAT_MESSAGES = 60;

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

function isChatMessageRecord(value: unknown): value is ChatMessageRecord {
  if (!isRecord(value)) return false;
  if (!isNonEmptyString(value.id)) return false;
  if (!isNonNegativeNumber(value.createdAt)) return false;
  if (value.role === 'user') {
    return isNonEmptyString(value.text);
  }
  if (value.role !== 'assistant') return false;
  if (value.notInVideo === true) {
    return (
      (value.citations === undefined ||
        (Array.isArray(value.citations) && value.citations.length === 0)) &&
      (value.text === undefined || typeof value.text === 'string')
    );
  }
  return (
    isNonEmptyString(value.text) &&
    Array.isArray(value.citations) &&
    value.citations.length > 0 &&
    value.citations.every(isChatCitation)
  );
}

function isChatRecord(value: unknown): value is ChatRecord {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.videoRecordId) &&
    isNonEmptyString(value.videoTitle) &&
    isNonEmptyString(value.videoUrl) &&
    isNonNegativeNumber(value.updatedAt) &&
    Array.isArray(value.messages) &&
    value.messages.length > 0 &&
    value.messages.every(isChatMessageRecord)
  );
}

function isChatListItem(value: unknown): value is ChatListItem {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.videoRecordId) &&
    isNonEmptyString(value.videoTitle) &&
    isNonEmptyString(value.videoUrl) &&
    isNonNegativeNumber(value.messageCount) &&
    value.messageCount > 0 &&
    isNonNegativeNumber(value.updatedAt)
  );
}

/** Keep the newest messages, starting on a user turn (no orphan answers). */
function trimMessages(messages: ChatMessageRecord[]): ChatMessageRecord[] {
  if (messages.length <= MAX_CHAT_MESSAGES) return messages;
  let start = messages.length - MAX_CHAT_MESSAGES;
  while (start < messages.length && messages[start]?.role !== 'user') {
    start += 1;
  }
  return messages.slice(start);
}

function toListItem(record: ChatRecord): ChatListItem {
  return {
    videoRecordId: record.videoRecordId,
    videoTitle: record.videoTitle,
    videoUrl: record.videoUrl,
    messageCount: record.messages.length,
    updatedAt: record.updatedAt,
  };
}

export class ChatRepository {
  constructor(private kv: KeyValueStore) {}

  async get(videoRecordId: string): Promise<ChatRecord | undefined> {
    const raw = await this.kv.get<unknown>(chatRecordKey(videoRecordId));
    if (raw === undefined) return undefined;
    if (!isChatRecord(raw)) {
      throw new AppError('STORAGE', `Stored chat is corrupt: ${videoRecordId}`);
    }
    return raw;
  }

  /**
   * Append one validated question/answer pair. Nothing is written when the
   * model output was rejected, so a failed or cancelled turn never leaves a
   * partial message behind.
   */
  async appendExchange(input: AppendExchangeInput): Promise<ChatExchange> {
    const question = input.question.trim();
    if (question.length === 0) {
      throw new AppError('INVALID_INPUT', 'A question is required');
    }
    const existing = await this.get(input.videoRecordId);
    const now = Date.now();
    const user: ChatMessageRecord = {
      id: newId('msg'),
      role: 'user',
      text: question,
      createdAt: now,
    };
    const assistant: ChatMessageRecord =
      input.answer.kind === 'notInVideo'
        ? {
            id: newId('msg'),
            role: 'assistant',
            text: '',
            createdAt: now,
            notInVideo: true,
          }
        : {
            id: newId('msg'),
            role: 'assistant',
            text: input.answer.text,
            createdAt: now,
            citations: input.answer.citations,
          };

    const record: ChatRecord = {
      videoRecordId: input.videoRecordId,
      videoTitle: input.videoTitle,
      videoUrl: input.videoUrl,
      messages: trimMessages([...(existing?.messages ?? []), user, assistant]),
      updatedAt: now,
    };
    if (!isChatRecord(record)) {
      throw new AppError(
        'INVALID_INPUT',
        'Refusing to store an invalid chat record',
      );
    }

    await this.kv.set(chatRecordKey(record.videoRecordId), record);
    const index = await this.readIndex();
    const next = [
      toListItem(record),
      ...index.filter(
        (entry) => entry.videoRecordId !== record.videoRecordId,
      ),
    ].slice(0, INDEX_LIMIT);
    await this.kv.set(CHAT_INDEX_KEY, next);
    return { record, messageIds: [user.id, assistant.id] };
  }

  /** Remove specific messages (used when a cancel races a completed write). */
  async removeMessages(
    videoRecordId: string,
    ids: readonly string[],
  ): Promise<number> {
    if (ids.length === 0) return 0;
    const record = await this.get(videoRecordId);
    if (!record) return 0;
    const drop = new Set(ids);
    const messages = record.messages.filter((message) => !drop.has(message.id));
    const removed = record.messages.length - messages.length;
    if (removed === 0) return 0;

    if (messages.length === 0) {
      await this.remove(videoRecordId);
      return removed;
    }
    const next: ChatRecord = { ...record, messages, updatedAt: Date.now() };
    await this.kv.set(chatRecordKey(videoRecordId), next);
    const index = await this.readIndex();
    await this.kv.set(
      CHAT_INDEX_KEY,
      index.map((entry) =>
        entry.videoRecordId === videoRecordId ? toListItem(next) : entry,
      ),
    );
    return removed;
  }

  async list(): Promise<ChatListItem[]> {
    return this.readIndex();
  }

  async remove(videoRecordId: string): Promise<boolean> {
    const key = chatRecordKey(videoRecordId);
    const [current, index] = await Promise.all([
      this.kv.get<unknown>(key),
      this.readIndex(),
    ]);
    const inIndex = index.some(
      (entry) => entry.videoRecordId === videoRecordId,
    );
    await this.kv.remove(key);
    await this.kv.set(
      CHAT_INDEX_KEY,
      index.filter((entry) => entry.videoRecordId !== videoRecordId),
    );
    return current !== undefined || inIndex;
  }

  private async readIndex(): Promise<ChatListItem[]> {
    const raw = await this.kv.get<unknown>(CHAT_INDEX_KEY);
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const items: ChatListItem[] = [];
    for (const entry of raw) {
      if (!isChatListItem(entry) || seen.has(entry.videoRecordId)) continue;
      seen.add(entry.videoRecordId);
      items.push(entry);
    }
    return items.sort((a, b) => b.updatedAt - a.updatedAt);
  }
}
