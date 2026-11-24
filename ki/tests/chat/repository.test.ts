import { describe, expect, it } from 'vitest';
import {
  ChatRepository,
  CHAT_INDEX_KEY,
  chatRecordKey,
  MAX_CHAT_MESSAGES,
} from '../../src/chat/repository';
import { MemoryStore } from '../../src/storage/kv';

const CITATION = {
  startMs: 5000,
  endMs: 10_000,
  text: 'Tomatoes need six hours of sunlight.',
};

function answerInput(question = 'How much sunlight?') {
  return {
    videoRecordId: 'yt_a',
    videoTitle: 'Test video',
    videoUrl: 'https://www.youtube.com/watch?v=a',
    question,
    answer: {
      kind: 'answer' as const,
      text: 'Tomatoes need six hours of sunlight.',
      citations: [CITATION],
    },
  };
}

describe('ChatRepository', () => {
  it('stores one validated exchange and lists it', async () => {
    const kv = new MemoryStore();
    const repository = new ChatRepository(kv);
    const { record, messageIds } = await repository.appendExchange(
      answerInput('  How much sunlight?  '),
    );

    expect(messageIds).toHaveLength(2);
    expect(record.messages).toHaveLength(2);
    expect(record.messages[0]).toMatchObject({
      role: 'user',
      text: 'How much sunlight?',
    });
    expect(record.messages[1]).toMatchObject({
      role: 'assistant',
      text: 'Tomatoes need six hours of sunlight.',
      citations: [CITATION],
    });
    expect(record.updatedAt).toBeGreaterThan(0);

    expect(await repository.get('yt_a')).toEqual(record);
    const list = await repository.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      videoRecordId: 'yt_a',
      videoTitle: 'Test video',
      messageCount: 2,
    });
  });

  it('stores an honest not-in-video answer without citations', async () => {
    const kv = new MemoryStore();
    const repository = new ChatRepository(kv);
    const { record } = await repository.appendExchange({
      ...answerInput('What is the capital of France?'),
      answer: { kind: 'notInVideo' },
    });
    expect(record.messages[1]).toMatchObject({
      role: 'assistant',
      text: '',
      notInVideo: true,
    });
    expect(record.messages[1]!.citations).toBeUndefined();
  });

  it('appends to the existing conversation and updates its metadata', async () => {
    const kv = new MemoryStore();
    const repository = new ChatRepository(kv);
    await repository.appendExchange(answerInput('First?'));
    await repository.appendExchange({
      ...answerInput('Second?'),
      videoTitle: 'Renamed video',
    });
    const record = await repository.get('yt_a');
    expect(record?.messages).toHaveLength(4);
    expect(record?.videoTitle).toBe('Renamed video');
    expect((await repository.list())[0]?.messageCount).toBe(4);
  });

  it('returns undefined for a missing conversation', async () => {
    const repository = new ChatRepository(new MemoryStore());
    expect(await repository.get('yt_missing')).toBeUndefined();
    expect(await repository.list()).toEqual([]);
  });

  it('reports corruption as a typed STORAGE error', async () => {
    const kv = new MemoryStore();
    await kv.set(chatRecordKey('yt_a'), { nope: true });
    const repository = new ChatRepository(kv);
    await expect(repository.get('yt_a')).rejects.toMatchObject({
      code: 'STORAGE',
    });
  });

  it('ignores corrupt index entries instead of failing the list', async () => {
    const kv = new MemoryStore();
    const repository = new ChatRepository(kv);
    await repository.appendExchange(answerInput());
    const list = await repository.list();
    await kv.set(CHAT_INDEX_KEY, [{ broken: true }, ...list]);
    expect(await repository.list()).toEqual(list);
  });

  it('removes specific messages and drops the record when it empties', async () => {
    const kv = new MemoryStore();
    const repository = new ChatRepository(kv);
    const { messageIds } = await repository.appendExchange(answerInput());

    expect(await repository.removeMessages('yt_a', [messageIds[1]])).toBe(1);
    const remaining = await repository.get('yt_a');
    expect(remaining?.messages).toHaveLength(1);
    expect(remaining?.messages[0]?.role).toBe('user');

    expect(await repository.removeMessages('yt_a', [messageIds[0]])).toBe(1);
    expect(await repository.get('yt_a')).toBeUndefined();
    expect(await repository.list()).toEqual([]);
  });

  it('keeps the conversation bounded and starts it on a user turn', async () => {
    const repository = new ChatRepository(new MemoryStore());
    for (let index = 0; index < MAX_CHAT_MESSAGES / 2 + 1; index += 1) {
      await repository.appendExchange(answerInput(`Question ${index}?`));
    }
    const record = await repository.get('yt_a');
    expect(record?.messages).toHaveLength(MAX_CHAT_MESSAGES);
    expect(record?.messages[0]?.role).toBe('user');
    expect(record?.messages[record.messages.length - 1]?.role).toBe(
      'assistant',
    );
  });

  it('removes a conversation and reports whether it existed', async () => {
    const repository = new ChatRepository(new MemoryStore());
    await repository.appendExchange(answerInput());
    expect(await repository.remove('yt_a')).toBe(true);
    expect(await repository.remove('yt_a')).toBe(false);
    expect(await repository.list()).toEqual([]);
  });

  it('refuses invalid input instead of storing it', async () => {
    const repository = new ChatRepository(new MemoryStore());
    await expect(
      repository.appendExchange(answerInput('   ')),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      repository.appendExchange({
        ...answerInput(),
        answer: { kind: 'answer', text: '', citations: [CITATION] },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      repository.appendExchange({
        ...answerInput(),
        answer: { kind: 'answer', text: 'text', citations: [] },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(await repository.list()).toEqual([]);
  });
});
