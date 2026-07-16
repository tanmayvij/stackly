import { defineSecret } from "firebase-functions/params";

// Stripe secret (API) key. Bound only to functions that talk to Stripe.
// Set with: `firebase functions:secrets:set STRIPE_SECRET_KEY`
export const STRIPE_SECRET_KEY = defineSecret("STRIPE_SECRET_KEY");

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
  { model: "zai-org/GLM-5.2", pricePerMillionTokensCents: 400 },
  { model: "moonshotai/Kimi-K2.7-Code", pricePerMillionTokensCents: 450 },
  { model: "deepseek-ai/DeepSeek-V4-Flash", pricePerMillionTokensCents: 50 },
  { model: "openai/gpt-oss-120b", pricePerMillionTokensCents: 35 },
];
