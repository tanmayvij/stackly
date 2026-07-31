// Self-running unit tests for the pure input validation in
// variants.service.ts. These payloads come from the client — it holds the
// variant file contents in memory and hands back a hash delta — so the checks
// here are the trust boundary for what can enter a committed version.
// Run with plain Node:
// `node lib/modules/builder/variants/variants.service.test.js`.
// The Firestore/Storage paths (apply, discard, idempotency) live in
// variants.service.emulator.test.ts.

import assert from "node:assert";
import {Test, main} from "../../../test/harness";
import {
  DEFAULT_VERSION_TITLE,
  MAX_PROMPT_CHARS,
  MAX_VARIANT_FILES,
  MAX_VARIANT_PATH_CHARS,
  MAX_VARIANT_SUMMARY_CHARS,
  MAX_VERSION_TITLE_CHARS,
} from "../../../shared/config";
import {parseTurnPayload, parseVariantDelta} from "./variants.service";

const HASH = "a".repeat(64);
const HASH_B = "b".repeat(64);

/**
 * Asserts the call rejects with an invalid-argument HttpsError (matched on the
 * `code`, since HttpsError's string form only carries the human message).
 * @param {Function} fn The call to make.
 * @param {string} label What is being rejected.
 */
function rejects(fn: () => unknown, label: string): void {
  assert.throws(
    fn,
    (err: unknown) =>
      (err as {code?: string})?.code === "invalid-argument",
    label,
  );
}

const TESTS: Test[] = [
  [
    "accepts a write + delete delta and normalizes the paths",
    () => {
      const delta = parseVariantDelta(
        [{path: "./src/App.jsx", hash: HASH}, {path: "src\\lib\\x.js", hash: HASH_B}],
        ["/src/Old.jsx"],
      );
      assert.deepEqual(
        [...delta.writes.entries()],
        [["src/App.jsx", HASH], ["src/lib/x.js", HASH_B]],
      );
      assert.deepEqual([...delta.deletes], ["src/Old.jsx"]);
    },
  ],
  [
    "a path written and deleted resolves to the write",
    () => {
      const delta = parseVariantDelta(
        [{path: "a.js", hash: HASH}],
        ["a.js", "b.js"],
      );
      assert.equal(delta.writes.get("a.js"), HASH);
      assert.deepEqual([...delta.deletes], ["b.js"]);
    },
  ],
  [
    "rejects an empty delta",
    () => {
      rejects(() => parseVariantDelta([], []), "both empty");
      rejects(() => parseVariantDelta(undefined, undefined), "both missing");
      rejects(() => parseVariantDelta("nope", null), "wrong types");
    },
  ],
  [
    "rejects more files than the per-variant cap",
    () => {
      const many = Array.from({length: MAX_VARIANT_FILES + 1}, (_, i) => ({
        path: `f${i}.js`,
        hash: HASH,
      }));
      rejects(() => parseVariantDelta(many, []), "over the cap");
    },
  ],
  [
    "rejects traversal, absolute-only, and over-long paths",
    () => {
      rejects(() => parseVariantDelta([{path: "../evil.js", hash: HASH}], []),
        "traversal write");
      rejects(() => parseVariantDelta([{path: "a/../b.js", hash: HASH}], []),
        "embedded traversal");
      rejects(() => parseVariantDelta([{path: "/", hash: HASH}], []),
        "root only");
      rejects(() => parseVariantDelta([], ["../evil.js"]),
        "traversal delete");
      rejects(
        () => parseVariantDelta(
          [{path: "x".repeat(MAX_VARIANT_PATH_CHARS + 1), hash: HASH}], []),
        "over-long path");
    },
  ],
  [
    "rejects any attempt to touch the protected GHL client",
    () => {
      rejects(
        () => parseVariantDelta([{path: "src/lib/ghl.js", hash: HASH}], []),
        "write ghl.js");
      rejects(
        () => parseVariantDelta([{path: "./src/lib/ghl.js", hash: HASH}], []),
        "write ghl.js via ./");
      rejects(() => parseVariantDelta([], ["src/lib/ghl.js"]),
        "delete ghl.js");
    },
  ],
  [
    "rejects malformed hashes",
    () => {
      // Anything but a lowercase 64-hex digest: a bad hash would commit a
      // version pointing at a blob that can never be fetched.
      for (const hash of ["", "abc", HASH.toUpperCase(), HASH + "a", 42, null]) {
        rejects(
          () => parseVariantDelta([{path: "a.js", hash}], []),
          `hash ${String(hash)}`,
        );
      }
    },
  ],
  [
    "turn payload trims, defaults, and rejects over-long text",
    () => {
      const payload = parseTurnPayload({
        reply: "  Built it.  ",
        summary: "  Table view  ",
      });
      assert.equal(payload.reply, "Built it.");
      assert.equal(payload.summary, "Table view");
      assert.deepEqual(payload.questions, []);
      assert.deepEqual(payload.suggestions, []);

      const empty = parseTurnPayload({});
      assert.equal(empty.reply, "");
      assert.equal(empty.summary, "");

      rejects(
        () => parseTurnPayload({reply: "x".repeat(MAX_PROMPT_CHARS + 1)}),
        "over-long reply");
      // Bounded by the same clamp the parser applies to model output.
      assert.equal(
        parseTurnPayload({summary: "x".repeat(MAX_VARIANT_SUMMARY_CHARS)})
          .summary.length,
        MAX_VARIANT_SUMMARY_CHARS);
      rejects(
        () => parseTurnPayload({
          summary: "x".repeat(MAX_VARIANT_SUMMARY_CHARS + 1),
        }),
        "over-long summary");
    },
  ],
  [
    "turn payload normalizes the version title and falls back",
    () => {
      assert.equal(
        parseTurnPayload({title: "  add   a\nsearch\tbox  "}).title,
        "add a search box");
      // Same length versionTitle truncates to, from the same constant.
      assert.equal(
        parseTurnPayload({title: "x".repeat(MAX_VERSION_TITLE_CHARS + 20)}).title,
        "x".repeat(MAX_VERSION_TITLE_CHARS));
      assert.equal(parseTurnPayload({}).title, DEFAULT_VERSION_TITLE);
      assert.equal(parseTurnPayload({title: "   "}).title, DEFAULT_VERSION_TITLE);
    },
  ],
  [
    "turn payload validates baseVersion",
    () => {
      assert.equal(parseTurnPayload({baseVersion: 7}).baseVersion, 7);
      // Absent means 0, which only skips the conflict check when head is 0 too.
      assert.equal(parseTurnPayload({}).baseVersion, 0);
      for (const baseVersion of [-1, 1.5, "3", null, {}]) {
        rejects(
          () => parseTurnPayload({baseVersion}),
          `baseVersion ${String(baseVersion)}`,
        );
      }
    },
  ],
  [
    "turn payload keeps well-formed questions and skips the rest",
    () => {
      const payload = parseTurnPayload({
        questions: [
          {text: " Which period? ", choices: ["Today", "Week", "Month", "Year"]},
          {text: "Too few choices", choices: ["A", "B"]},
          {text: "", choices: ["A", "B", "C"]},
          {text: "Second valid", choices: ["A", "B", "C"]},
          {text: "Third valid is over the cap", choices: ["A", "B", "C"]},
        ],
      });
      assert.equal(payload.questions.length, 2);
      assert.deepEqual(payload.questions[0], {
        text: "Which period?",
        choices: ["Today", "Week", "Month"],
      });
      assert.equal(payload.questions[1]?.text, "Second valid");
    },
  ],
  [
    "turn payload keeps at most two well-formed suggestions",
    () => {
      const payload = parseTurnPayload({
        suggestions: [
          {label: " Add search ", prompt: " Add a search box "},
          {label: "No prompt"},
          {label: "B", prompt: "b"},
          {label: "C", prompt: "c"},
        ],
      });
      assert.deepEqual(payload.suggestions, [
        {label: "Add search", prompt: "Add a search box"},
        {label: "B", prompt: "b"},
      ]);
    },
  ],
];

void main("variants.service validation (pure)", TESTS);
