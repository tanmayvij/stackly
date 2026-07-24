// Self-running unit tests for the pure/near-pure parts of ghl.service.ts:
// scopeCount (pure), and requestGhlToken / fetchLocationName with the global
// `fetch` stubbed (no network, no emulator). Run with plain Node:
// `node lib/modules/ghl/ghl.service.test.js`.

import assert from "node:assert";
import {Test, main} from "../../test/harness";
import {
  fetchLocationName,
  requestGhlToken,
  scopeCount,
} from "./ghl.service";

// requestGhlToken reads these lazily via defineSecret(...).value(); set after
// the import so the calls below see them.
process.env.GHL_CLIENT_ID = "test-client-id";
process.env.GHL_CLIENT_SECRET = "test-client-secret";

type FetchFn = typeof globalThis.fetch;

/**
 * Builds a minimal Response-like object good enough for the code under test
 * (which only touches `ok`, `status`, `json()`, and `text()`).
 * @param {number} status The HTTP status code.
 * @param {unknown} body The JSON body to return from json().
 * @return {Response} A fake response.
 */
function fakeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/**
 * Runs `fn` with `globalThis.fetch` replaced by `fake`, restoring it after.
 * @param {FetchFn} fake The stub fetch implementation.
 * @param {function(): Promise<void>} fn The test body.
 * @return {Promise<void>} Resolves when the body settles.
 */
async function withFetch(fake: FetchFn, fn: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = fake;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
}

/**
 * Asserts that `p` rejects with an HttpsError carrying the given code.
 * @param {Promise<unknown>} p The promise expected to reject.
 * @param {string} code The expected HttpsError `code`.
 * @return {Promise<void>} Resolves once verified.
 */
async function rejectsWithCode(p: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(p, (err: unknown) => {
    assert.equal((err as {code?: string}).code, code);
    return true;
  });
}

const TESTS: Test[] = [
  [
    "scopeCount counts space-separated scopes and ignores extra whitespace",
    () => {
      assert.equal(scopeCount(""), 0);
      assert.equal(scopeCount("   "), 0);
      assert.equal(scopeCount("contacts.readonly"), 1);
      assert.equal(
        scopeCount("contacts.readonly conversations.write calendars.readonly"),
        3,
      );
      assert.equal(scopeCount("  a   b  c  "), 3);
    },
  ],
  [
    "requestGhlToken requires code+redirectUri for the authorization_code grant",
    async () => {
      await rejectsWithCode(
        requestGhlToken({grantType: "authorization_code"}),
        "invalid-argument",
      );
    },
  ],
  [
    "requestGhlToken requires refreshToken for the refresh_token grant",
    async () => {
      await rejectsWithCode(
        requestGhlToken({grantType: "refresh_token"}),
        "invalid-argument",
      );
    },
  ],
  [
    "requestGhlToken maps a 4xx to invalid-argument and surfaces the message",
    async () => {
      await withFetch(
        async () => fakeResponse(400, {message: "bad or expired code"}),
        async () => {
          await assert.rejects(
            requestGhlToken({
              grantType: "authorization_code",
              code: "c",
              redirectUri: "https://app/cb",
            }),
            (err: unknown) => {
              const e = err as {code?: string; message?: string};
              assert.equal(e.code, "invalid-argument");
              assert.match(String(e.message), /bad or expired code/);
              return true;
            },
          );
        },
      );
    },
  ],
  [
    "requestGhlToken maps a 5xx to internal",
    async () => {
      await withFetch(
        async () => fakeResponse(503, {}),
        async () => {
          await rejectsWithCode(
            requestGhlToken({grantType: "refresh_token", refreshToken: "r"}),
            "internal",
          );
        },
      );
    },
  ],
  [
    "requestGhlToken returns the parsed body on success",
    async () => {
      const token = {
        accessToken: "at",
        refreshToken: "rt",
        expiresIn: 3600,
        scope: "contacts.readonly",
        userType: "Location",
        locationId: "loc-1",
        userId: "u-1",
      };
      await withFetch(
        async () => fakeResponse(200, token),
        async () => {
          const got = await requestGhlToken({
            grantType: "authorization_code",
            code: "c",
            redirectUri: "https://app/cb",
          });
          assert.deepEqual(got, token);
        },
      );
    },
  ],
  [
    "fetchLocationName returns the resolved name on success",
    async () => {
      await withFetch(
        async () => fakeResponse(200, {location: {name: "Acme HQ"}}),
        async () => {
          assert.equal(await fetchLocationName("at", "loc-1"), "Acme HQ");
        },
      );
    },
  ],
  [
    "fetchLocationName falls back to the id on a non-ok response",
    async () => {
      await withFetch(
        async () => fakeResponse(404, {}),
        async () => {
          assert.equal(await fetchLocationName("at", "loc-1"), "loc-1");
        },
      );
    },
  ],
  [
    "fetchLocationName falls back to the id when fetch throws",
    async () => {
      await withFetch(
        async () => {
          throw new Error("network down");
        },
        async () => {
          assert.equal(await fetchLocationName("at", "loc-1"), "loc-1");
        },
      );
    },
  ],
];

void main("ghl.service (pure + stubbed fetch)", TESTS);
