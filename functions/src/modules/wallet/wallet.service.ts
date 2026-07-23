// Wallet ledger: balance reads, the single idempotent write path, and the
// pure per-token billing math. Firestore access goes through the shared ref
// builders; clients have read-only access per firestore.rules.

import {randomUUID} from "node:crypto";
import {getFirestore, FieldValue} from "firebase-admin/firestore";
import {MODEL_PRICING} from "../../shared/config";
import {
  walletRef,
  walletTransactionsCollection,
} from "../../shared/firestore/refs";
import {AddTransactionInput, WalletTransaction} from "./wallet.types";

/**
 * Reads the running balance maintained on the parent `wallets/{uid}` doc by
 * `addTransaction`, in cents. O(1) — a single document read. This is the ONLY
 * authority on balance — it must never be computed on the client.
 * @param {string} userId The owner's uid.
 * @return {Promise<number>} The balance in cents (0 if the wallet has no
 *   transactions yet).
 */
export async function getBalanceForUser(userId: string): Promise<number> {
  const snap = await walletRef(userId).get();
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
  const wallet = walletRef(userId);
  const col = walletTransactionsCollection(userId);

  return getFirestore().runTransaction(async (t) => {
    // All reads before any write (Firestore transaction rule).
    const existing = await t.get(col.where("refId", "==", refId).limit(1));
    const walletSnap = await t.get(wallet);
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
      wallet,
      {balanceCents: next, updatedAt: FieldValue.serverTimestamp()},
      {merge: true},
    );
    t.set(col.doc(randomUUID()), record);
    return true;
  });
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
