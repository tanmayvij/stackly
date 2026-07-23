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
// modules/preview). Set with: `firebase functions:secrets:set
// PREVIEW_TOKEN_SECRET` (32+ random bytes).
export const PREVIEW_TOKEN_SECRET = defineSecret("PREVIEW_TOKEN_SECRET");
