// Self-running unit tests for the pure content-addressing hash in
// versions.service.ts. `sha256Hex` MUST match the frontend `sha256`
// (stackly-frontend/src/lib/builder-repo.ts) or blobs written by the server
// and the client would land at different paths. Run with plain Node:
// `node lib/modules/builder/versions/versions.service.test.js`. The Storage
// and Firestore paths (upload/commit) live in the emulator test.

import assert from "node:assert";
import {Test, main} from "../../../test/harness";
import {sha256Hex} from "./versions.service";

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
];

void main("versions.service sha256Hex (pure)", TESTS);
