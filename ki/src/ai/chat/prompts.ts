import type { ChatMessage } from '../types';
import { formatClock } from '../summary/time';
import type { RetrievedPassage } from './retrieval';

/**
 * Prompts for grounded question answering. The model only chooses passage
 * numbers; timestamps and quotes are resolved deterministically afterwards.
 * Answers stay in the language of the question.
 */

export const CHAT_SYSTEM_PROMPT = `You answer a question about one video using ONLY the numbered transcript passages.
Rules:
- Use ONLY the passages. Never use outside knowledge and never invent facts, names, numbers, or timestamps.
- If the passages do not contain the answer, set "found" to false and leave "answer" empty.
- If they do, write "answer" as 1-4 short sentences in the language of the question.
- "usedSources" lists the passage numbers that support the answer: 1 to 3 numbers.
- Return ONE JSON object and nothing else, with this exact shape:
{"found":true,"answer":"...","usedSources":[1]}
- Never write timestamps yourself and never add commentary or markdown.`;

export interface ChatHistoryTurn {
  role: 'user' | 'assistant';
  text: string;
}

export const MAX_HISTORY_TURN_CHARS = 240;

function passagesBlock(passages: RetrievedPassage[]): string {
  return passages
    .map(
      (passage, index) =>
        `[${index + 1}] ${formatClock(passage.startMs)}-${formatClock(passage.endMs)}\n${passage.text}`,
    )
    .join('\n\n');
}

function historyBlock(history: ChatHistoryTurn[]): string {
  return history
    .map((turn) => {
      const text =
        turn.text.length > MAX_HISTORY_TURN_CHARS
          ? `${turn.text.slice(0, MAX_HISTORY_TURN_CHARS).trimEnd()}…`
          : turn.text;
      return `${turn.role === 'user' ? 'You' : 'Assistant'}: ${text}`;
    })
    .join('\n');
}

export function buildChatMessages(input: {
  title: string;
  question: string;
  passages: RetrievedPassage[];
  history?: ChatHistoryTurn[];
}): ChatMessage[] {
  const sections = [
    `Video: "${input.title}"`,
    `Passages:\n${passagesBlock(input.passages)}`,
  ];
  if (input.history && input.history.length > 0) {
    sections.push(
      `Earlier turns (context only; answer from the passages, not from these):\n${historyBlock(input.history)}`,
    );
  }
  sections.push(`Question: ${input.question}`);
  sections.push('Return the JSON object now.');

  return [
    { role: 'system', content: CHAT_SYSTEM_PROMPT },
    { role: 'user', content: sections.join('\n\n') },
  ];
}
