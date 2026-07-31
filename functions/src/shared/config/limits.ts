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

// Alternative implementations the model returns per generation, one of which
// the user picks. Raising it also means editing the OUTPUT PROTOCOL text in
// modules/builder/chat/prompt.ts, which spells the count out in prose.
export const VARIANT_COUNT = 2;

// One-line description each variant carries. The OUTPUT PROTOCOL asks the
// model for "under 80 chars"; this is the enforced clamp, kept deliberately
// above the ask so a slightly chatty summary is trimmed rather than costing
// the variant. Applies both to parsing model output and to the summary the
// client echoes back when resolving a turn.
export const MAX_VARIANT_SUMMARY_CHARS = 120;

// Files a single variant may write or delete. A response above this is a
// runaway, not a change set.
export const MAX_VARIANT_FILES = 60;

// Longest path accepted in a variant's write/delete delta.
export const MAX_VARIANT_PATH_CHARS = 400;

// Version titles: the length versionTitle truncates to, and the title used
// when no user turn supplies one.
export const MAX_VERSION_TITLE_CHARS = 60;
export const DEFAULT_VERSION_TITLE = "AI update";

// A content-addressed blob name: lowercase hex sha256.
export const BLOB_HASH_PATTERN = /^[0-9a-f]{64}$/;

// How far into a caller-supplied questions/suggestions array to look before
// giving up, so a padded array can't cost real work.
export const MAX_ECHOED_LIST_ITEMS = 8;
