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

// OpenAI-compatible LLM endpoint used to name/describe new projects. The base
// URL isn't sensitive, but it uses the same secret mechanism so both live in
// one place. Set each with: `firebase functions:secrets:set <NAME>`.
export const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");
export const OPENAI_BASE_URL = defineSecret("OPENAI_BASE_URL");

// Top-up bounds, in cents. Mirrors the frontend WalletModal limits.
export const MIN_TOPUP_CENTS = 100; // $1
export const MAX_TOPUP_CENTS = 100_000; // $1000

export interface ModelPrice {
  // Model id as sent to the LLM provider.
  model: string;
  // Price per one million tokens, in whole cents.
  pricePerMillionTokensCents: number;
}

// Per-model pricing. The cost of any single API call is always rounded UP to
// the next whole cent (see `costForTokens` in ./wallet).
export const MODEL_PRICING: ModelPrice[] = [
  {model: "zai-org/GLM-5.2", pricePerMillionTokensCents: 400},
  {model: "moonshotai/Kimi-K2.7-Code", pricePerMillionTokensCents: 450},
  {model: "deepseek-ai/DeepSeek-V4-Flash", pricePerMillionTokensCents: 50},
  {model: "openai/gpt-oss-120b", pricePerMillionTokensCents: 35},
];
