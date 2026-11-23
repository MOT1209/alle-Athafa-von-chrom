import { describe, expect, it } from 'vitest';
import {
  SUMMARIES_INDEX_KEY,
  SummaryRepository,
  summaryRecordKey,
  type SummaryRecord,
} from '../../src/summary/repository';
import { MemoryStore } from '../../src/storage/kv';

function makeRecord(
  id = 'yt_a',
  createdAt = 1000,
  overrides: Partial<SummaryRecord> = {},
): SummaryRecord {
  return {
    videoRecordId: id,
    videoTitle: 'Test video',
    videoUrl: `https://www.youtube.com/watch?v=${id.replace('yt_', '')}`,
    model: 'qwen2.5:1.5b',
    chunkCount: 2,
    segmentCount: 12,
    createdAt,
    durationMs: 600_000,
    overview: 'A clear overview of the video.',
    keyPoints: [
      { timestampMs: 1000, text: 'First point' },
      { timestampMs: 2000, text: 'Second point' },
    ],
    chapters: [{ startMs: 0, title: 'Intro', summary: 'The opening.' }],
    ...overrides,
  };
}

describe('SummaryRepository', () => {
  it('saves, indexes and reads a summary record', async () => {
    const kv = new MemoryStore();
    const repo = new SummaryRepository(kv);
    const saved = await repo.save(makeRecord('yt_a', 1000));

    expect(saved.videoRecordId).toBe('yt_a');
    expect(await kv.get(summaryRecordKey('yt_a'))).toMatchObject({
      videoTitle: 'Test video',
    });
    expect(await repo.get('yt_a')).toMatchObject({
      videoRecordId: 'yt_a',
      keyPoints: [
        { timestampMs: 1000, text: 'First point' },
        { timestampMs: 2000, text: 'Second point' },
      ],
    });

    const list = await repo.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      videoRecordId: 'yt_a',
      model: 'qwen2.5:1.5b',
      chunkCount: 2,
      keyPointCount: 2,
      chapterCount: 1,
      durationMs: 600_000,
    });
    expect('keyPoints' in (list[0] ?? {})).toBe(false);
  });

  it('trims the record id before persisting', async () => {
    const repo = new SummaryRepository(new MemoryStore());
    await repo.save(makeRecord('  yt_a  '));
    expect(await repo.get('yt_a')).toMatchObject({ videoRecordId: 'yt_a' });
    expect(await repo.get('  yt_a  ')).toBeUndefined();
  });

  it('truncates a long overview preview', async () => {
    const repo = new SummaryRepository(new MemoryStore());
    await repo.save(makeRecord('yt_a', 1000, { overview: 'x'.repeat(400) }));
    const [item] = await repo.list();
    expect(item?.overviewPreview).toHaveLength(221);
    expect(item?.overviewPreview.endsWith('…')).toBe(true);
  });

  it('replaces an existing summary instead of duplicating the index', async () => {
    const repo = new SummaryRepository(new MemoryStore());
    await repo.save(makeRecord('yt_a', 1000, { overview: 'Old' }));
    await repo.save(makeRecord('yt_a', 2000, { overview: 'New' }));
    const list = await repo.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.createdAt).toBe(2000);
    expect(list[0]?.overviewPreview).toBe('New');
    expect((await repo.get('yt_a'))?.overview).toBe('New');
  });

  it('lists newest summaries first', async () => {
    const repo = new SummaryRepository(new MemoryStore());
    await repo.save(makeRecord('yt_a', 1000));
    await repo.save(makeRecord('yt_b', 3000));
    await repo.save(makeRecord('yt_c', 2000));
    expect((await repo.list()).map((item) => item.videoRecordId)).toEqual([
      'yt_b',
      'yt_c',
      'yt_a',
    ]);
  });

  it('caps the index at 200 entries', async () => {
    const repo = new SummaryRepository(new MemoryStore());
    for (let index = 0; index < 205; index += 1) {
      await repo.save(makeRecord(`yt_${index}`, index));
    }
    const list = await repo.list();
    expect(list).toHaveLength(200);
    expect(list[0]?.videoRecordId).toBe('yt_204');
  });

  it('drops corrupt and duplicate index entries', async () => {
    const kv = new MemoryStore();
    const repo = new SummaryRepository(kv);
    await repo.save(makeRecord('yt_a', 1000));
    await kv.set(SUMMARIES_INDEX_KEY, [
      { corrupt: true },
      ...((await kv.get<unknown[]>(SUMMARIES_INDEX_KEY)) ?? []),
      makeRecord('yt_a', 1000, { chunkCount: undefined as never }),
    ]);
    const list = await repo.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.videoRecordId).toBe('yt_a');
  });

  it('returns undefined for a missing summary and throws for a corrupt one', async () => {
    const kv = new MemoryStore();
    const repo = new SummaryRepository(kv);
    expect(await repo.get('yt_missing')).toBeUndefined();
    await kv.set(summaryRecordKey('yt_bad'), { junk: true });
    await expect(repo.get('yt_bad')).rejects.toMatchObject({ code: 'STORAGE' });
  });

  it('removes a summary and its index entry', async () => {
    const repo = new SummaryRepository(new MemoryStore());
    await repo.save(makeRecord('yt_a', 1000));
    expect(await repo.remove('yt_a')).toBe(true);
    expect(await repo.get('yt_a')).toBeUndefined();
    expect(await repo.list()).toEqual([]);
    expect(await repo.remove('yt_a')).toBe(false);
  });

  it('removes an index-only entry even when the record is already gone', async () => {
    const kv = new MemoryStore();
    const repo = new SummaryRepository(kv);
    await repo.save(makeRecord('yt_a', 1000));
    await kv.remove(summaryRecordKey('yt_a'));
    expect(await repo.remove('yt_a')).toBe(true);
    expect(await repo.list()).toEqual([]);
  });

  it('refuses to store invalid records', async () => {
    const repo = new SummaryRepository(new MemoryStore());
    await expect(repo.save({} as SummaryRecord)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(
      repo.save(makeRecord('yt_a', 1000, { overview: '   ' })),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      repo.save(makeRecord('yt_a', 1000, { keyPoints: [] })),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      repo.save(makeRecord('yt_a', 1000, { chapters: [] })),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      repo.save(makeRecord('yt_a', 1000, { chunkCount: -1 })),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
