import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../../src/storage/kv';
import { LearningRepository } from '../../src/learning/repository';

describe('learning/repository', () => {
  it('saves and reads', async () => {
    const kv = new MemoryStore();
    const repo = new LearningRepository(kv);
    const record = await repo.save({
      videoRecordId: 'v1',
      videoTitle: 'Title',
      videoUrl: 'https://example.com',
      model: 'm',
      flashcards: [{ front: 'Q', back: 'A' }],
      quizzes: [{ type: 'open', question: 'Q?', answer: 'A' }],
    });
    expect(record.flashcards).toHaveLength(1);
    const got = await repo.get('v1');
    expect(got?.flashcards[0]?.front).toBe('Q');
    const list = await repo.list();
    expect(list).toHaveLength(1);
  });

  it('remove works', async () => {
    const kv = new MemoryStore();
    const repo = new LearningRepository(kv);
    await repo.save({
      videoRecordId: 'v1',
      videoTitle: 'Title',
      videoUrl: 'https://example.com',
      model: 'm',
      flashcards: [{ front: 'Q', back: 'A' }],
      quizzes: [],
    });
    expect(await repo.remove('v1')).toBe(true);
    expect(await repo.remove('v1')).toBe(false);
  });

  it('reviewCard updates state', async () => {
    const kv = new MemoryStore();
    const repo = new LearningRepository(kv);
    const record = await repo.save({
      videoRecordId: 'v1',
      videoTitle: 'Title',
      videoUrl: 'https://example.com',
      model: 'm',
      flashcards: [{ front: 'Q', back: 'A' }],
      quizzes: [],
    });
    const cardId = record.flashcards[0]!.id;
    const ok = await repo.reviewCard('v1', cardId, 'good', Date.now());
    expect(ok).toBe(true);
    const updated = await repo.get('v1');
    expect(updated?.flashcards[0]?.review.repetitions).toBe(1);
  });

  it('dueCards returns due', async () => {
    const kv = new MemoryStore();
    const repo = new LearningRepository(kv);
    await repo.save({
      videoRecordId: 'v1',
      videoTitle: 'Title',
      videoUrl: 'https://example.com',
      model: 'm',
      flashcards: [{ front: 'Q', back: 'A' }],
      quizzes: [],
    });
    const due = await repo.dueCards('v1', Date.now() + 100000);
    expect(due).toHaveLength(1);
  });
});