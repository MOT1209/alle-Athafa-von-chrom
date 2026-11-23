import { describe, expect, it } from 'vitest';
import { CaptureService, type PageRequest, type TabBridge } from '../../src/capture/service';
import { ConsentStore } from '../../src/capture/consent';
import { VideoRepository } from '../../src/capture/videos';
import { MemoryStore } from '../../src/storage/kv';
import { AppError } from '../../src/core/errors';

const video = {
  videoId: 'vid1',
  title: 'Test video',
  channel: 'Chan',
  durationMs: 60000,
  captionTracks: [
    { languageCode: 'en', label: 'English', kind: 'manual' as const, baseUrl: 'https://x/timedtext' },
  ],
};

const segments = [
  { startMs: 0, endMs: 2000, text: 'hello' },
  { startMs: 2000, endMs: 4000, text: 'world' },
];

function makeBridge(behavior: {
  activeTabId?: number;
  responses?: Partial<Record<PageRequest['type'], unknown>>;
  failWith?: Error;
} = {}): TabBridge & { calls: PageRequest[] } {
  const calls: PageRequest[] = [];
  return {
    calls,
    async getActiveTabId() {
      return behavior.activeTabId;
    },
    async sendToTab(_tabId, request) {
      calls.push(request);
      if (behavior.failWith) throw behavior.failWith;
      return behavior.responses?.[request.type];
    },
  };
}

function makeService(bridge: TabBridge) {
  const kv = new MemoryStore();
  const consent = new ConsentStore(kv);
  const videos = new VideoRepository(kv);
  const service = new CaptureService({ consent, videos, tabs: bridge, now: () => 5000 });
  return { service, consent, videos };
}

describe('CaptureService.activeVideo', () => {
  it('reports no-active-tab honestly', async () => {
    const { service } = makeService(makeBridge({ activeTabId: undefined }));
    expect(await service.activeVideo()).toEqual({ supported: false, reason: 'no-active-tab' });
  });

  it('reports not-a-youtube-video when the tab does not answer', async () => {
    const { service } = makeService(
      makeBridge({ activeTabId: 1, failWith: new AppError('PAGE_UNREACHABLE', 'no listener') }),
    );
    expect(await service.activeVideo()).toEqual({ supported: false, reason: 'not-a-youtube-video' });
  });

  it('returns the video info from the page', async () => {
    const { service } = makeService(
      makeBridge({ activeTabId: 7, responses: { 'page/videoInfo': { isVideoPage: true, video } } }),
    );
    const result = await service.activeVideo();
    expect(result.supported).toBe(true);
    if (result.supported) {
      expect(result.tabId).toBe(7);
      expect(result.video.videoId).toBe('vid1');
    }
  });

  it('rejects malformed page responses', async () => {
    const { service } = makeService(
      makeBridge({ activeTabId: 7, responses: { 'page/videoInfo': { isVideoPage: true, video: { bogus: 1 } } } }),
    );
    expect(await service.activeVideo()).toEqual({ supported: false, reason: 'not-a-youtube-video' });
  });
});

describe('CaptureService.capture — consent gate', () => {
  it('refuses to capture without consent (fail-closed, before page access)', async () => {
    const bridge = makeBridge({ activeTabId: 7 });
    const { service } = makeService(bridge);
    await expect(service.capture(7)).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' });
    expect(bridge.calls).toHaveLength(0);
  });

  it('captures after consent and stores a real record', async () => {
    const bridge = makeBridge({
      activeTabId: 7,
      responses: {
        'page/capture': { ok: true, via: 'api', segments, language: 'en', video },
      },
    });
    const { service, consent, videos } = makeService(bridge);
    await consent.grant('youtubeCaptions');
    const { record } = await service.capture(7);
    expect(record.id).toBe('yt_vid1');
    expect(record.segmentCount).toBe(2);
    expect(record.language).toBe('en');
    expect(record.capturedAt).toBe(5000);
    const stored = await videos.get('yt_vid1');
    expect(stored?.transcript.text).toBe('hello\nworld');
    expect(stored?.transcript.source).toBe('captions');
    expect(bridge.calls[0]?.type).toBe('page/capture');
  });

  it('passes preferred language to the page', async () => {
    const bridge = makeBridge({
      responses: { 'page/capture': { ok: true, via: 'direct', segments, video } },
    });
    const { service, consent } = makeService(bridge);
    await consent.grant('youtubeCaptions');
    await service.capture(7, 'ar');
    expect(bridge.calls[0]?.payload).toEqual({ preferredLanguage: 'ar' });
  });

  it('revoked consent blocks capture again', async () => {
    const bridge = makeBridge({
      responses: { 'page/capture': { ok: true, via: 'api', segments, video } },
    });
    const { service, consent } = makeService(bridge);
    await consent.grant('youtubeCaptions');
    await service.capture(7);
    await consent.revoke('youtubeCaptions');
    await expect(service.capture(7)).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' });
  });
});

describe('CaptureService.capture — honest failures', () => {
  it('maps no-captions to CAPTURE_UNAVAILABLE with the STT hint', async () => {
    const bridge = makeBridge({
      responses: { 'page/capture': { ok: false, reason: 'no-captions', video } },
    });
    const { service, consent } = makeService(bridge);
    await consent.grant('youtubeCaptions');
    await expect(service.capture(7)).rejects.toMatchObject({
      code: 'CAPTURE_UNAVAILABLE',
      hint: expect.stringContaining('Phase 7'),
    });
  });

  it('maps capture-failed to CAPTURE_UNAVAILABLE', async () => {
    const bridge = makeBridge({
      responses: { 'page/capture': { ok: false, reason: 'capture-failed' } },
    });
    const { service, consent } = makeService(bridge);
    await consent.grant('youtubeCaptions');
    await expect(service.capture(7)).rejects.toMatchObject({ code: 'CAPTURE_UNAVAILABLE' });
  });

  it('rejects malformed successful responses', async () => {
    const bridge = makeBridge({
      responses: { 'page/capture': { ok: true, segments: [], video } },
    });
    const { service, consent } = makeService(bridge);
    await consent.grant('youtubeCaptions');
    await expect(service.capture(7)).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });

  it('filters invalid segments instead of storing them', async () => {
    const bridge = makeBridge({
      responses: {
        'page/capture': {
          ok: true,
          via: 'ui',
          segments: [...segments, { startMs: 'x', endMs: 1, text: '' }, null],
          video,
        },
      },
    });
    const { service, consent, videos } = makeService(bridge);
    await consent.grant('youtubeCaptions');
    const { record } = await service.capture(7);
    expect(record.segmentCount).toBe(2);
    expect((await videos.get('yt_vid1'))?.transcript.segments).toHaveLength(2);
  });

  it('validates tabId', async () => {
    const { service, consent } = makeService(makeBridge());
    await consent.grant('youtubeCaptions');
    await expect(service.capture(Number.NaN)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('wraps page transport failures as PAGE_UNREACHABLE', async () => {
    const bridge = makeBridge({ failWith: new Error('Receiving end does not exist') });
    const { service, consent } = makeService(bridge);
    await consent.grant('youtubeCaptions');
    await expect(service.capture(7)).rejects.toMatchObject({ code: 'PAGE_UNREACHABLE' });
  });
});
