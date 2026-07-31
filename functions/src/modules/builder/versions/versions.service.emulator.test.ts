// Emulator-backed tests for the atomic version commit and content-addressed
// blob storage (versions.service.ts): the transactional head+1 slot allocation
// with its concurrent-collision skip, the immutable blob upload, blob presence
// checks, and the delta rebase including platform-owned GHL client injection.
// Exported as a Suite, run by test/run-emulator.ts against the Firestore +
// Storage emulators with state cleared before each test. The pure helpers live
// in versions.service.test.ts.

import assert from "node:assert";
import {getStorage} from "firebase-admin/storage";
import {Test, Suite} from "../../../test/harness";
import {
  projectMessagesCollection,
  projectVersionsCollection,
  userProjectRef,
} from "../../../shared/firestore/refs";
import {AssistantMessageInput} from "../messages/messages.service";
import {GHL_CLIENT_SHA256} from "../../ghl/generated-client";
import {
  GHL_CLIENT_PATH,
  Manifest,
  commitAiVersionAndMessage,
  ensurePlatformFiles,
  fetchBlob,
  missingBlobs,
  readTree,
  rebaseOntoTree,
  sha256Hex,
  uploadBlobIfAbsent,
} from "./versions.service";

const UID = "ver-user";
const PID = "proj-1";

/**
 * Creates the project doc a commit requires.
 * @param {Record<string, unknown>} [extra] Extra fields to merge in.
 * @return {Promise<void>} Resolves once written.
 */
async function seedProject(extra: Record<string, unknown> = {}): Promise<void> {
  await userProjectRef(UID, PID).set({
    headVersion: 0, lastMessageSeq: 0, deleted: false, ...extra,
  });
}

/**
 * A minimal assistant message payload for a commit.
 * @return {AssistantMessageInput} The payload.
 */
function assistantInput(): AssistantMessageInput {
  return {
    content: "built it", status: "complete", files: [], questions: [],
    suggestions: [], versionN: null, contextTokens: 5, tokensConsumed: 5,
    costCents: 1, model: "m", requestId: "req", error: null,
  };
}

/**
 * Whether a content-addressed blob exists in the emulator bucket.
 * @param {string} hash The blob sha256.
 * @return {Promise<boolean>} True if present.
 */
async function blobExists(hash: string): Promise<boolean> {
  const [exists] = await getStorage()
    .bucket()
    .file(`${UID}/${PID}/${hash}`)
    .exists();
  return exists;
}

const tests: Test[] = [
  [
    "commit appends version head+1, advances head, and links the message",
    async () => {
      await seedProject();
      const res = await commitAiVersionAndMessage(
        UID, PID, {"src/App.jsx": "hash-a"}, "First build", assistantInput(),
      );
      assert.equal(res.n, 1);
      assert.equal(res.seq, 1);
      const proj = await userProjectRef(UID, PID).get();
      assert.equal(proj.get("headVersion"), 1);
      assert.equal(proj.get("lastMessageSeq"), 1);
      const version = await projectVersionsCollection(UID, PID).doc("1").get();
      assert.equal(version.get("source"), "ai");
      assert.deepEqual(version.get("tree"), {"src/App.jsx": "hash-a"});
      const msg = await projectMessagesCollection(UID, PID).doc(res.messageId)
        .get();
      assert.equal(msg.get("seq"), 1);
      assert.equal(msg.get("versionN"), 1);
    },
  ],
  [
    "commit skips a version slot already taken by a concurrent client commit",
    async () => {
      await seedProject();
      // Simulate a client having committed version 1 while head is still 0.
      await projectVersionsCollection(UID, PID).doc("1").set({
        n: 1, title: "client edit", source: "user", tree: {},
      });
      const res = await commitAiVersionAndMessage(
        UID, PID, {}, "AI build", assistantInput(),
      );
      assert.equal(res.n, 2);
      const proj = await userProjectRef(UID, PID).get();
      assert.equal(proj.get("headVersion"), 2);
    },
  ],
  [
    "commit throws when the project no longer exists",
    async () => {
      await assert.rejects(
        commitAiVersionAndMessage(UID, "missing", {}, "t", assistantInput()),
      );
    },
  ],
  [
    "uploadBlobIfAbsent is immutable — an existing hash is never overwritten",
    async () => {
      const hash = sha256Hex("original");
      await uploadBlobIfAbsent(UID, PID, hash, "original");
      assert.equal(await blobExists(hash), true);
      // Same hash, different content: the short-circuit must keep the original.
      await uploadBlobIfAbsent(UID, PID, hash, "tampered");
      assert.equal(await fetchBlob(UID, PID, hash), "original");
    },
  ],
  [
    "fetchBlob round-trips UTF-8 content",
    async () => {
      const content = "café 😀 — multibyte";
      const hash = sha256Hex(content);
      await uploadBlobIfAbsent(UID, PID, hash, content);
      assert.equal(await fetchBlob(UID, PID, hash), content);
    },
  ],
  [
    "readTree returns {} for version 0 and the stored tree otherwise",
    async () => {
      assert.deepEqual(await readTree(UID, PID, 0), {});
      await projectVersionsCollection(UID, PID).doc("3").set({
        n: 3, tree: {"a.js": "h1", "b.js": "h2"},
      });
      assert.deepEqual(await readTree(UID, PID, 3), {"a.js": "h1", "b.js": "h2"});
    },
  ],
  [
    "missingBlobs reports only the hashes absent from Storage",
    async () => {
      const present = sha256Hex("here");
      await uploadBlobIfAbsent(UID, PID, present, "here");
      const absent = sha256Hex("gone");
      assert.deepEqual(
        await missingBlobs(UID, PID, [present, absent, absent]), [absent]);
      assert.deepEqual(await missingBlobs(UID, PID, []), []);
    },
  ],
  [
    "ensurePlatformFiles uploads the GHL client for a never-committed project",
    async () => {
      // The preview of a first generation reads this straight from Storage, so
      // returning the path without the blob present would still fail to bundle.
      assert.equal(await blobExists(GHL_CLIENT_SHA256), false);
      const files = await ensurePlatformFiles(UID, PID, {});
      assert.deepEqual(files, [
        {path: GHL_CLIENT_PATH, hash: GHL_CLIENT_SHA256},
      ]);
      assert.equal(await blobExists(GHL_CLIENT_SHA256), true);
    },
  ],
  [
    "ensurePlatformFiles is a no-op once the tree has the current client",
    async () => {
      const current: Manifest = {[GHL_CLIENT_PATH]: GHL_CLIENT_SHA256};
      assert.deepEqual(await ensurePlatformFiles(UID, PID, current), []);
      // An outdated copy still needs replacing.
      const stale: Manifest = {[GHL_CLIENT_PATH]: sha256Hex("old client")};
      assert.equal((await ensurePlatformFiles(UID, PID, stale)).length, 1);
    },
  ],
  [
    "rebaseOntoTree applies a hash delta and injects the GHL client",
    async () => {
      const hash = sha256Hex("the code");
      await uploadBlobIfAbsent(UID, PID, hash, "the code");
      const tree = await rebaseOntoTree(
        UID, PID, {}, new Map([["src/App.jsx", hash]]), new Set(),
      );
      assert.equal(tree["src/App.jsx"], hash);
      assert.equal(tree[GHL_CLIENT_PATH], GHL_CLIENT_SHA256);
      assert.equal(await blobExists(GHL_CLIENT_SHA256), true);
      assert.equal(await fetchBlob(UID, PID, tree["src/App.jsx"] as string),
        "the code");
    },
  ],
  [
    "rebaseOntoTree keeps head files the variant never touched",
    async () => {
      // The delta is rebased, not a snapshot: a manual commit made while the
      // user was choosing between variants must survive.
      const head: Manifest = {
        "kept.js": "hash-kept",
        "old.js": "hash-old",
        [GHL_CLIENT_PATH]: GHL_CLIENT_SHA256,
      };
      const tree = await rebaseOntoTree(
        UID, PID, head, new Map([["new.js", sha256Hex("x")]]),
        new Set(["old.js"]),
      );
      assert.equal(tree["kept.js"], "hash-kept");
      assert.equal("old.js" in tree, false);
      assert.equal(tree["new.js"], sha256Hex("x"));
      assert.equal(tree[GHL_CLIENT_PATH], GHL_CLIENT_SHA256);
    },
  ],
  [
    "rebaseOntoTree drops an attempt to overwrite the GHL client",
    async () => {
      const head: Manifest = {[GHL_CLIENT_PATH]: GHL_CLIENT_SHA256};
      const tree = await rebaseOntoTree(
        UID, PID, head,
        new Map([[GHL_CLIENT_PATH, sha256Hex("malicious override")]]),
        new Set(),
      );
      // The protected path keeps the platform hash.
      assert.equal(tree[GHL_CLIENT_PATH], GHL_CLIENT_SHA256);
    },
  ],
];

export const suite: Suite = {name: "versions.service (emulator)", tests};
