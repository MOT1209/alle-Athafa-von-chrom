/**
 * LIVE YouTube extraction tests against the real site (network required).
 * Skipped by default; run with: npm run test:live
 *
 * Proves the extraction pipeline on real page data. Caption-body delivery is
 * subject to YouTube's POT protection outside a real player session; the test
 * reports honestly whether bodies were served instead of faking success.
 */
import { describe, expect, it } from 'vitest';
import {
  extractJsonAssignment,
  findTranscriptParams,
} from '../../src/youtube/extract';
import { readVideoInfo } from '../../src/youtube/capture';
import { parseJson3, parseTimedTextXml } from '../../src/youtube/transcript';

const live = process.env.VM_LIVE_YT === '1';
const UA = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};

describe.skipIf(!live)('YouTube LIVE extraction', () => {
  it('extracts real video metadata and caption tracks from a watch page', async () => {
    const res = await fetch('https://www.youtube.com/watch?v=jNQXAC9IVRw&hl=en', {
      headers: UA,
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    const video = readVideoInfo([html]);
    expect(video?.videoId).toBe('jNQXAC9IVRw');
    expect(video?.title).toBe('Me at the zoo');
    expect(video?.channel).toBe('jawed');
    expect(video?.durationMs).toBe(19000);
    expect((video?.captionTracks.length ?? 0)).toBeGreaterThan(0);
    console.log(
      `[live-yt] tracks: ${video?.captionTracks.map((t) => `${t.languageCode}(${t.kind})`).join(', ')}`,
    );

    const initialData = extractJsonAssignment([html], 'ytInitialData');
    const params = findTranscriptParams(initialData);
    console.log(`[live-yt] transcript params present: ${Boolean(params)}`);
  }, 60_000);

  it('reports caption-body delivery honestly (POT may block outside player)', async () => {
    const res = await fetch('https://www.youtube.com/watch?v=jNQXAC9IVRw&hl=en', {
      headers: UA,
    });
    const html = await res.text();
    const video = readVideoInfo([html]);
    const track = video?.captionTracks[0];
    expect(track).toBeDefined();
    if (!track) return;
    const url = new URL(track.baseUrl);
    url.searchParams.set('fmt', 'json3');
    const captionRes = await fetch(url.toString(), { headers: UA });
    const body = await captionRes.text();
    if (body.trim().length === 0) {
      console.log(
        '[live-yt] timedtext returned empty 200 (POT protection) — expected outside a real player session; the extension uses the player/UI layers there.',
      );
      expect(captionRes.status).toBe(200);
    } else {
      let segments = parseJson3(JSON.parse(body));
      if (segments.length === 0) segments = parseTimedTextXml(body);
      expect(segments.length).toBeGreaterThan(0);
      console.log(`[live-yt] real caption segments: ${segments.length}`);
    }
  }, 60_000);
});
