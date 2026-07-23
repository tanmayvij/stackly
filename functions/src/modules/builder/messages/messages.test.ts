// Self-running unit tests for the pure conversation-resolution logic in
// messages.service.ts. Run with plain Node (no framework):
// `node lib/modules/builder/messages/messages.test.js`. Exits non-zero on the
// first failure. The persistence paths (writeMessage, locks) run inside
// Firestore transactions and belong in an emulator-backed test, not here.

import assert from "node:assert";
import {HistoryMessage, effectiveHistory} from "./messages.service";

/**
 * Builds a HistoryMessage with sensible defaults for the fields
 * effectiveHistory ignores, overridden by `partial`.
 * @param {Partial<HistoryMessage>} partial The fields under test.
 * @return {HistoryMessage} A complete message.
 */
function msg(partial: Partial<HistoryMessage>): HistoryMessage {
  return {
    id: partial.id ?? "id",
    kind: partial.kind ?? "chat",
    role: partial.role ?? "user",
    seq: partial.seq ?? 0,
    content: partial.content ?? "",
    files: partial.files ?? [],
    questions: partial.questions ?? [],
    status: partial.status ?? null,
    contextTokens: partial.contextTokens ?? 0,
    compactedThroughSeq: partial.compactedThroughSeq ?? 0,
  };
}

const TESTS: Array<[string, () => void]> = [
  [
    "no summary returns every chat turn and a null summary",
    () => {
      const all = [
        msg({seq: 1, kind: "chat"}),
        msg({seq: 2, kind: "chat"}),
        msg({seq: 3, kind: "chat"}),
      ];
      const {summary, turns} = effectiveHistory(all);
      assert.equal(summary, null);
      assert.deepEqual(turns.map((t) => t.seq), [1, 2, 3]);
    },
  ],
  [
    "a summary keeps only turns after its cutoff and excludes itself",
    () => {
      const all = [
        msg({seq: 1, kind: "chat"}),
        msg({seq: 2, kind: "chat"}),
        msg({seq: 3, kind: "summary", compactedThroughSeq: 2}),
        msg({seq: 4, kind: "chat"}),
        msg({seq: 5, kind: "chat"}),
      ];
      const {summary, turns} = effectiveHistory(all);
      assert.equal(summary?.seq, 3);
      assert.deepEqual(turns.map((t) => t.seq), [4, 5]);
    },
  ],
  [
    "the turn at exactly the cutoff seq is excluded; cutoff+1 is included",
    () => {
      const all = [
        msg({seq: 2, kind: "chat"}),
        msg({seq: 3, kind: "summary", compactedThroughSeq: 2}),
      ];
      const {turns} = effectiveHistory(all);
      // seq 2 == cutoff -> dropped; nothing at cutoff+1 -> empty.
      assert.deepEqual(turns.map((t) => t.seq), []);

      const withBoundary = [
        msg({seq: 2, kind: "chat"}),
        msg({seq: 3, kind: "summary", compactedThroughSeq: 2}),
        msg({seq: 3, kind: "chat"}),
      ];
      const r = effectiveHistory(withBoundary);
      assert.deepEqual(r.turns.map((t) => t.seq), [3]);
    },
  ],
  [
    "the newest summary wins when several exist",
    () => {
      const all = [
        msg({seq: 1, kind: "chat"}),
        msg({seq: 2, kind: "summary", compactedThroughSeq: 1}),
        msg({seq: 3, kind: "chat"}),
        msg({seq: 4, kind: "chat"}),
        msg({seq: 5, kind: "summary", compactedThroughSeq: 4}),
        msg({seq: 6, kind: "chat"}),
      ];
      const {summary, turns} = effectiveHistory(all);
      assert.equal(summary?.seq, 5);
      // Only the last summary's cutoff (4) applies; older summary ignored.
      assert.deepEqual(turns.map((t) => t.seq), [6]);
    },
  ],
  [
    "summary markers are never returned as turns",
    () => {
      const all = [
        msg({seq: 1, kind: "summary", compactedThroughSeq: 0}),
        msg({seq: 2, kind: "chat"}),
      ];
      const {turns} = effectiveHistory(all);
      assert.ok(turns.every((t) => t.kind === "chat"));
      assert.deepEqual(turns.map((t) => t.seq), [2]);
    },
  ],
  [
    "empty history yields no summary and no turns",
    () => {
      const {summary, turns} = effectiveHistory([]);
      assert.equal(summary, null);
      assert.deepEqual(turns, []);
    },
  ],
];

let failed = 0;
for (const [name, fn] of TESTS) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL - ${name}`);
    console.error(err);
  }
}
if (failed > 0) {
  console.error(`${failed}/${TESTS.length} tests failed`);
  process.exit(1);
}
console.log(`all ${TESTS.length} tests passed`);
