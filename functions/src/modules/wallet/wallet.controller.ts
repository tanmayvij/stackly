// Wallet callables: balance read + Stripe top-up create/confirm. All three
// enforce App Check; the Stripe-backed ones bind the Stripe secret.

import {onCall, HttpsError} from "firebase-functions/https";
import {
  MAX_TOPUP_CENTS,
  MIN_TOPUP_CENTS,
  STRIPE_SECRET_KEY,
} from "../../shared/config";
import {requireUid} from "../../shared/auth";
import {addTransaction, getBalanceForUser} from "./wallet.service";
import {stripeClient} from "./stripe.client";

// Returns the caller's current wallet balance in cents, computed server-side.
// Used at app runtime to seed the store and after a recharge to refresh it.
export const getCurrentBalance = onCall(
  {enforceAppCheck: true},
  async (request) => {
    const uid = requireUid(request.auth, "Sign in to use the wallet.");
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
    const uid = requireUid(request.auth, "Sign in to use the wallet.");

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
    const uid = requireUid(request.auth, "Sign in to use the wallet.");

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
