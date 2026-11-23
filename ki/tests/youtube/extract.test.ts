import { describe, expect, it } from 'vitest';
import {
  extractCfgString,
  extractJsonAssignment,
  findTranscriptParams,
  parseVideoInfo,
  selectBestTrack,
  sliceJsonObject,
} from '../../src/youtube/extract';

describe('sliceJsonObject', () => {
  it('slices a balanced object', () => {
    const text = 'var x = {"a":1,"b":{"c":2}}; trailing';
    expect(sliceJsonObject(text, text.indexOf('{'))).toBe('{"a":1,"b":{"c":2}}');
  });

  it('respects braces inside strings and escapes', () => {
    const text = '{"s":"} not the end \\" {","n":1}';
    expect(sliceJsonObject(text, 0)).toBe(text);
  });

  it('returns undefined for unbalanced or non-object starts', () => {
    expect(sliceJsonObject('{"a":1', 0)).toBeUndefined();
    expect(sliceJsonObject('abc', 0)).toBeUndefined();
  });
});

describe('extractJsonAssignment', () => {
  const playerResponse = {
    videoDetails: { videoId: 'abc123', title: 'Test', author: 'Chan', lengthSeconds: '19' },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [
          { baseUrl: 'https://www.youtube.com/api/timedtext?v=abc123&lang=en', languageCode: 'en', name: { simpleText: 'English' } },
          { baseUrl: 'https://www.youtube.com/api/timedtext?v=abc123&lang=ar&kind=asr', languageCode: 'ar', kind: 'asr', name: { runs: [{ text: 'Arabic (auto)' }] } },
        ],
      },
    },
  };

  it('extracts ytInitialPlayerResponse from script text', () => {
    const scripts = [
      'var unrelated = 1;',
      `var ytInitialPlayerResponse = ${JSON.stringify(playerResponse)};var meta=1;`,
    ];
    const result = extractJsonAssignment(scripts, 'ytInitialPlayerResponse');
    expect(result).toEqual(playerResponse);
  });

  it('keeps searching when validation rejects a candidate', () => {
    const scripts = [
      'ytInitialPlayerResponse = {"decoy":true};',
      `ytInitialPlayerResponse = ${JSON.stringify(playerResponse)};`,
    ];
    const result = extractJsonAssignment(
      scripts,
      'ytInitialPlayerResponse',
      (value) => 'videoDetails' in value,
    );
    expect(result).toEqual(playerResponse);
  });

  it('returns undefined for missing or malformed markers', () => {
    expect(extractJsonAssignment(['nothing here'], 'ytInitialPlayerResponse')).toBeUndefined();
    expect(extractJsonAssignment(['ytInitialPlayerResponse = {broken;'], 'ytInitialPlayerResponse')).toBeUndefined();
  });
});

describe('extractCfgString', () => {
  it('finds flat config values', () => {
    const scripts = ['ytcfg.set({"INNERTUBE_API_KEY":"AIzaSyTEST","INNERTUBE_CLIENT_VERSION":"2.20261119.07.00"});'];
    expect(extractCfgString(scripts, 'INNERTUBE_API_KEY')).toBe('AIzaSyTEST');
    expect(extractCfgString(scripts, 'INNERTUBE_CLIENT_VERSION')).toBe('2.20261119.07.00');
    expect(extractCfgString(scripts, 'MISSING')).toBeUndefined();
  });
});

describe('parseVideoInfo / parseCaptionTracks', () => {
  const pr = {
    videoDetails: { videoId: 'jNQXAC9IVRw', title: 'Me at the zoo', author: 'jawed', lengthSeconds: '19' },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [
          { baseUrl: 'https://x/timedtext?lang=en', languageCode: 'en', name: { simpleText: 'English' } },
          { baseUrl: 'https://x/timedtext?lang=ar&kind=asr', languageCode: 'ar', kind: 'asr', name: { runs: [{ text: 'Arabic (auto-generated)' }] } },
          { languageCode: 'xx' },
          null,
        ],
      },
    },
  };

  it('parses metadata and tracks, skipping malformed entries', () => {
    const info = parseVideoInfo(pr);
    expect(info?.videoId).toBe('jNQXAC9IVRw');
    expect(info?.title).toBe('Me at the zoo');
    expect(info?.channel).toBe('jawed');
    expect(info?.durationMs).toBe(19000);
    expect(info?.captionTracks).toHaveLength(2);
    expect(info?.captionTracks[0]).toMatchObject({ languageCode: 'en', kind: 'manual', label: 'English' });
    expect(info?.captionTracks[1]).toMatchObject({ languageCode: 'ar', kind: 'asr', label: 'Arabic (auto-generated)' });
  });

  it('returns undefined without videoDetails.videoId', () => {
    expect(parseVideoInfo({})).toBeUndefined();
    expect(parseVideoInfo({ videoDetails: {} })).toBeUndefined();
  });

  it('handles videos without captions', () => {
    const info = parseVideoInfo({ videoDetails: { videoId: 'x', title: 'T' } });
    expect(info?.captionTracks).toEqual([]);
  });
});

describe('selectBestTrack', () => {
  const tracks = [
    { languageCode: 'ar', label: 'Arabic (auto)', kind: 'asr' as const, baseUrl: 'u1' },
    { languageCode: 'en', label: 'English', kind: 'manual' as const, baseUrl: 'u2' },
    { languageCode: 'de', label: 'German', kind: 'manual' as const, baseUrl: 'u3' },
  ];

  it('prefers manual over asr', () => {
    expect(selectBestTrack(tracks)?.languageCode).toBe('en');
  });

  it('honors preferred language among manual tracks', () => {
    expect(selectBestTrack(tracks, 'de')?.languageCode).toBe('de');
  });

  it('matches language prefixes', () => {
    const withRegion = [...tracks, { languageCode: 'ar-EG', label: 'Arabic (Egypt)', kind: 'manual' as const, baseUrl: 'u4' }];
    expect(selectBestTrack(withRegion, 'ar')?.languageCode).toBe('ar-EG');
  });

  it('falls back to asr when no manual exists', () => {
    expect(selectBestTrack([tracks[0]!])?.languageCode).toBe('ar');
  });

  it('returns undefined for empty lists', () => {
    expect(selectBestTrack([])).toBeUndefined();
  });
});

describe('findTranscriptParams', () => {
  it('finds params nested under continuationItemRenderer', () => {
    const data = {
      engagementPanels: [
        {},
        {
          engagementPanelSectionListRenderer: {
            content: {
              continuationItemRenderer: {
                continuationEndpoint: { getTranscriptEndpoint: { params: 'PARAMS_TOKEN' } },
              },
            },
          },
        },
      ],
    };
    expect(findTranscriptParams(data)).toBe('PARAMS_TOKEN');
  });

  it('returns undefined when absent or data missing', () => {
    expect(findTranscriptParams({ a: { b: 1 } })).toBeUndefined();
    expect(findTranscriptParams(undefined)).toBeUndefined();
  });

  it('handles cyclic structures safely', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(findTranscriptParams(cyclic)).toBeUndefined();
  });
});
