// Server-side port of the builder's mini-git repo
// (stackly-frontend/src/lib/builder-repo.ts): content-addressed blobs in
// Storage at `{uid}/{projectId}/{sha256}` plus immutable version snapshots
// in Firestore. Writes go through the Admin SDK, bypassing the client
// security rules exactly as those rules anticipate for AI commits.

import {createHash} from "node:crypto";
import {FieldValue, getFirestore} from "firebase-admin/firestore";
import {getStorage} from "firebase-admin/storage";
import {GHL_CLIENT_SHA256, GHL_CLIENT_SOURCE} from "./ghl-docs";
import {AssistantMessageInput, assistantMessageData} from "./messages";

/** Flat file tree: full path → blob sha256. `null` marks an empty folder. */
export type Manifest = Record<string, string | null>;

export const GHL_CLIENT_PATH = "src/lib/ghl.js";

/**
 * Hex SHA-256 of a text blob — must match the frontend's `sha256`.
 * @param {string} text The blob content.
 * @return {string} The lowercase hex digest.
 */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Returns the Storage object for one content-addressed blob.
 * @param {string} uid The owner's uid.
 * @param {string} projectId The project id.
 * @param {string} hash The blob's sha256.
 * @return {object} The Storage file handle.
 */
function blobFile(uid: string, projectId: string, hash: string) {
  return getStorage().bucket().file(`${uid}/${projectId}/${hash}`);
}

/**
 * Uploads a blob unless an object with the same hash already exists
 * (blobs are immutable, so an existing object is always identical).
 * @param {string} uid The owner's uid.
 * @param {string} projectId The project id.
 * @param {string} hash The blob's sha256.
 * @param {string} content The blob content.
 * @return {Promise<void>} Resolves once present.
 */
export async function uploadBlobIfAbsent(
  uid: string,
  projectId: string,
  hash: string,
  content: string,
): Promise<void> {
  const file = blobFile(uid, projectId, hash);
  const [exists] = await file.exists();
  if (exists) return;
  await file.save(content, {
    resumable: false,
    contentType: "text/plain; charset=utf-8",
  });
}

/**
 * Downloads one blob as UTF-8 text.
 * @param {string} uid The owner's uid.
 * @param {string} projectId The project id.
 * @param {string} hash The blob's sha256.
 * @return {Promise<string>} The blob content.
 */
export async function fetchBlob(
  uid: string,
  projectId: string,
  hash: string,
): Promise<string> {
  const [buf] = await blobFile(uid, projectId, hash).download();
  return buf.toString("utf8");
}

/**
 * Returns the manifest of a given version (version 0 = empty project).
 * @param {string} uid The owner's uid.
 * @param {string} projectId The project id.
 * @param {number} n The version number.
 * @return {Promise<Manifest>} The version's file tree.
 */
export async function readTree(
  uid: string,
  projectId: string,
  n: number,
): Promise<Manifest> {
  if (n <= 0) return {};
  const snap = await getFirestore()
    .collection("users")
    .doc(uid)
    .collection("projects")
    .doc(projectId)
    .collection("versions")
    .doc(String(n))
    .get();
  return (snap.get("tree") as Manifest | undefined) ?? {};
}

/**
 * Applies the model's writes/deletes to the head tree, uploading new blobs
 * and injecting the platform-owned GHL client when missing or outdated.
 * @param {string} uid The owner's uid.
 * @param {string} projectId The project id.
 * @param {Manifest} head The current head manifest.
 * @param {Map<string, string>} writes path → full new content.
 * @param {Set<string>} deletes Paths to remove.
 * @return {Promise<Manifest>} The new manifest, ready to commit.
 */
export async function applyResponseToTree(
  uid: string,
  projectId: string,
  head: Manifest,
  writes: Map<string, string>,
  deletes: Set<string>,
): Promise<Manifest> {
  const tree: Manifest = {...head};
  for (const path of deletes) delete tree[path];
  for (const [path, content] of writes) {
    const hash = sha256Hex(content);
    await uploadBlobIfAbsent(uid, projectId, hash, content);
    tree[path] = hash;
  }
  if (tree[GHL_CLIENT_PATH] !== GHL_CLIENT_SHA256) {
    await uploadBlobIfAbsent(
      uid,
      projectId,
      GHL_CLIENT_SHA256,
      GHL_CLIENT_SOURCE,
    );
    tree[GHL_CLIENT_PATH] = GHL_CLIENT_SHA256;
  }
  return tree;
}

export interface CommitResult {
  n: number;
  messageId: string;
  seq: number;
}

/**
 * Atomically appends the AI version at `headVersion + 1` (skipping slots a
 * concurrent client commit already took), advances the project head, and
 * creates the assistant message doc that references the new version. A
 * version can never exist without its message or vice versa.
 * @param {string} uid The owner's uid.
 * @param {string} projectId The project id.
 * @param {Manifest} tree The new manifest to commit.
 * @param {string} title The version title.
 * @param {AssistantMessageInput} message The assistant message fields.
 * @return {Promise<CommitResult>} The version number, message id and seq.
 */
export async function commitAiVersionAndMessage(
  uid: string,
  projectId: string,
  tree: Manifest,
  title: string,
  message: AssistantMessageInput,
): Promise<CommitResult> {
  const db = getFirestore();
  const projectRef = db
    .collection("users")
    .doc(uid)
    .collection("projects")
    .doc(projectId);

  return db.runTransaction(async (t) => {
    const projectSnap = await t.get(projectRef);
    if (!projectSnap.exists) throw new Error("Project no longer exists.");
    const head = (projectSnap.get("headVersion") as number | undefined) ?? 0;

    let n = head + 1;
    let free = false;
    for (let attempt = 0; attempt < 5 && !free; attempt++) {
      const slot = await t.get(
        projectRef.collection("versions").doc(String(n)),
      );
      if (slot.exists) {
        n += 1;
      } else {
        free = true;
      }
    }
    if (!free) {
      throw new Error(
        "Could not append a new version (too many concurrent writes).",
      );
    }

    const seq =
      ((projectSnap.get("lastMessageSeq") as number | undefined) ?? 0) + 1;
    const messageRef = projectRef.collection("messages").doc();

    t.create(projectRef.collection("versions").doc(String(n)), {
      n,
      title,
      source: "ai",
      tree,
      createdAt: FieldValue.serverTimestamp(),
    });
    t.update(projectRef, {
      headVersion: n,
      lastModified: FieldValue.serverTimestamp(),
      lastMessageSeq: seq,
    });
    t.create(messageRef, {
      ...assistantMessageData({...message, versionN: n}),
      seq,
      createdAt: FieldValue.serverTimestamp(),
    });

    return {n, messageId: messageRef.id, seq};
  });
}
