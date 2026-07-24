// Self-running unit tests for the pure path-allowlist guard extracted from the
// GHL proxy. This is the proxy's primary surface restriction, so its allow/deny
// boundaries are worth pinning down. Run with plain Node:
// `node lib/modules/ghl/proxy.controller.test.js`.

import assert from "node:assert";
import {Test, main} from "../../test/harness";
import {isAllowedGhlPath} from "./proxy.controller";

const TESTS: Test[] = [
  [
    "allows the three permitted API families with and without a subpath",
    () => {
      for (const p of [
        "/contacts",
        "/contacts/",
        "/contacts/abc123",
        "/conversations",
        "/conversations/xyz",
        "/calendars",
        "/calendars/evt-1",
      ]) {
        assert.equal(isAllowedGhlPath(p), true, p);
      }
    },
  ],
  [
    "denies unlisted families, the root, and near-miss prefixes",
    () => {
      for (const p of [
        "",
        "/",
        "/locations",
        "/locations/loc-1",
        "/billing",
        "/contactss",
        "/contacts-extra",
        "/conversationsx",
      ]) {
        assert.equal(isAllowedGhlPath(p), false, p);
      }
    },
  ],
  [
    "is case-sensitive (only lowercase families are allowed)",
    () => {
      assert.equal(isAllowedGhlPath("/Contacts"), false);
      assert.equal(isAllowedGhlPath("/CONTACTS/1"), false);
    },
  ],
  [
    "rejects any path containing a traversal segment",
    () => {
      assert.equal(isAllowedGhlPath("/contacts/.."), false);
      assert.equal(isAllowedGhlPath("/contacts/../secrets"), false);
      assert.equal(isAllowedGhlPath("/calendars/..%2f"), false);
    },
  ],
];

void main("ghl proxy path allowlist (pure)", TESTS);
