import { AppError } from '../../core/errors';
import type { GenerationOptions, LlmProvider } from '../types';
import { ensureNotAborted } from '../summary/summarizer';
import { parseKidsStory, type KidsStory } from './schema';
import { buildStoryMessages } from './prompts';
import { checkSafety } from './safety';

export const STORY_CALL_TIMEOUT_MS = 900_000;

export interface StoryInput { concept: string; transcriptHint?: string; }
export interface StoryOptions {
  provider: LlmProvider;
  model: string;
  numCtx: number;
  numPredict: number;
  temperature: number;
  keepAlive?: string;
  signal?: AbortSignal;
}

export async function generateStory(input: StoryInput, options: StoryOptions): Promise<KidsStory> {
  if (!options.model) throw new AppError('INVALID_INPUT', 'A model is required');
  const messages = buildStoryMessages(input);
  const generation: GenerationOptions = {
    model: options.model,
    numCtx: options.numCtx,
    numPredict: Math.max(256, options.numPredict),
    temperature: options.temperature,
    format: 'json',
    timeoutMs: STORY_CALL_TIMEOUT_MS,
  };
  if (options.keepAlive !== undefined) generation.keepAlive = options.keepAlive;
  if (options.signal !== undefined) generation.signal = options.signal;

  let lastError: AppError | undefined;
  for (let attempt = 1; attempt <= 2; attempt++) {
    ensureNotAborted(options.signal);
    let content: string;
    try {
      const result = await options.provider.chat(messages, generation);
      content = result.content;
    } catch (err) {
      const ae = AppError.wrap(err);
      if (ae.code !== 'BAD_RESPONSE') throw ae;
      lastError = ae;
      continue;
    }
    try {
      const story = parseKidsStory(content);
      const fullText = `${story.title}\n${story.segments.map((s) => s.text).join(' ')}`;
      const safety = checkSafety(fullText);
      if (!safety.safe) {
        throw new AppError('BAD_RESPONSE', `Unsafe content: ${safety.reasons.join(', ')}`);
      }
      return story;
    } catch (err) {
      const ae = AppError.wrap(err);
      if (ae.code !== 'BAD_RESPONSE') throw ae;
      lastError = ae;
    }
  }
  throw (lastError ?? new AppError('BAD_RESPONSE', 'The model did not produce a safe story'));
}