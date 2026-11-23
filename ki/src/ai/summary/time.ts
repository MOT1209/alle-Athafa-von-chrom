/**
 * Timestamp helpers for summarization. Models are asked for milliseconds, but
 * small models often answer with clock strings ("12:34"), so parsing accepts
 * both and normalizes to milliseconds. Nothing is guessed: unparseable or
 * ambiguous values are rejected by the schema.
 */

const MM_SS = /^(\d{1,4}):([0-5]\d)$/;
const H_MM_SS = /^(\d{1,3}):([0-5]\d):([0-5]\d)$/;
const MILLIS = /^(\d+(?:\.\d+)?)\s*ms$/i;
const SECONDS = /^(\d+(?:\.\d+)?)\s*s$/i;
const BARE_NUMBER = /^\d+(?:\.\d+)?$/;

/** Format milliseconds as `m:ss` or `h:mm:ss` for prompt labels and UI. */
export function formatClock(ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const totalSeconds = Math.floor(safe / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const ss = String(seconds).padStart(2, '0');
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${ss}`;
  }
  return `${minutes}:${ss}`;
}

/**
 * Parse a model-provided timestamp into milliseconds.
 * Accepted: finite non-negative number (ms), "754000" (ms), "12:34",
 * "1:02:03", "750 ms", "12.5 s". Returns undefined when the value cannot be
 * interpreted confidently.
 */
export function parseTimestampMs(value: unknown): number | undefined {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return undefined;
    return Math.round(value);
  }
  if (typeof value !== 'string') return undefined;
  const raw = value.trim();
  if (raw.length === 0) return undefined;

  const hms = H_MM_SS.exec(raw);
  if (hms) {
    const hours = Number(hms[1]);
    const minutes = Number(hms[2]);
    const seconds = Number(hms[3]);
    return (hours * 3600 + minutes * 60 + seconds) * 1000;
  }

  const mss = MM_SS.exec(raw);
  if (mss) {
    const minutes = Number(mss[1]);
    const seconds = Number(mss[2]);
    return (minutes * 60 + seconds) * 1000;
  }

  const millis = MILLIS.exec(raw);
  if (millis) return Math.round(Number(millis[1]));

  const seconds = SECONDS.exec(raw);
  if (seconds) return Math.round(Number(seconds[1]) * 1000);

  if (BARE_NUMBER.test(raw)) return Math.round(Number(raw));
  return undefined;
}
