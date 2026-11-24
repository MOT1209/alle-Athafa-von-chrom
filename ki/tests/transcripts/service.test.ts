import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../../src/storage/kv';
import { VideoRepository, videoIdFor } from '../../src/capture/videos';
import { TranscriptService } from '../../src/transcripts/service';
import { segmentsToTranscript } from '../../src/youtube/transcript';

async function makeRepo() {
  const kv = new MemoryStore();
  const repo = new VideoRepository(kv);
  await repo.save(
    {
      id: videoIdFor('a'),
      platform: 'youtube',
      videoId: 'a',
      url: 'https://www.youtube.com/watch?v=a',
      title: 'Video a',
      segmentCount: 2,
      capturedAt: 0,
      transcript: segmentsToTranscript(
        [
          { startMs: 0, endMs: 1000, text: 'hello world' },
          { startMs: 1000, endMs: 2000, text: 'foo bar' },
        ],
        'en',
      ),
    },
    0,
  );
  return { kv, repo };
}

describe('transcripts/service', () => {
  it('updates a segment and persists', async () => {
    const { repo } = await makeRepo();
    const service = new TranscriptService({ videos: repo });
    const result = await service.updateSegment('yt_a', 0, 'HELLO WORLD');
    expect(result.changed).toBe(true);
    expect(result.record.transcript.segments[0]?.text).toBe('HELLO WORLD');
    const reloaded = await repo.get('yt_a');
    expect(reloaded?.transcript.segments[0]?.text).toBe('HELLO WORLD');
    expect(reloaded?.editedAt).toBeDefined();
  });

  it('returns unchanged when text identical', async () => {
    const { repo } = await makeRepo();
    const service = new TranscriptService({ videos: repo });
    const result = await service.updateSegment('yt_a', 0, 'hello world');
    expect(result.changed).toBe(false);
  });

  it('rejects invalid segment text', async () => {
    const { repo } = await makeRepo();
    const service = new TranscriptService({ videos: repo });
    await expect(service.updateSegment('yt_a', 0, '   ')).rejects.toThrow();
  });

  it('searches across stored transcripts', async () => {
    const { repo } = await makeRepo();
    const service = new TranscriptService({ videos: repo });
    const hits = await service.search('hello');
    expect(hits.length).toBe(1);
    expect(hits[0]?.videoRecordId).toBe('yt_a');
  });

  it('get returns record', async () => {
    const { repo } = await makeRepo();
    const service = new TranscriptService({ videos: repo });
    const record = await service.get('yt_a');
    expect(record?.id).toBe('yt_a');
  });

  it('throws on missing video', async () => {
    const { repo } = await makeRepo();
    const service = new TranscriptService({ videos: repo });
    await expect(service.updateSegment('yt_missing', 0, 'x')).rejects.toThrow();
  });
});