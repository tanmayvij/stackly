import {randomUUID} from "node:crypto";
import {getFirestore, FieldValue} from "firebase-admin/firestore";
import {onCall, HttpsError} from "firebase-functions/https";
import Stripe from "stripe";
import {
  MODEL_PRICING,
  STRIPE_SECRET_KEY,
  MIN_TOPUP_CENTS,
  MAX_TOPUP_CENTS,
} from "./config";

type TransactionType = "DEBIT" | "CREDIT";

interface WalletTransaction {
  type: TransactionType;
  // CREDIT: positive; DEBIT: negative.
  valueInCents: number;
  // Always 0 for CREDIT transactions.
  tokensUsed: number;
  // CREDIT: Stripe PaymentIntent id; DEBIT: API request id.
  refId: string;
  timestamp: FirebaseFirestore.Timestamp | FirebaseFirestore.FieldValue;
  // Running balance in cents immediately after this transaction (audit trail).
  balanceAfter: number;
}

export interface AddTransactionInput {
  userId: string;
  type: TransactionType;
  valueInCents: number;
  tokensUsed: number;
  refId: string;
}

/**
 * Reads the running balance maintained on the parent `wallets/{uid}` doc by
 * `addTransaction`, in cents. O(1) — a single document read. This is the ONLY
 * authority on balance — it must never be computed on the client.
 * @param {string} userId The owner's uid.
 * @return {Promise<number>} The balance in cents (0 if the wallet has no
 *   transactions yet).
 */
export async function getBalanceForUser(userId: string): Promise<number> {
  const snap = await getFirestore().collection("wallets").doc(userId).get();
  const balanceCents = snap.get("balanceCents");
  return typeof balanceCents === "number" ? balanceCents : 0;
}

/**
 * The single write path into the ledger. Each transaction gets its own UUID
 * document id, and the write is deduplicated on `refId` inside a Firestore
 * transaction, so a repeated call (e.g. a retried Stripe poll or API request)
 * never records the same transaction twice.
 * @param {AddTransactionInput} input The transaction to record.
 * @return {Promise<boolean>} `true` if a transaction was written, `false` if a
 *   transaction with the same refId already existed.
 */
export async function addTransaction(
  input: AddTransactionInput,
): Promise<boolean> {
  const {userId, type, valueInCents, tokensUsed, refId} = input;
  const walletRef = getFirestore().collection("wallets").doc(userId);
  const col = walletRef.collection("transactions");

  return getFirestore().runTransaction(async (t) => {
    // All reads before any write (Firestore transaction rule).
    const existing = await t.get(col.where("refId", "==", refId).limit(1));
    const walletSnap = await t.get(walletRef);
    if (!existing.empty) return false;

    // Carry the balance forward. A missing counter means an empty wallet.
    const current = walletSnap.get("balanceCents");
    const next = (typeof current === "number" ? current : 0) + valueInCents;

    const record: WalletTransaction = {
      type,
      valueInCents,
      tokensUsed,
      refId,
      timestamp: FieldValue.serverTimestamp(),
      balanceAfter: next,
    };

    t.set(
      walletRef,
      {balanceCents: next, updatedAt: FieldValue.serverTimestamp()},
      {merge: true},
    );
    t.set(col.doc(randomUUID()), record);
    return true;
  });
}

/**
 * Lazily constructs the Stripe client from the runtime secret.
 * @return {Stripe} A configured Stripe client.
 */
function stripeClient(): Stripe {
  return new Stripe(STRIPE_SECRET_KEY.value());
}

/**
 * Rejects unauthenticated callers.
 * @param {{uid: string} | undefined} auth The callable auth context.
 * @return {string} The authenticated uid.
 */
function requireUid(auth: {uid: string} | undefined): string {
  if (!auth) {
    throw new HttpsError("unauthenticated", "Sign in to use the wallet.");
  }
  return auth.uid;
}

/**
 * Cost in whole cents for a number of tokens on a given model, ALWAYS rounded
 * up to the next cent. For use by the pre-LLM-call debit path.
 * @param {string} model The model id (must exist in MODEL_PRICING).
 * @param {number} tokens Number of tokens consumed.
 * @return {number} The cost in cents.
 */
export function costForTokens(model: string, tokens: number): number {
  const pricing = MODEL_PRICING.find((m) => m.model === model);
  if (!pricing) {
    throw new Error(`No pricing configured for model "${model}".`);
  }
  return Math.ceil((tokens / 1_000_000) * pricing.pricePerMillionTokensCents);
}

// Returns the caller's current wallet balance in cents, computed server-side.
// Used at app runtime to seed the store and after a recharge to refresh it.
export const getCurrentBalance = onCall(
  {enforceAppCheck: true},
  async (request) => {
    const uid = requireUid(request.auth);
    const balanceCents = await getBalanceForUser(uid);
    return {balanceCents};
  },
);

// Creates a one-time Stripe PaymentIntent for a wallet top-up and returns its
// client secret. The amount is validated and clamped server-side, and the
// caller's uid is stamped into metadata so `confirmTopUp` can verify ownership.
export const createTopUpIntent = onCall(
  {secrets: [STRIPE_SECRET_KEY], enforceAppCheck: true},
  async (request) => {
    const uid = requireUid(request.auth);

    const amountCents = request.data?.amountCents;
    if (
      typeof amountCents !== "number" ||
      !Number.isInteger(amountCents) ||
      amountCents < MIN_TOPUP_CENTS ||
      amountCents > MAX_TOPUP_CENTS
    ) {
      throw new HttpsError(
        "invalid-argument",
        `Amount must be a whole number of cents between ${MIN_TOPUP_CENTS} ` +
          `and ${MAX_TOPUP_CENTS}.`,
      );
    }

    const intent = await stripeClient().paymentIntents.create({
      amount: amountCents,
      currency: "usd",
      automatic_payment_methods: {enabled: true},
      metadata: {userId: uid},
    });

    return {clientSecret: intent.client_secret, paymentIntentId: intent.id};
  },
);

// Verifies a PaymentIntent server-side and, if it has succeeded, idempotently
// credits the wallet. The credited amount comes from Stripe's `amount_received`
// (never client input); ownership is verified via metadata; the credit dedupes
// on the PaymentIntent id (stored as refId), so repeated polls cannot
// double-credit.
export const confirmTopUp = onCall(
  {secrets: [STRIPE_SECRET_KEY], enforceAppCheck: true},
  async (request) => {
    const uid = requireUid(request.auth);

    const paymentIntentId = request.data?.paymentIntentId;
    if (typeof paymentIntentId !== "string" || !paymentIntentId) {
      throw new HttpsError("invalid-argument", "Missing paymentIntentId.");
    }

    const intent = await stripeClient().paymentIntents.retrieve(
      paymentIntentId,
    );

    if (intent.metadata?.userId !== uid) {
      throw new HttpsError(
        "permission-denied",
        "This payment does not belong to you.",
      );
    }

    if (intent.status === "succeeded") {
      await addTransaction({
        userId: uid,
        type: "CREDIT",
        valueInCents: intent.amount_received,
        tokensUsed: 0,
        refId: intent.id,
      });
    }

    const balanceCents = await getBalanceForUser(uid);
    return {status: intent.status, balanceCents};
  },
);
