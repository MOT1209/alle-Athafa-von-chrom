import { describe, expect, it, vi } from 'vitest';
import { runCapture, type CaptureDeps, type TranscriptPanelDom } from '../../src/youtube/capture';

const video = {
  videoDetails: { videoId: 'vid1', title: 'Title', author: 'Chan', lengthSeconds: '60' },
  captions: {
    playerCaptionsTracklistRenderer: {
      captionTracks: [
        { baseUrl: 'https://www.youtube.com/api/timedtext?v=vid1&lang=en', languageCode: 'en', name: { simpleText: 'English' } },
      ],
    },
  },
};

const transcriptParamsData = {
  engagementPanels: [
    {
      engagementPanelSectionListRenderer: {
        content: {
          continuationItemRenderer: {
            continuationEndpoint: { getTranscriptEndpoint: { params: 'TOKEN' } },
          },
        },
      },
    },
  ],
};

const cfgScript =
  'ytcfg.set({"INNERTUBE_API_KEY":"KEY123","INNERTUBE_CLIENT_VERSION":"2.20261119.07.00","VISITOR_DATA":"VD"});';

function makeScripts(withParams = true): string[] {
  return [
    `var ytInitialPlayerResponse = ${JSON.stringify(video)};`,
    ...(withParams ? [`var ytInitialData = ${JSON.stringify(transcriptParamsData)};`] : []),
    cfgScript,
  ];
}

function apiResponse(segments: unknown[]): Response {
  return new Response(
    JSON.stringify({
      actions: [
        {
          updateEngagementPanelAction: {
            content: {
              transcriptRenderer: {
                body: { transcriptBodyRenderer: { initialSegments: segments } },
              },
            },
          },
        },
      ],
    }),
    { status: 200 },
  );
}

const innerTubeSegments = [
  { transcriptSegmentRenderer: { startMs: '0', endMs: '2000', snippet: { runs: [{ text: 'hello' }] } } },
  { transcriptSegmentRenderer: { startMs: '2000', endMs: '4000', snippet: { runs: [{ text: 'world' }] } } },
];

function makePanel(overrides: Partial<TranscriptPanelDom> = {}): TranscriptPanelDom {
  return {
    expandDescription: vi.fn(),
    clickTranscriptButton: vi.fn(() => true),
    readRenderedSegments: vi.fn(() => []),
    ...overrides,
  };
}

function makeDeps(overrides: {
  fetchImpl?: typeof fetch;
  panel?: TranscriptPanelDom;
  scripts?: string[];
} = {}): CaptureDeps {
  return {
    scriptTexts: overrides.scripts ?? makeScripts(),
    fetchImpl: overrides.fetchImpl ?? (async () => new Response('', { status: 200 })),
    panel: overrides.panel ?? makePanel(),
    wait: async () => {},
  };
}

describe('runCapture — API layer', () => {
  it('uses get_transcript when params + key exist', async () => {
    const calls: Array<{ url: string; body?: unknown }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return apiResponse(innerTubeSegments);
    }) as unknown as typeof fetch;
    const outcome = await runCapture(makeDeps({ fetchImpl }));
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.via).toBe('api');
      expect(outcome.segments).toHaveLength(2);
      expect(outcome.video.videoId).toBe('vid1');
    }
    expect(calls[0]?.url).toContain('/youtubei/v1/get_transcript?key=KEY123');
    const body = calls[0]?.body as Record<string, unknown>;
    expect(body.params).toBe('TOKEN');
    expect((body.context as Record<string, unknown>).client).toMatchObject({
      clientName: 'WEB',
      visitorData: 'VD',
    });
  });

  it('falls through when the API returns 400', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('get_transcript')) return new Response('{}', { status: 400 });
      return new Response(JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'direct' }] }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const outcome = await runCapture(makeDeps({ fetchImpl }));
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.via).toBe('direct');
      expect(outcome.language).toBe('en');
    }
  });
});

describe('runCapture — direct layer', () => {
  it('parses json3 from the caption track URL', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ events: [{ tStartMs: 100, dDurationMs: 900, segs: [{ utf8: 'hi' }] }] }), { status: 200 }),
    ) as unknown as typeof fetch;
    const outcome = await runCapture(makeDeps({ scripts: makeScripts(false), fetchImpl }));
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.via).toBe('direct');
      expect(outcome.segments[0]?.text).toBe('hi');
    }
  });

  it('falls back to XML when the body is not JSON', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('<transcript><text start="0.1" dur="0.9">xml text</text></transcript>', { status: 200 }),
    ) as unknown as typeof fetch;
    const outcome = await runCapture(makeDeps({ scripts: makeScripts(false), fetchImpl }));
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.segments[0]?.text).toBe('xml text');
  });

  it('treats empty 200 (POT block) as failure and tries the UI layer', async () => {
    const panel = makePanel({
      readRenderedSegments: vi.fn(() => [{ startMs: 0, endMs: 0, text: 'from panel' }]),
    });
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch;
    const outcome = await runCapture(makeDeps({ scripts: makeScripts(false), fetchImpl, panel }));
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.via).toBe('ui');
      expect(outcome.segments[0]?.text).toBe('from panel');
      expect(outcome.segments[0]?.endMs).toBe(3000);
    }
    expect(panel.expandDescription).toHaveBeenCalled();
    expect(panel.clickTranscriptButton).toHaveBeenCalled();
  });
});

describe('runCapture — honest failures', () => {
  it('reports not-a-video without player data', async () => {
    const outcome = await runCapture(makeDeps({ scripts: ['var x = 1;'] }));
    expect(outcome).toEqual({ ok: false, reason: 'not-a-video' });
  });

  it('reports no-captions when the video has no tracks', async () => {
    const noCaptions = { videoDetails: { videoId: 'v', title: 'T' } };
    const outcome = await runCapture(
      makeDeps({ scripts: [`var ytInitialPlayerResponse = ${JSON.stringify(noCaptions)};`] }),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('no-captions');
  });

  it('reports capture-failed when every layer fails', async () => {
    const panel = makePanel({ clickTranscriptButton: vi.fn(() => false) });
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch;
    const outcome = await runCapture(makeDeps({ scripts: makeScripts(false), fetchImpl, panel }));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('capture-failed');
  });

  it('never throws when fetch rejects', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('network down');
    }) as unknown as typeof fetch;
    const outcome = await runCapture(makeDeps({ fetchImpl }));
    expect(outcome.ok).toBe(false);
  });
});
