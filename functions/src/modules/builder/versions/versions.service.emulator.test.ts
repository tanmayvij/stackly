// Emulator-backed tests for the atomic version commit and content-addressed
// blob storage (versions.service.ts): the transactional head+1 slot allocation
// with its concurrent-collision skip, and the immutable blob upload / tree
// application including platform-owned GHL client injection. Exported as a
// Suite, run by test/run-emulator.ts against the Firestore + Storage emulators
// with state cleared before each test. The pure hash lives in
// versions.service.test.ts.

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
  applyResponseToTree,
  commitAiVersionAndMessage,
  fetchBlob,
  readTree,
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
    "applyResponseToTree uploads new blobs and injects the GHL client",
    async () => {
      const tree = await applyResponseToTree(
        UID, PID, {}, new Map([["src/App.jsx", "the code"]]), new Set(),
      );
      assert.equal(tree["src/App.jsx"], sha256Hex("the code"));
      assert.equal(tree[GHL_CLIENT_PATH], GHL_CLIENT_SHA256);
      assert.equal(await blobExists(sha256Hex("the code")), true);
      assert.equal(await blobExists(GHL_CLIENT_SHA256), true);
      assert.equal(await fetchBlob(UID, PID, tree["src/App.jsx"] as string),
        "the code");
    },
  ],
  [
    "applyResponseToTree applies deletes and leaves a current GHL client alone",
    async () => {
      const head: Manifest = {
        "old.js": "hash-old", [GHL_CLIENT_PATH]: GHL_CLIENT_SHA256,
      };
      const tree = await applyResponseToTree(
        UID, PID, head, new Map(), new Set(["old.js"]),
      );
      assert.equal("old.js" in tree, false);
      assert.equal(tree[GHL_CLIENT_PATH], GHL_CLIENT_SHA256);
    },
  ],
  [
    "applyResponseToTree drops a model attempt to overwrite the GHL client",
    async () => {
      const head: Manifest = {[GHL_CLIENT_PATH]: GHL_CLIENT_SHA256};
      const tree = await applyResponseToTree(
        UID, PID, head, new Map([[GHL_CLIENT_PATH, "malicious override"]]),
        new Set(),
      );
      // The protected path keeps the platform hash, not the model's content.
      assert.equal(tree[GHL_CLIENT_PATH], GHL_CLIENT_SHA256);
      assert.notEqual(tree[GHL_CLIENT_PATH], sha256Hex("malicious override"));
    },
  ],
];

export const suite: Suite = {name: "versions.service (emulator)", tests};
