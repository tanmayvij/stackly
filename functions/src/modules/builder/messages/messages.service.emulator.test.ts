// Emulator-backed tests for message persistence and the per-project chat lock
// (messages.service.ts): transactional seq allocation, the compaction cursor
// written with a summary, the since-compaction bounded read, and the lock's
// acquire / renew / release ownership + expiry/stale-steal semantics under
// concurrency. Exported as a Suite, run by test/run-emulator.ts with state
// cleared before each test. Pure resolution logic lives in messages.test.ts.

import assert from "node:assert";
import {Timestamp} from "firebase-admin/firestore";
import {Test, Suite} from "../../../test/harness";
import {
  chatLockRef,
  projectMessagesCollection,
  userProjectRef,
} from "../../../shared/firestore/refs";
import {
  AssistantMessageInput,
  acquireChatLock,
  readEffectiveHistory,
  releaseChatLock,
  renewChatLock,
  writeAssistantMessage,
  writeSummaryMessage,
  writeUserMessage,
} from "./messages.service";

const UID = "msg-user";
const PID = "proj-1";

// Mirrors the private LOCK_STALE_MS in messages.service.ts (a lock unrenewed
// for longer than this is stealable even before its TTL expires).
const LOCK_STALE_MS = 60_000;

/**
 * Creates the project doc the message writers require.
 * @param {Record<string, unknown>} [extra] Extra fields to merge in.
 * @return {Promise<void>} Resolves once written.
 */
async function seedProject(extra: Record<string, unknown> = {}): Promise<void> {
  await userProjectRef(UID, PID).set({
    lastMessageSeq: 0,
    headVersion: 0,
    deleted: false,
    ...extra,
  });
}

/**
 * A minimal assistant message payload.
 * @param {Partial<AssistantMessageInput>} [o] Field overrides.
 * @return {AssistantMessageInput} The payload.
 */
function assistantInput(
  o: Partial<AssistantMessageInput> = {},
): AssistantMessageInput {
  return {
    content: "ok", status: "complete", files: [], questions: [],
    suggestions: [], versionN: null, contextTokens: 0, tokensConsumed: 0,
    costCents: 0, model: "m", requestId: "r", error: null, ...o,
  };
}

const tests: Test[] = [
  [
    "writeMessage allocates monotonically increasing seq and advances the project",
    async () => {
      await seedProject();
      const a = await writeUserMessage(UID, PID, "hi", null);
      const b = await writeAssistantMessage(UID, PID, assistantInput());
      assert.equal(a.seq, 1);
      assert.equal(b.seq, 2);
      const proj = await userProjectRef(UID, PID).get();
      assert.equal(proj.get("lastMessageSeq"), 2);
    },
  ],
  [
    "writeMessage throws when the project no longer exists",
    async () => {
      await assert.rejects(writeUserMessage(UID, "missing", "hi", null));
    },
  ],
  [
    "writeSummaryMessage writes the marker and the compaction cursor together",
    async () => {
      await seedProject();
      await writeUserMessage(UID, PID, "a", null);
      await writeUserMessage(UID, PID, "b", null);
      const summary = await writeSummaryMessage(UID, PID, {
        content: "summary text", compactedThroughSeq: 2, tokensConsumed: 10,
        costCents: 1, requestId: "req",
      });
      assert.equal(summary.seq, 3);
      const proj = await userProjectRef(UID, PID).get();
      assert.equal(proj.get("compactedThroughSeq"), 2);
    },
  ],
  [
    "readEffectiveHistory returns every turn for a never-compacted project",
    async () => {
      await seedProject();
      await writeUserMessage(UID, PID, "a", null);
      await writeAssistantMessage(UID, PID, assistantInput());
      await writeUserMessage(UID, PID, "b", null);
      const {summary, turns} = await readEffectiveHistory(UID, PID);
      assert.equal(summary, null);
      assert.deepEqual(turns.map((t) => t.seq), [1, 2, 3]);
    },
  ],
  [
    "readEffectiveHistory reads only seq > cutoff after a compaction",
    async () => {
      await seedProject();
      await writeUserMessage(UID, PID, "a", null); // seq 1
      await writeAssistantMessage(UID, PID, assistantInput()); // seq 2
      await writeSummaryMessage(UID, PID, {
        content: "sum", compactedThroughSeq: 2, tokensConsumed: 0, costCents: 0,
        requestId: "req",
      }); // seq 3, sets cursor to 2
      await writeUserMessage(UID, PID, "b", null); // seq 4
      const {summary, turns} = await readEffectiveHistory(UID, PID);
      assert.equal(summary?.seq, 3);
      assert.deepEqual(turns.map((t) => t.seq), [4]);
      // The pre-compaction turns still exist; they are just not re-read.
      const all = await projectMessagesCollection(UID, PID).get();
      assert.equal(all.size, 4);
    },
  ],
  [
    "concurrent writes receive distinct, gap-free seqs",
    async () => {
      await seedProject();
      const results = await Promise.all(
        Array.from({length: 5}, (_, i) =>
          writeUserMessage(UID, PID, `m${i}`, null),
        ),
      );
      const seqs = results.map((r) => r.seq).sort((x, y) => x - y);
      assert.deepEqual(seqs, [1, 2, 3, 4, 5]);
      const proj = await userProjectRef(UID, PID).get();
      assert.equal(proj.get("lastMessageSeq"), 5);
    },
  ],
  [
    "acquireChatLock grants a free lock and blocks a live second holder",
    async () => {
      assert.equal(await acquireChatLock(UID, PID, "req-a"), true);
      assert.equal(await acquireChatLock(UID, PID, "req-b"), false);
      const lock = await chatLockRef(UID, PID).get();
      assert.equal(lock.get("activeRequestId"), "req-a");
    },
  ],
  [
    "an expired lock is stolen",
    async () => {
      await chatLockRef(UID, PID).set({
        activeRequestId: "old",
        expiresAt: Timestamp.fromMillis(Date.now() - 1000),
        renewedAt: Timestamp.fromMillis(Date.now() - 1000),
      });
      assert.equal(await acquireChatLock(UID, PID, "req-new"), true);
      const lock = await chatLockRef(UID, PID).get();
      assert.equal(lock.get("activeRequestId"), "req-new");
    },
  ],
  [
    "a stale (unrenewed) lock within TTL is stolen",
    async () => {
      await chatLockRef(UID, PID).set({
        activeRequestId: "old",
        expiresAt: Timestamp.fromMillis(Date.now() + 5 * 60_000),
        renewedAt: Timestamp.fromMillis(Date.now() - LOCK_STALE_MS - 5_000),
      });
      assert.equal(await acquireChatLock(UID, PID, "req-new"), true);
      const lock = await chatLockRef(UID, PID).get();
      assert.equal(lock.get("activeRequestId"), "req-new");
    },
  ],
  [
    "renewChatLock is a no-op for a non-owner and keeps ownership",
    async () => {
      await acquireChatLock(UID, PID, "req-a");
      const before = (await chatLockRef(UID, PID).get()).get("renewedAt");
      await renewChatLock(UID, PID, "req-b");
      const after = await chatLockRef(UID, PID).get();
      assert.equal(after.get("activeRequestId"), "req-a");
      assert.equal(
        (after.get("renewedAt") as Timestamp).toMillis(),
        (before as Timestamp).toMillis(),
      );
    },
  ],
  [
    "releaseChatLock deletes only for the owner",
    async () => {
      await acquireChatLock(UID, PID, "req-a");
      await releaseChatLock(UID, PID, "req-b");
      assert.equal((await chatLockRef(UID, PID).get()).exists, true);
      await releaseChatLock(UID, PID, "req-a");
      assert.equal((await chatLockRef(UID, PID).get()).exists, false);
    },
  ],
  [
    "concurrent acquire yields exactly one winner",
    async () => {
      // Four requests race for the same free lock doc; the transaction's
      // read-then-set must let exactly one through.
      const results = await Promise.all(
        ["r1", "r2", "r3", "r4"].map((id) => acquireChatLock(UID, PID, id)),
      );
      assert.equal(results.filter(Boolean).length, 1);
    },
  ],
];

export const suite: Suite = {name: "messages.service (emulator)", tests};
