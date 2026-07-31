// Self-running unit tests for the pure helpers in versions.service.ts: the
// content-addressing hash and the version-title derivation. `sha256Hex` MUST
// match the frontend `sha256` (stackly-frontend/src/lib/builder-repo.ts) or
// blobs written by the server and the client would land at different paths.
// Run with plain Node:
// `node lib/modules/builder/versions/versions.service.test.js`. The Storage
// and Firestore paths (upload/commit/rebase) live in the emulator test.

import assert from "node:assert";
import {Test, main} from "../../../test/harness";
import {HistoryMessage} from "../messages/messages.service";
import {sha256Hex, versionTitle} from "./versions.service";

/**
 * Minimal HistoryMessage builder for versionTitle (which only reads role and
 * content).
 * @param {"user" | "assistant" | "system"} role The turn role.
 * @param {string} content The turn text.
 * @return {HistoryMessage} A message with defaults for the unused fields.
 */
function turn(
  role: "user" | "assistant" | "system",
  content: string,
): HistoryMessage {
  return {
    id: "id",
    kind: "chat",
    role,
    seq: 0,
    content,
    files: [],
    questions: [],
    status: null,
    contextTokens: 0,
    compactedThroughSeq: 0,
  };
}

const TESTS: Test[] = [
  [
    "hashes the empty string to the canonical SHA-256 vector",
    () => {
      assert.equal(
        sha256Hex(""),
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      );
    },
  ],
  [
    "hashes a plain ASCII string to its known vector",
    () => {
      assert.equal(
        sha256Hex("hello"),
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      );
    },
  ],
  [
    "hashes UTF-8 multibyte text over its byte encoding (accented char)",
    () => {
      assert.equal(
        sha256Hex("café"),
        "850f7dc43910ff890f8879c0ed26fe697c93a067ad93a7d50f466a7028a9bf4e",
      );
    },
  ],
  [
    "hashes text containing an astral-plane emoji consistently",
    () => {
      assert.equal(
        sha256Hex("a😀b"),
        "6fba5b2ea783ded096fc2444d540ffbdf49168df30993b155b7efb683313f110",
      );
    },
  ],
  [
    "is a lowercase 64-char hex digest and is deterministic",
    () => {
      const a = sha256Hex("determinism check");
      const b = sha256Hex("determinism check");
      assert.equal(a, b);
      assert.match(a, /^[0-9a-f]{64}$/);
    },
  ],
  [
    "versionTitle uses the last user turn, collapsing whitespace",
    () => {
      const title = versionTitle([
        turn("user", "first request"),
        turn("assistant", "did it"),
        turn("user", "add   a\nsearch\tbox"),
      ]);
      assert.equal(title, "add a search box");
    },
  ],
  [
    "versionTitle truncates a long title to 57 chars + ellipsis",
    () => {
      const long = "a".repeat(80);
      const title = versionTitle([turn("user", long)]);
      assert.equal(title.length, 60);
      assert.equal(title, "a".repeat(57) + "...");
    },
  ],
  [
    "versionTitle skips blank user turns and falls back to \"AI update\"",
    () => {
      assert.equal(
        versionTitle([turn("assistant", "no user here")]), "AI update");
      assert.equal(versionTitle([turn("user", "   ")]), "AI update");
      assert.equal(versionTitle([]), "AI update");
    },
  ],
];

void main("versions.service pure helpers", TESTS);
