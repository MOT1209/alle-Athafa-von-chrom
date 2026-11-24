import { describe, expect, it } from 'vitest';
import { WhisperProvider } from '../../src/ai/stt/whisper';

describe('ai/stt/whisper', () => {
  it('reports unavailable when server is unreachable', async () => {
    const provider = new WhisperProvider({ baseUrl: 'http://127.0.0.1:59999', requestTimeoutMs: 2000 });
    const health = await provider.health();
    expect(health.ok).toBe(false);
  });

  it('transcribe throws a typed error when server is unreachable', async () => {
    const provider = new WhisperProvider({ baseUrl: 'http://127.0.0.1:59999', requestTimeoutMs: 2000 });
    const blob = new Blob(['x'], { type: 'audio/wav' });
    await expect(provider.transcribe(blob)).rejects.toMatchObject({ code: 'CAPTURE_UNAVAILABLE' });
  });
});