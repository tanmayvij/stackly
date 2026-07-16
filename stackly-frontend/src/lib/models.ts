export interface LlmModel {
  // Model id as sent to the LLM provider — mirrors functions/src/config.ts MODEL_PRICING.
  id: string
  name: string
  pricePerMillionTokensCents: number
  contextWindow: string
  bestFor: string
  recommended?: boolean
}

export const DEFAULT_MODEL_ID = 'moonshotai/Kimi-K2.7-Code'

export const MODELS: LlmModel[] = [
  {
    id: 'openai/gpt-oss-120b',
    name: 'gpt-oss-120b',
    pricePerMillionTokensCents: 35,
    contextWindow: '128k',
    bestFor: 'complex, multi-step apps with tricky logic',
  },
  {
    id: 'moonshotai/Kimi-K2.7-Code',
    name: 'kimi 2.7 code',
    pricePerMillionTokensCents: 450,
    contextWindow: '256k',
    bestFor: 'writing and editing app code',
    recommended: true,
  },
  {
    id: 'deepseek-ai/DeepSeek-V4-Flash',
    name: 'deepseek v4 flash',
    pricePerMillionTokensCents: 50,
    contextWindow: '1M',
    bestFor: 'quick edits and small changes',
  },
  {
    id: 'zai-org/GLM-5.2',
    name: 'glm 5.2',
    pricePerMillionTokensCents: 400,
    contextWindow: '1M',
    bestFor: 'polished, UI-heavy apps and visual layouts',
  },
]
