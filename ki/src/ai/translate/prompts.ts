import type { ChatMessage } from '../types';
import type { TranscriptSegment } from '../types';

export const TRANSLATION_SYSTEM_PROMPT = `You translate video transcript segments from one language into another.
Rules:
- Translate every supplied segment into the target language.
- Keep the meaning, tone and names faithful; do not summarize, add or drop content.
- Preserve numbers, proper nouns, and any code-like tokens.
- Return ONE JSON object and nothing else, with this exact shape:
{"segments":[{"key":"0","text":"translated text"}]}
- "key" must be copied verbatim from the input segment keys.
- Translate each segment independently; timestamps are not part of the output.
- Never add commentary, markdown, or extra keys.`;

export function buildTranslationMessages(input: {
  sourceLanguage?: string;
  targetLanguage: string;
  segments: Array<{ key: string; segment: TranscriptSegment }>;
}): ChatMessage[] {
  const source =
    input.sourceLanguage && input.sourceLanguage.trim().length > 0
      ? input.sourceLanguage
      : 'the source language of the transcript';
  const lines = input.segments
    .map(({ key, segment }) => `${key}: ${segment.text}`)
    .join('\n');
  return [
    { role: 'system', content: TRANSLATION_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Translate the following segments from ${source} to ${input.targetLanguage}.

Segments (key: text):
${lines}

Return the JSON object now.`,
    },
  ];
}