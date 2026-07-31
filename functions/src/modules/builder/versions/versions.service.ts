// Server-side port of the builder's mini-git repo
// (stackly-frontend/src/lib/builder-repo.ts): content-addressed blobs in
// Storage at `{uid}/{projectId}/{sha256}` plus immutable version snapshots
// in Firestore. Writes go through the Admin SDK, bypassing the client
// security rules exactly as those rules anticipate for AI commits.

import {createHash} from "node:crypto";
import {FieldValue, getFirestore} from "firebase-admin/firestore";
import {getStorage} from "firebase-admin/storage";
import {
  DEFAULT_VERSION_TITLE,
  MAX_VERSION_TITLE_CHARS,
} from "../../../shared/config";
import {
  GHL_CLIENT_SHA256,
  GHL_CLIENT_SOURCE,
} from "../../ghl/generated-client";
import {
  AssistantMessageInput,
  HistoryMessage,
  assistantMessageData,
} from "../messages/messages.service";
import {userProjectRef} from "../../../shared/firestore/refs";

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
  const snap = await userProjectRef(uid, projectId)
    .collection("versions")
    .doc(String(n))
    .get();
  return (snap.get("tree") as Manifest | undefined) ?? {};
}

/**
 * Derives the committed version's title from the triggering user turn.
 * @param {HistoryMessage[]} turns The effective conversation turns.
 * @return {string} A short single-line title.
 */
export function versionTitle(turns: HistoryMessage[]): string {
  const max = MAX_VERSION_TITLE_CHARS;
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (turn?.role === "user") {
      const line = turn.content.replace(/\s+/g, " ").trim();
      if (line) {
        return line.length > max ? `${line.slice(0, max - 3)}...` : line;
      }
    }
  }
  return DEFAULT_VERSION_TITLE;
}

/**
 * Reports which of the given blobs are not in Storage. The client uploads the
 * blobs for the variant it applies, so a commit must never trust that they
 * landed — a version referencing a missing blob is unrecoverable.
 * @param {string} uid The owner's uid.
 * @param {string} projectId The project id.
 * @param {string[]} hashes The blob hashes to check.
 * @return {Promise<string[]>} The hashes that are absent.
 */
export async function missingBlobs(
  uid: string,
  projectId: string,
  hashes: string[],
): Promise<string[]> {
  const unique = [...new Set(hashes)];
  const results = await Promise.all(
    unique.map(async (hash) => {
      const [exists] = await blobFile(uid, projectId, hash).exists();
      return exists ? null : hash;
    }),
  );
  return results.filter((h): h is string => h !== null);
}

export interface PlatformFile {
  path: string;
  hash: string;
}

/**
 * The platform-owned files this tree is missing, with their blobs uploaded so
 * they can be fetched immediately.
 *
 * Generated apps import `./lib/ghl`, and the platform owns that file — the
 * model never writes it. A commit injects it, but the PREVIEW of an
 * uncommitted variant needs it too: a project that has never committed has no
 * copy of it at head and no blob for it in Storage, so its very first
 * generation would fail to bundle. Both callers go through here so the
 * condition and the upload are stated once.
 * @param {string} uid The owner's uid.
 * @param {string} projectId The project id.
 * @param {Manifest} tree The tree to check.
 * @return {Promise<PlatformFile[]>} Files to add, empty when already current.
 */
export async function ensurePlatformFiles(
  uid: string,
  projectId: string,
  tree: Manifest,
): Promise<PlatformFile[]> {
  if (tree[GHL_CLIENT_PATH] === GHL_CLIENT_SHA256) return [];
  await uploadBlobIfAbsent(
    uid,
    projectId,
    GHL_CLIENT_SHA256,
    GHL_CLIENT_SOURCE,
  );
  return [{path: GHL_CLIENT_PATH, hash: GHL_CLIENT_SHA256}];
}

/**
 * Rebases a variant's changes onto the CURRENT head tree and injects the
 * platform-owned GHL client when missing or outdated.
 *
 * The changes are a delta of blob hashes, not a snapshot, so a manual commit
 * that advanced head while the user was choosing between variants survives
 * instead of being silently reverted.
 * @param {string} uid The owner's uid.
 * @param {string} projectId The project id.
 * @param {Manifest} head The current head manifest.
 * @param {Map<string, string>} writes path → blob sha256.
 * @param {Set<string>} deletes Paths to remove.
 * @return {Promise<Manifest>} The new manifest, ready to commit.
 */
export async function rebaseOntoTree(
  uid: string,
  projectId: string,
  head: Manifest,
  writes: Map<string, string>,
  deletes: Set<string>,
): Promise<Manifest> {
  const tree: Manifest = {...head};
  for (const path of deletes) delete tree[path];
  for (const [path, hash] of writes) {
    if (path === GHL_CLIENT_PATH) continue;
    tree[path] = hash;
  }

  for (const file of await ensurePlatformFiles(uid, projectId, tree)) {
    tree[file.path] = file.hash;
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
  const projectRef = userProjectRef(uid, projectId);

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
