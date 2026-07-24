// Emulator-backed tests for the wallet ledger (wallet.service.ts): the running
// balance on the root wallet doc, the per-transaction `balanceAfter` audit
// field, idempotent dedup on refId, and dedup under concurrency. Exported as a
// Suite and run by test/run-emulator.ts under the Firestore emulator; state is
// cleared before each test. See wallet.test.ts for the pure billing math.

import assert from "node:assert";
import {Test, Suite} from "../../test/harness";
import {walletRef, walletTransactionsCollection} from "../../shared/firestore/refs";
import {addTransaction, getBalanceForUser} from "./wallet.service";

const UID = "wallet-user";

/**
 * Returns the ledger's transaction docs keyed by refId.
 * @param {string} uid The wallet owner.
 * @return {Promise<Map<string, FirebaseFirestore.DocumentData>>} refId → doc.
 */
async function txnsByRef(
  uid: string,
): Promise<Map<string, FirebaseFirestore.DocumentData>> {
  const snap = await walletTransactionsCollection(uid).get();
  return new Map(snap.docs.map((d) => [d.get("refId") as string, d.data()]));
}

const tests: Test[] = [
  [
    "getBalanceForUser returns 0 for a wallet with no transactions",
    async () => {
      assert.equal(await getBalanceForUser(UID), 0);
    },
  ],
  [
    "getBalanceForUser returns the stored running balance",
    async () => {
      await walletRef(UID).set({balanceCents: 742});
      assert.equal(await getBalanceForUser(UID), 742);
    },
  ],
  [
    "a first credit sets both the root balance and the doc's balanceAfter",
    async () => {
      const wrote = await addTransaction({
        userId: UID,
        type: "CREDIT",
        valueInCents: 1000,
        tokensUsed: 0,
        refId: "pi_first",
      });
      assert.equal(wrote, true);
      assert.equal(await getBalanceForUser(UID), 1000);
      const byRef = await txnsByRef(UID);
      assert.equal(byRef.get("pi_first")?.balanceAfter, 1000);
    },
  ],
  [
    "a sequence carries the running balance forward on every doc",
    async () => {
      await addTransaction({
        userId: UID, type: "CREDIT", valueInCents: 1000, tokensUsed: 0,
        refId: "credit_a",
      });
      await addTransaction({
        userId: UID, type: "DEBIT", valueInCents: -300, tokensUsed: 600,
        refId: "debit_b",
      });
      await addTransaction({
        userId: UID, type: "CREDIT", valueInCents: 50, tokensUsed: 0,
        refId: "credit_c",
      });
      assert.equal(await getBalanceForUser(UID), 750);
      const byRef = await txnsByRef(UID);
      assert.equal(byRef.get("credit_a")?.balanceAfter, 1000);
      assert.equal(byRef.get("debit_b")?.balanceAfter, 700);
      assert.equal(byRef.get("credit_c")?.balanceAfter, 750);
    },
  ],
  [
    "a repeated refId writes once and leaves the balance unchanged",
    async () => {
      const first = await addTransaction({
        userId: UID, type: "CREDIT", valueInCents: 100, tokensUsed: 0,
        refId: "dupe",
      });
      const second = await addTransaction({
        userId: UID, type: "CREDIT", valueInCents: 100, tokensUsed: 0,
        refId: "dupe",
      });
      assert.equal(first, true);
      assert.equal(second, false);
      assert.equal(await getBalanceForUser(UID), 100);
      const snap = await walletTransactionsCollection(UID).get();
      assert.equal(snap.size, 1);
    },
  ],
  [
    "the transaction doc records type, tokens, refId, value and a timestamp",
    async () => {
      await addTransaction({
        userId: UID, type: "DEBIT", valueInCents: -50, tokensUsed: 1234,
        refId: "chat:req-1",
      });
      const doc = (await txnsByRef(UID)).get("chat:req-1");
      assert.equal(doc?.type, "DEBIT");
      assert.equal(doc?.valueInCents, -50);
      assert.equal(doc?.tokensUsed, 1234);
      assert.equal(doc?.refId, "chat:req-1");
      assert.equal(doc?.balanceAfter, -50);
      assert.ok(doc?.timestamp, "timestamp should be stamped");
    },
  ],
  [
    "concurrent writes of the same refId dedup to exactly one transaction",
    async () => {
      const results = await Promise.all(
        Array.from({length: 4}, () =>
          addTransaction({
            userId: UID, type: "CREDIT", valueInCents: 100, tokensUsed: 0,
            refId: "race",
          }),
        ),
      );
      const wroteCount = results.filter(Boolean).length;
      assert.equal(wroteCount, 1, "exactly one write should win");
      assert.equal(await getBalanceForUser(UID), 100);
      const snap = await walletTransactionsCollection(UID).get();
      assert.equal(snap.size, 1);
    },
  ],
];

export const suite: Suite = {name: "wallet.service (emulator)", tests};
