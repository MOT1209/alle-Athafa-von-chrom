import type { ChatMessage } from '../types';
import type { TranscriptChunk } from './chunking';
import type { TranscriptNotes } from './schema';
import { formatClock } from './time';

/**
 * Prompts for map-reduce summarization. They are deliberately strict about
 * JSON shape and timestamps because the output is schema-validated and then
 * shown to the user as fact. Output stays in the transcript's language, so a
 * summary never silently becomes a translation.
 */

export const MAP_SYSTEM_PROMPT = `You summarize one part of a video transcript.
Rules:
- Use ONLY information stated in this transcript part. Never invent facts, names, numbers, or timestamps.
- Write in the main language of the transcript.
- Return ONE JSON object and nothing else, with this exact shape:
{"summary":"2-5 factual sentences","keyPoints":[{"timestampMs":123000,"text":"one short factual point"}]}
- timestampMs is absolute video time in milliseconds, taken from the [m:ss] labels.
- Give 1-6 key points, in chronological order. Never add commentary or markdown.`;

export const MERGE_SYSTEM_PROMPT = `You merge overlapping notes from one video into a shorter note.
Rules:
- Use ONLY the supplied notes. Never invent facts, names, numbers, or timestamps.
- Keep the most important points and merge duplicates; preserve exact timestampMs values.
- Write in the main language of the notes.
- Return ONE JSON object and nothing else, with this exact shape:
{"summary":"2-5 factual sentences","keyPoints":[{"timestampMs":123000,"text":"one short factual point"}]}
- Give 1-8 key points, in chronological order. Never add commentary or markdown.`;

export const FINAL_SYSTEM_PROMPT = `You write the final structured summary of a video from verified notes.
Rules:
- Use ONLY the supplied notes. Never invent facts, names, numbers, or timestamps.
- Write in the main language of the notes.
- overview: 3-6 factual sentences describing the whole video.
- keyPoints: 5-12 points in chronological order, each with an absolute timestampMs copied from the notes.
- chapters: 3-8 chapters in chronological order; each has startMs, a short title, and a 1-2 sentence summary.
- Return ONE JSON object and nothing else, with this exact shape:
{"overview":"...","keyPoints":[{"timestampMs":0,"text":"..."}],"chapters":[{"startMs":0,"title":"...","summary":"..."}]}
- Never add commentary, markdown, or extra keys.`;

function transcriptLines(chunk: TranscriptChunk): string {
  return chunk.segments
    .map((segment) => `[${formatClock(segment.startMs)}] ${segment.text}`)
    .join('\n');
}

export function buildMapMessages(input: {
  title: string;
  chunk: TranscriptChunk;
  totalChunks: number;
}): ChatMessage[] {
  const { chunk } = input;
  const range = `${formatClock(chunk.startMs)}-${formatClock(chunk.endMs)}`;
  return [
    { role: 'system', content: MAP_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Video: "${input.title}"
Transcript part ${chunk.index + 1}/${input.totalChunks} (${range}).

${transcriptLines(chunk)}

Return the JSON object now.`,
    },
  ];
}

function notesBlock(notes: TranscriptNotes[]): string {
  return notes
    .map((note, index) => {
      const points = note.keyPoints
        .map(
          (point) =>
            `- [${point.timestampMs} ms | ${formatClock(point.timestampMs)}] ${point.text}`,
        )
        .join('\n');
      return `Note ${index + 1}: ${note.summary}${points ? `\n${points}` : ''}`;
    })
    .join('\n\n');
}

export function buildMergeMessages(input: {
  title: string;
  notes: TranscriptNotes[];
  round: number;
  totalRounds: number;
}): ChatMessage[] {
  return [
    { role: 'system', content: MERGE_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Video: "${input.title}"
Merge round ${input.round}/${input.totalRounds}.

${notesBlock(input.notes)}

Return the JSON object now.`,
    },
  ];
}

export function buildFinalMessages(input: {
  title: string;
  durationMs?: number;
  notes: TranscriptNotes[];
}): ChatMessage[] {
  const duration =
    input.durationMs !== undefined && Number.isFinite(input.durationMs)
      ? `\nDuration: ${formatClock(input.durationMs)}.`
      : '';
  return [
    { role: 'system', content: FINAL_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Video: "${input.title}"${duration}

Verified notes:
${notesBlock(input.notes)}

Return the final JSON object now.`,
    },
  ];
}
