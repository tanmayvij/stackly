// Self-running unit tests for the stateless preview-token HMAC in
// preview.service.ts. Run with plain Node: `node lib/modules/preview/
// preview.service.test.js`. The token secret is read from
// process.env.PREVIEW_TOKEN_SECRET (via defineSecret(...).value()), so it is
// set below before any token is minted or verified.

import assert from "node:assert";
import {createHmac} from "node:crypto";
import {Test, main} from "../../test/harness";
import {mintToken, verifyPreviewToken} from "./preview.service";

// mint/verify read PREVIEW_TOKEN_SECRET lazily (via defineSecret(...).value())
// only when called, so setting it here — after the module import — is in time
// for every test below.
const SECRET = "test-preview-secret-please-ignore-0123456789";
process.env.PREVIEW_TOKEN_SECRET = SECRET;

/**
 * Hand-builds a token for an arbitrary payload, signed with the same secret,
 * so tests can forge expired / wrong-version / malformed payloads that
 * mintToken would never produce.
 * @param {object} payload The token payload object.
 * @return {string} A `<b64url-payload>.<b64url-sig>` token.
 */
function makeToken(payload: object): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  const sig = createHmac("sha256", SECRET).update(encoded).digest("base64url");
  return `${encoded}.${sig}`;
}

const nowSec = () => Math.floor(Date.now() / 1000);

const TESTS: Test[] = [
  [
    "a freshly minted token round-trips to its uid",
    () => {
      const before = Date.now();
      const {token, expiresAtMs} = mintToken("user-123");
      assert.deepEqual(verifyPreviewToken(token), {uid: "user-123"});
      // TTL is 30 minutes; expiry is comfortably in the future.
      assert.ok(expiresAtMs > before + 25 * 60_000);
    },
  ],
  [
    "a tampered signature is rejected",
    () => {
      const {token} = mintToken("user-123");
      const last = token.slice(-1) === "A" ? "B" : "A";
      const tampered = token.slice(0, -1) + last;
      assert.equal(verifyPreviewToken(tampered), null);
    },
  ],
  [
    "a tampered payload (valid-looking, wrong signature) is rejected",
    () => {
      const {token} = mintToken("user-123");
      const dot = token.indexOf(".");
      const encoded = token.slice(0, dot);
      const flipped =
        (encoded[0] === "a" ? "b" : "a") + encoded.slice(1) + token.slice(dot);
      assert.equal(verifyPreviewToken(flipped), null);
    },
  ],
  [
    "structurally invalid tokens are rejected",
    () => {
      assert.equal(verifyPreviewToken(""), null);
      assert.equal(verifyPreviewToken("no-dot-here"), null);
      assert.equal(verifyPreviewToken(".leadingdot"), null);
    },
  ],
  [
    "a signature of the wrong length is rejected (never compared unequally)",
    () => {
      const {token} = mintToken("user-123");
      const encoded = token.slice(0, token.indexOf("."));
      assert.equal(verifyPreviewToken(`${encoded}.AAAA`), null);
    },
  ],
  [
    "a token with an unknown version is rejected",
    () => {
      const token = makeToken({v: 99, uid: "user-123", exp: nowSec() + 600});
      assert.equal(verifyPreviewToken(token), null);
    },
  ],
  [
    "a token with a non-string uid is rejected",
    () => {
      const token = makeToken({v: 1, uid: 123, exp: nowSec() + 600});
      assert.equal(verifyPreviewToken(token), null);
    },
  ],
  [
    "a well-signed but expired token reports \"expired\", not null",
    () => {
      const token = makeToken({v: 1, uid: "user-123", exp: nowSec() - 10});
      assert.equal(verifyPreviewToken(token), "expired");
    },
  ],
  [
    "a well-signed, unexpired forged token verifies to its uid",
    () => {
      const token = makeToken({v: 1, uid: "user-xyz", exp: nowSec() + 600});
      assert.deepEqual(verifyPreviewToken(token), {uid: "user-xyz"});
    },
  ],
];

void main("preview token HMAC (pure)", TESTS);
