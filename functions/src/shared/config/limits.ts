// Server-enforced bounds and validation patterns for user-supplied input.
// Several values mirror frontend constants (noted inline); keep them in sync.

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
