import {defineSecret} from "firebase-functions/params";

// Stripe secret (API) key. Bound only to functions that talk to Stripe.
// Set with: `firebase functions:secrets:set STRIPE_SECRET_KEY`
export const STRIPE_SECRET_KEY = defineSecret("STRIPE_SECRET_KEY");

// HighLevel (GHL) OAuth app credentials. Bound only to the OAuth functions.
// The client id is also public on the frontend (VITE_GHL_CLIENT_ID); the
// backend keeps its own copy as the source of truth for the token exchange.
// Set each with: `firebase functions:secrets:set <NAME>`.
export const GHL_CLIENT_ID = defineSecret("GHL_CLIENT_ID");
export const GHL_CLIENT_SECRET = defineSecret("GHL_CLIENT_SECRET");
export const GHL_REDIRECT_URI = defineSecret("GHL_REDIRECT_URI");

// OpenAI-compatible LLM endpoint used to name/describe new projects. The base
// URL isn't sensitive, but it uses the same secret mechanism so both live in
// one place. Set each with: `firebase functions:secrets:set <NAME>`.
export const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");
export const OPENAI_BASE_URL = defineSecret("OPENAI_BASE_URL");

// HMAC key for short-lived preview tokens handed to generated apps (see
// ./preview-token). Set with: `firebase functions:secrets:set
// PREVIEW_TOKEN_SECRET` (32+ random bytes).
export const PREVIEW_TOKEN_SECRET = defineSecret("PREVIEW_TOKEN_SECRET");

// Top-up bounds, in cents. Mirrors the frontend WalletModal limits.
export const MIN_TOPUP_CENTS = 100; // $1
export const MAX_TOPUP_CENTS = 100_000; // $1000

// Chat requests are rejected with 402 below this balance. Mirrors the
// frontend LOW_BALANCE_THRESHOLD_CENTS in stores/wallet.ts.
export const LOW_BALANCE_THRESHOLD_CENTS = 100;

// Accepted shape of a client-supplied project id (Firestore auto-ids are
// 20-char alphanumeric; we allow a little slack). Rejecting anything else
// keeps a caller from reshaping the Firestore document path with slashes.
export const PROJECT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// Upper bounds on user-supplied builder text, enforced server-side so an
// oversized prompt/answer can't bloat a document or an LLM request.
export const MAX_PROMPT_CHARS = 10_000;
export const MAX_ANSWER_CHARS = 2_000;

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
// the next whole cent (see `costForTokens` in ./wallet).
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
