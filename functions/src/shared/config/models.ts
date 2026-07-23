// LLM model catalog: per-model pricing and context windows, plus the shared
// model/compaction constants. Prices mirror the frontend
// stackly-frontend/src/lib/models.ts contextWindowTokens.

// The conversation is compacted once a run's total context usage crosses this
// fraction of the model's window.
export const COMPACT_AT_FRACTION = 0.75;

// Fast + cheap model used for auxiliary calls (project naming, compaction).
export const FLASH_MODEL = "deepseek-ai/DeepSeek-V4-Flash";

export interface ModelPrice {
  // Model id as sent to the LLM provider.
  model: string;
  // Price per one million tokens, in whole cents.
  pricePerMillionTokensCents: number;
  // Context window size in tokens — mirrors the frontend
  // stackly-frontend/src/lib/models.ts contextWindowTokens.
  contextWindowTokens: number;
}

// Per-model pricing. The cost of any single API call is always rounded UP to
// the next whole cent (see `costForTokens` in modules/wallet).
export const MODEL_PRICING: ModelPrice[] = [
  {
    model: "zai-org/GLM-5.2",
    pricePerMillionTokensCents: 400,
    contextWindowTokens: 1_000_000,
  },
  {
    model: "moonshotai/Kimi-K2.7-Code",
    pricePerMillionTokensCents: 450,
    contextWindowTokens: 256_000,
  },
  {
    model: "deepseek-ai/DeepSeek-V4-Flash",
    pricePerMillionTokensCents: 50,
    contextWindowTokens: 1_000_000,
  },
  {
    model: "openai/gpt-oss-120b",
    pricePerMillionTokensCents: 35,
    contextWindowTokens: 128_000,
  },
];

/**
 * Looks up a model's configuration.
 * @param {string} model The model id.
 * @return {ModelPrice} The model's pricing/window entry.
 */
export function modelConfig(model: string): ModelPrice {
  const entry = MODEL_PRICING.find((m) => m.model === model);
  if (!entry) throw new Error(`No configuration for model "${model}".`);
  return entry;
}
