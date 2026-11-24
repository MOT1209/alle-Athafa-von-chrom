import type { ChatMessage } from '../types';

export const LEARNING_SYSTEM_PROMPT = `You generate study material from a video transcript.
Rules:
- Use ONLY information stated in the transcript/summary. Never invent facts, names, numbers, or timestamps.
- Write in the main language of the transcript.
- Flashcards: front is a concise question or prompt; back is a short factual answer.
- Quizzes: "mcq" has 2-4 options with one correct answer matching "answer" exactly; "open" has a short expected answer.
- timestampMs (optional) is an absolute video time in milliseconds taken from the [m:ss] labels. Only include it when the fact appears at that moment; otherwise omit the field. Never invent a timestamp.
- Return ONE JSON object and nothing else, with this exact shape:
{"flashcards":[{"front":"...","back":"...","timestampMs":1500}],"quizzes":[{"type":"mcq","question":"...","options":["a","b"],"answer":"a","explanation":"...","timestampMs":1500}]}
- Never add commentary, markdown, or extra keys.`;

export function buildLearningMessages(input: {
  title: string;
  transcriptText: string;
  summaryText?: string;
}): ChatMessage[] {
  const summary = input.summaryText && input.summaryText.trim().length > 0
    ? `\nSummary:\n${input.summaryText.trim()}\n`
    : '';
  return [
    { role: 'system', content: LEARNING_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Video: "${input.title}"${summary}

Transcript:
${input.transcriptText}

Return the JSON object now.`,
    },
  ];
}