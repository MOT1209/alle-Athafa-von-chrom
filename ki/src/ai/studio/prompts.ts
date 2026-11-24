import type { ChatMessage } from '../types';

export const STORY_SYSTEM_PROMPT = `You write an original Arabic children's story (ages 5-9).
Rules:
- Original content only; never reuse or quote third-party stories.
- Simple, warm, age-appropriate vocabulary; short sentences.
- No scary, violent, sexual, or dark content; no death, weapons, or monsters.
- 4-8 short segments, each 1-3 sentences.
- Return ONE JSON object and nothing else:
{"title":"...","segments":[{"text":"...","emotion":"happy"}]}
- emotion is one of: happy, curious, calm, excited.
- Never add commentary or markdown.`;

export function buildStoryMessages(input: { concept: string; transcriptHint?: string }): ChatMessage[] {
  const hint = input.transcriptHint ? `\nContext (learned concepts): ${input.transcriptHint}\n` : '';
  return [
    { role: 'system', content: STORY_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Write an original Arabic children's story about: ${input.concept}${hint}\nReturn the JSON object now.`,
    },
  ];
}