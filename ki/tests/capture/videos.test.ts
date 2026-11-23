import { describe, expect, it } from 'vitest';
import {
  VIDEOS_INDEX_KEY,
  VideoRepository,
  videoIdFor,
  videoRecordKey,
  type VideoRecord,
} from '../../src/capture/videos';
import { MemoryStore } from '../../src/storage/kv';
import { segmentsToTranscript } from '../../src/youtube/transcript';

function makeRecord(videoId: string, title = 'Title'): VideoRecord {
  return {
    id: videoIdFor(videoId),
    platform: 'youtube',
    videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    title,
    channel: 'Chan',
    durationMs: 60000,
    language: 'en',
    segmentCount: 2,
    capturedAt: 0,
    transcript: segmentsToTranscript(
      [
        { startMs: 0, endMs: 2000, text: 'first' },
        { startMs: 2000, endMs: 4000, text: 'second' },
      ],
      'en',
    ),
  };
}

describe('VideoRepository', () => {
  it('saves a record and indexes its summary (newest first)', async () => {
    const kv = new MemoryStore();
    const repo = new VideoRepository(kv);
    const summary = await repo.save(makeRecord('a'), 1000);
    expect(summary.capturedAt).toBe(1000);
    expect(summary.segmentCount).toBe(2);
    expect(await kv.get(videoRecordKey('yt_a'))).toMatchObject({ videoId: 'a' });
    const list = await repo.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.title).toBe('Title');
    expect('transcript' in (list[0] ?? {})).toBe(false);
  });

  it('re-capturing the same video replaces, not duplicates', async () => {
    const repo = new VideoRepository(new MemoryStore());
    await repo.save(makeRecord('a', 'Old'), 1000);
    await repo.save(makeRecord('a', 'New'), 2000);
    const list = await repo.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.title).toBe('New');
    expect((await repo.get('yt_a'))?.title).toBe('New');
  });

  it('get returns undefined for missing and throws for corrupt', async () => {
    const kv = new MemoryStore();
    const repo = new VideoRepository(kv);
    expect(await repo.get('yt_missing')).toBeUndefined();
    await kv.set(videoRecordKey('yt_bad'), { junk: true });
    await expect(repo.get('yt_bad')).rejects.toMatchObject({ code: 'STORAGE' });
  });

  it('list drops corrupt index entries (fail-safe display)', async () => {
    const kv = new MemoryStore();
    const repo = new VideoRepository(kv);
    await repo.save(makeRecord('a'), 1000);
    const index = (await kv.get<unknown[]>(VIDEOS_INDEX_KEY)) ?? [];
    await kv.set(VIDEOS_INDEX_KEY, [...index, { corrupt: true }, null]);
    const list = await repo.list();
    expect(list).toHaveLength(1);
  });

  it('remove deletes record and index entry', async () => {
    const repo = new VideoRepository(new MemoryStore());
    await repo.save(makeRecord('a'), 1000);
    expect(await repo.remove('yt_a')).toBe(true);
    expect(await repo.get('yt_a')).toBeUndefined();
    expect(await repo.list()).toEqual([]);
    expect(await repo.remove('yt_a')).toBe(false);
  });

  it('rejects invalid records', async () => {
    const repo = new VideoRepository(new MemoryStore());
    await expect(repo.save({} as VideoRecord)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('caps the index at 200 entries', async () => {
    const repo = new VideoRepository(new MemoryStore());
    for (let i = 0; i < 205; i++) {
      await repo.save(makeRecord(`v${i}`), i);
    }
    const list = await repo.list();
    expect(list).toHaveLength(200);
    expect(list[0]?.videoId).toBe('v204');
  });
});
