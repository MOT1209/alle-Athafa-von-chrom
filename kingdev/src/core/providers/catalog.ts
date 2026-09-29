/**
 * Provider catalogue (plan Phase 3).
 *
 * Static descriptors of every provider KingDev can talk to. Kept as data, not
 * code: the settings UI renders this verbatim, and the client dispatches on
 * `protocol` — adding a provider means adding an entry, not a code path.
 *
 * `defaultBaseUrl` for local Ollama is the user's own machine; nothing here
 * phones home. Keys live only in chrome.storage.local (key-vault.ts) and are
 * never included in diagnostics output.
 */

import type { ModelSpec, ProviderDescriptor, ProviderId } from '@/core/types';

export const PROVIDERS: readonly ProviderDescriptor[] = [
  {
    id: 'openai',
    displayName: 'OpenAI',
    protocol: 'openai',
    defaultBaseUrl: 'https://api.openai.com/v1',
    keyRequired: true,
    supportsStreaming: true,
    local: false,
    docsUrl: 'https://platform.openai.com/docs/api-reference/chat',
  },
  {
    id: 'anthropic',
    displayName: 'Anthropic',
    protocol: 'anthropic',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    keyRequired: true,
    supportsStreaming: true,
    local: false,
    docsUrl: 'https://docs.anthropic.com/en/api/messages',
  },
  {
    id: 'google',
    displayName: 'Google AI',
    protocol: 'google',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    keyRequired: true,
    supportsStreaming: true,
    local: false,
    docsUrl: 'https://ai.google.dev/gemini-api/docs',
  },
  {
    id: 'openrouter',
    displayName: 'OpenRouter',
    protocol: 'openai',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    keyRequired: true,
    supportsStreaming: true,
    local: false,
    docsUrl: 'https://openrouter.ai/docs',
  },
  {
    id: 'ollama',
    displayName: 'Ollama (local)',
    protocol: 'ollama',
    defaultBaseUrl: 'http://localhost:11434',
    keyRequired: false,
    supportsStreaming: true,
    local: true,
    docsUrl: 'https://github.com/ollama/ollama/blob/main/docs/api.md',
  },
  {
    id: 'custom',
    displayName: 'Custom (OpenAI-compatible)',
    protocol: 'openai',
    defaultBaseUrl: '',
    keyRequired: false,
    supportsStreaming: false,
    local: false,
    docsUrl: '',
  },
] as const;

export function providerById(id: ProviderId): ProviderDescriptor | undefined {
  return PROVIDERS.find((provider) => provider.id === id);
}

/**
 * Curated starter models per provider. The user can always type an arbitrary
 * model id (providers rotate models faster than extensions ship), so this is
 * a suggestion list, never an allowlist.
 */
export const SUGGESTED_MODELS: readonly ModelSpec[] = [
  {
    providerId: 'openai',
    modelId: 'gpt-4o-mini',
    displayName: 'GPT-4o mini',
    tier: 'fast',
    contextWindow: 128_000,
    supportsTools: true,
    supportsVision: true,
  },
  {
    providerId: 'openai',
    modelId: 'gpt-4o',
    displayName: 'GPT-4o',
    tier: 'powerful',
    contextWindow: 128_000,
    supportsTools: true,
    supportsVision: true,
  },
  {
    providerId: 'anthropic',
    modelId: 'claude-sonnet-4-20250514',
    displayName: 'Claude Sonnet 4',
    tier: 'balanced',
    contextWindow: 200_000,
    supportsTools: true,
    supportsVision: true,
  },
  {
    providerId: 'anthropic',
    modelId: 'claude-opus-4-20250514',
    displayName: 'Claude Opus 4',
    tier: 'powerful',
    contextWindow: 200_000,
    supportsTools: true,
    supportsVision: true,
  },
  {
    providerId: 'google',
    modelId: 'gemini-2.0-flash',
    displayName: 'Gemini 2.0 Flash',
    tier: 'fast',
    contextWindow: 1_000_000,
    supportsTools: true,
    supportsVision: true,
  },
  {
    providerId: 'google',
    modelId: 'gemini-2.5-pro',
    displayName: 'Gemini 2.5 Pro',
    tier: 'powerful',
    contextWindow: 1_000_000,
    supportsTools: true,
    supportsVision: true,
  },
  {
    providerId: 'openrouter',
    modelId: 'openai/gpt-4o-mini',
    displayName: 'GPT-4o mini (via OpenRouter)',
    tier: 'fast',
    contextWindow: 128_000,
    supportsTools: true,
    supportsVision: true,
  },
  {
    providerId: 'openrouter',
    modelId: 'anthropic/claude-sonnet-4',
    displayName: 'Claude Sonnet 4 (via OpenRouter)',
    tier: 'powerful',
    contextWindow: 200_000,
    supportsTools: true,
    supportsVision: true,
  },
  {
    providerId: 'ollama',
    modelId: 'llama3.1:8b',
    displayName: 'Llama 3.1 8B (local)',
    tier: 'local',
    contextWindow: 128_000,
    supportsTools: false,
    supportsVision: false,
    notes: 'Runs entirely on-device; no data leaves the machine.',
  },
] as const;

export function modelsForProvider(id: ProviderId): readonly ModelSpec[] {
  return SUGGESTED_MODELS.filter((model) => model.providerId === id);
}
