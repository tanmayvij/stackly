// Emulator-backed tests for resolving a pending generation turn
// (variants.service.ts): applying a variant commits exactly one version plus
// its assistant message, is idempotent on requestId, rebases onto a head that
// moved while the user was choosing, refuses to commit blobs the client never
// uploaded, and reads its billing figures off the ledger instead of trusting
// the caller. Discarding writes an interrupted turn and no version. Exported
// as a Suite, run by test/run-emulator.ts with state cleared before each test.
// Pure input validation lives in variants.service.test.ts.

import assert from "node:assert";
import {Test, Suite} from "../../../test/harness";
import {
  projectMessagesCollection,
  projectVersionsCollection,
  userProjectRef,
  walletTransactionsCollection,
} from "../../../shared/firestore/refs";
import {GHL_CLIENT_SHA256} from "../../ghl/generated-client";
import {writeUserMessage} from "../messages/messages.service";
import {
  GHL_CLIENT_PATH,
  sha256Hex,
  uploadBlobIfAbsent,
} from "../versions/versions.service";
import {
  TurnPayload,
  applyPendingVariant,
  discardPendingTurn,
  readTurnBilling,
} from "./variants.service";

const UID = "var-user";
const PID = "proj-1";
const REQ = "11111111-2222-3333-4444-555555555555";
const MODEL = "zai-org/GLM-5.2";

/**
 * Creates the project doc plus the pending user turn a resolution answers.
 * @param {Record<string, unknown>} [extra] Extra project fields to merge in.
 * @return {Promise<void>} Resolves once written.
 */
async function seedTurn(
  extra: Record<string, unknown> = {},
): Promise<void> {
  await userProjectRef(UID, PID).set({
    headVersion: 0,
    lastMessageSeq: 0,
    deleted: false,
    modelId: MODEL,
    ...extra,
  });
  await writeUserMessage(UID, PID, "add a contacts table", null);
}

/**
 * Records the debit the chat endpoint writes before offering the variants.
 * @param {number} tokens Tokens the generation consumed.
 * @param {number} cents Cost in cents.
 * @return {Promise<void>} Resolves once written.
 */
async function seedDebit(tokens: number, cents: number): Promise<void> {
  await walletTransactionsCollection(UID).doc("t1").set({
    type: "DEBIT",
    valueInCents: -cents,
    tokensUsed: tokens,
    refId: `chat:${REQ}`,
    balanceAfter: 1000,
  });
}

/**
 * Uploads a blob the way the client does before applying, and returns its
 * hash.
 * @param {string} content The file content.
 * @return {Promise<string>} The blob sha256.
 */
async function putBlob(content: string): Promise<string> {
  const hash = sha256Hex(content);
  await uploadBlobIfAbsent(UID, PID, hash, content);
  return hash;
}

/**
 * A minimal turn payload.
 * @param {string} [reply] The reply text.
 * @param {number} [baseVersion] Head at generation time.
 * @return {TurnPayload} The payload.
 */
function payload(
  reply = "Built two takes on it.",
  baseVersion = 0,
): TurnPayload {
  return {
    reply,
    summary: "Table view",
    title: "add a contacts table",
    baseVersion,
    questions: [],
    suggestions: [],
  };
}

/**
 * Matcher for an HttpsError with a given code. HttpsError's string form only
 * carries the human message, so the code has to be checked directly.
 * @param {string} code The expected error code.
 * @return {Function} An assert.rejects matcher.
 */
function hasCode(code: string): (err: unknown) => boolean {
  return (err: unknown) => (err as {code?: string})?.code === code;
}

/**
 * Reads the single assistant message written for the seeded turn.
 * @return {Promise<FirebaseFirestore.DocumentSnapshot>} The message doc.
 */
async function assistantDoc(): Promise<FirebaseFirestore.DocumentSnapshot> {
  const snap = await projectMessagesCollection(UID, PID)
    .where("role", "==", "assistant")
    .get();
  assert.equal(snap.size, 1, "expected exactly one assistant message");
  return snap.docs[0] as FirebaseFirestore.DocumentSnapshot;
}

const tests: Test[] = [
  [
    "apply commits one version, the message, and ledger-derived billing",
    async () => {
      await seedTurn();
      await seedDebit(1234, 5);
      const hash = await putBlob("the code");

      const res = await applyPendingVariant(
        UID, PID, REQ,
        {writes: new Map([["src/App.jsx", hash]]), deletes: new Set()},
        payload(),
      );
      assert.equal(res.versionN, 1);
      assert.ok(res.committed);

      const version = await projectVersionsCollection(UID, PID).doc("1").get();
      assert.equal(version.get("source"), "ai");
      // Pinned to the generation, so it names the turn it actually answers.
      assert.equal(version.get("title"), "add a contacts table");
      const tree = version.get("tree") as Record<string, string>;
      assert.equal(tree["src/App.jsx"], hash);
      assert.equal(tree[GHL_CLIENT_PATH], GHL_CLIENT_SHA256);

      const msg = await assistantDoc();
      assert.equal(msg.get("versionN"), 1);
      assert.equal(msg.get("status"), "complete");
      assert.equal(msg.get("content"), "Built two takes on it.");
      assert.equal(msg.get("model"), MODEL);
      assert.deepEqual(msg.get("files"), [
        {path: "src/App.jsx", action: "write"},
      ]);
      // Never taken from the caller: contextTokens drives compaction.
      assert.equal(msg.get("tokensConsumed"), 1234);
      assert.equal(msg.get("contextTokens"), 1234);
      assert.equal(msg.get("costCents"), 5);
    },
  ],
  [
    "apply is idempotent on requestId — a double click commits once",
    async () => {
      await seedTurn();
      await seedDebit(10, 1);
      const hash = await putBlob("x");
      const delta = {
        writes: new Map([["a.js", hash]]),
        deletes: new Set<string>(),
      };

      const first = await applyPendingVariant(UID, PID, REQ, delta, payload());
      const second = await applyPendingVariant(UID, PID, REQ, delta, payload());
      assert.equal(first.versionN, 1);
      assert.ok(first.committed);
      assert.equal(second.versionN, 1);
      // The second call must not have committed anything of its own.
      assert.equal(second.committed, null);
      const versions = await projectVersionsCollection(UID, PID).get();
      assert.equal(versions.size, 1);
      await assistantDoc();
    },
  ],
  [
    "apply rebases over an unrelated change made while the user was choosing",
    async () => {
      await seedTurn();
      await seedDebit(10, 1);
      // Generated against v1 …
      await projectVersionsCollection(UID, PID).doc("1").set({
        n: 1, title: "base", source: "manual",
        tree: {"src/styles.css": "hash-a", "src/App.jsx": "hash-old"},
      });
      // … then a manual save touched a DIFFERENT file, landing as v2.
      await projectVersionsCollection(UID, PID).doc("2").set({
        n: 2, title: "Update styles.css", source: "manual",
        tree: {"src/styles.css": "hash-manual", "src/App.jsx": "hash-old"},
      });
      await userProjectRef(UID, PID).update({headVersion: 2});

      const hash = await putBlob("new app");
      const res = await applyPendingVariant(
        UID, PID, REQ,
        {writes: new Map([["src/App.jsx", hash]]), deletes: new Set()},
        payload("Built it.", 1),
      );
      assert.equal(res.versionN, 3);
      const tree = (await projectVersionsCollection(UID, PID).doc("3").get())
        .get("tree") as Record<string, string>;
      // The manual edit survives; only the variant's own file changes.
      assert.equal(tree["src/styles.css"], "hash-manual");
      assert.equal(tree["src/App.jsx"], hash);
    },
  ],
  [
    "apply aborts when a file it rewrites changed since it was generated",
    async () => {
      await seedTurn();
      await seedDebit(10, 1);
      await projectVersionsCollection(UID, PID).doc("1").set({
        n: 1, title: "base", source: "manual", tree: {"src/App.jsx": "hash-v1"},
      });
      // Another tab (or another turn) already rewrote the same file.
      await projectVersionsCollection(UID, PID).doc("2").set({
        n: 2, title: "other turn", source: "ai", tree: {"src/App.jsx": "hash-v2"},
      });
      await userProjectRef(UID, PID).update({headVersion: 2});

      const hash = await putBlob("stale app");
      await assert.rejects(
        applyPendingVariant(
          UID, PID, REQ,
          {writes: new Map([["src/App.jsx", hash]]), deletes: new Set()},
          payload("Built it.", 1),
        ),
        hasCode("aborted"),
      );
      // Committing would have silently discarded hash-v2.
      const head = await userProjectRef(UID, PID).get();
      assert.equal(head.get("headVersion"), 2);
      const msgs = await projectMessagesCollection(UID, PID)
        .where("role", "==", "assistant").get();
      assert.equal(msgs.size, 0);
    },
  ],
  [
    "apply aborts when a file it deletes changed since it was generated",
    async () => {
      await seedTurn();
      await seedDebit(10, 1);
      await projectVersionsCollection(UID, PID).doc("1").set({
        n: 1, title: "base", source: "manual", tree: {"src/Old.jsx": "hash-v1"},
      });
      await projectVersionsCollection(UID, PID).doc("2").set({
        n: 2, title: "other turn", source: "ai", tree: {"src/Old.jsx": "hash-v2"},
      });
      await userProjectRef(UID, PID).update({headVersion: 2});

      await assert.rejects(
        applyPendingVariant(
          UID, PID, REQ,
          {writes: new Map(), deletes: new Set(["src/Old.jsx"])},
          payload("Built it.", 1),
        ),
        hasCode("aborted"),
      );
    },
  ],
  [
    "apply applies deletes and drops paths the variant removed",
    async () => {
      await seedTurn();
      await seedDebit(10, 1);
      await projectVersionsCollection(UID, PID).doc("1").set({
        n: 1, title: "seed", source: "manual",
        tree: {"src/Old.jsx": "hash-old", "src/App.jsx": "hash-app"},
      });
      await userProjectRef(UID, PID).update({headVersion: 1});

      const res = await applyPendingVariant(
        UID, PID, REQ,
        {writes: new Map(), deletes: new Set(["src/Old.jsx"])},
        payload("Built it.", 1),
      );
      const tree = (await projectVersionsCollection(UID, PID)
        .doc(String(res.versionN)).get()).get("tree") as Record<string, string>;
      assert.equal("src/Old.jsx" in tree, false);
      assert.equal(tree["src/App.jsx"], "hash-app");
      assert.deepEqual((await assistantDoc()).get("files"), [
        {path: "src/Old.jsx", action: "delete"},
      ]);
    },
  ],
  [
    "apply refuses to commit a blob the client never uploaded",
    async () => {
      await seedTurn();
      await seedDebit(10, 1);
      await assert.rejects(
        applyPendingVariant(
          UID, PID, REQ,
          {writes: new Map([["a.js", sha256Hex("never uploaded")]]),
            deletes: new Set()},
          payload(),
        ),
        hasCode("failed-precondition"),
      );
      const versions = await projectVersionsCollection(UID, PID).get();
      assert.equal(versions.size, 0);
      const msgs = await projectMessagesCollection(UID, PID)
        .where("role", "==", "assistant").get();
      assert.equal(msgs.size, 0);
    },
  ],
  [
    "apply rejects a missing or deleted project",
    async () => {
      await assert.rejects(
        applyPendingVariant(
          UID, "missing", REQ,
          {writes: new Map(), deletes: new Set(["a.js"])}, payload(),
        ),
        hasCode("not-found"),
      );
      await seedTurn({deleted: true});
      await assert.rejects(
        applyPendingVariant(
          UID, PID, REQ,
          {writes: new Map(), deletes: new Set(["a.js"])}, payload(),
        ),
        hasCode("not-found"),
      );
    },
  ],
  [
    "apply titles the version after its own turn, not a newer user turn",
    async () => {
      await seedTurn();
      await seedDebit(10, 1);
      // A second tab appended its own request while these options waited.
      await writeUserMessage(UID, PID, "something else entirely", null);

      const hash = await putBlob("x");
      const res = await applyPendingVariant(
        UID, PID, REQ,
        {writes: new Map([["a.js", hash]]), deletes: new Set()},
        payload(),
      );
      const version = await projectVersionsCollection(UID, PID)
        .doc(String(res.versionN)).get();
      assert.equal(version.get("title"), "add a contacts table");
    },
  ],
  [
    "discard writes an interrupted turn and no version",
    async () => {
      await seedTurn();
      await seedDebit(777, 3);
      const res = await discardPendingTurn(UID, PID, REQ, payload("Two takes."));
      assert.equal(res.versionN, null);
      assert.equal(res.committed, null);

      const versions = await projectVersionsCollection(UID, PID).get();
      assert.equal(versions.size, 0);
      const msg = await assistantDoc();
      // Reuses the existing "Stopped" + Retry affordance, and keeps the ledger
      // entry the generation already produced reconciled with the transcript.
      assert.equal(msg.get("status"), "interrupted");
      assert.equal(msg.get("versionN"), null);
      assert.deepEqual(msg.get("files"), []);
      assert.equal(msg.get("content"), "Two takes.");
      assert.equal(msg.get("tokensConsumed"), 777);
      assert.equal(msg.get("costCents"), 3);
    },
  ],
  [
    "discard is idempotent, and cannot overwrite an applied turn",
    async () => {
      await seedTurn();
      await seedDebit(10, 1);
      const hash = await putBlob("x");
      await applyPendingVariant(
        UID, PID, REQ,
        {writes: new Map([["a.js", hash]]), deletes: new Set()}, payload(),
      );
      const res = await discardPendingTurn(UID, PID, REQ, payload());
      assert.equal(res.versionN, 1);
      const msg = await assistantDoc();
      assert.equal(msg.get("status"), "complete");
    },
  ],
  [
    "readTurnBilling reports zeroes when the turn was never debited",
    async () => {
      assert.deepEqual(await readTurnBilling(UID, REQ),
        {tokensUsed: 0, costCents: 0});
      await seedDebit(42, 2);
      assert.deepEqual(await readTurnBilling(UID, REQ),
        {tokensUsed: 42, costCents: 2});
    },
  ],
];

export const suite: Suite = {name: "variants.service (emulator)", tests};
