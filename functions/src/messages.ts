// Chat message persistence for `users/{uid}/projects/{projectId}/messages`.
// All writes happen here (or in repo.ts for the atomic commit path) via the
// Admin SDK — clients have read-only access per firestore.rules. Ordering
// is by `seq`, a per-project counter stored as `lastMessageSeq` on the
// project doc and allocated transactionally with each message.

import {FieldValue, Timestamp, getFirestore} from "firebase-admin/firestore";
import {ChatQuestion, ChatSuggestion} from "./llm-parser";

export type MessageStatus = "complete" | "interrupted" | "error";
export type MessageErrorCode =
  | "malformed_output"
  | "llm_error"
  | "commit_failed"
  | "timeout";

export interface FileChange {
  path: string;
  action: "write" | "delete";
}

export interface Answer {
  question: string;
  choice: string;
}

// One message as read back for prompt assembly.
export interface HistoryMessage {
  id: string;
  kind: "chat" | "summary";
  role: "user" | "assistant" | "system";
  seq: number;
  content: string;
  files: FileChange[];
  questions: ChatQuestion[];
  status: MessageStatus | null;
  contextTokens: number;
  compactedThroughSeq: number;
}

export interface AssistantMessageInput {
  content: string;
  status: MessageStatus;
  files: FileChange[];
  questions: ChatQuestion[];
  suggestions: ChatSuggestion[];
  versionN: number | null;
  contextTokens: number;
  tokensConsumed: number;
  costCents: number;
  model: string;
  requestId: string;
  error: MessageErrorCode | null;
}

const LOCK_TTL_MS = 10 * 60_000;

/**
 * Returns the project document reference.
 * @param {string} uid The owner's uid.
 * @param {string} projectId The project id.
 * @return {FirebaseFirestore.DocumentReference} The project doc ref.
 */
function projectRef(uid: string, projectId: string) {
  return getFirestore()
    .collection("users")
    .doc(uid)
    .collection("projects")
    .doc(projectId);
}

/**
 * Returns the messages collection for a project.
 * @param {string} uid The owner's uid.
 * @param {string} projectId The project id.
 * @return {FirebaseFirestore.CollectionReference} The messages collection.
 */
function messagesCollection(uid: string, projectId: string) {
  return projectRef(uid, projectId).collection("messages");
}

/**
 * Builds the Firestore payload for an assistant message (minus `seq` and
 * `createdAt`, which the transactional writers stamp).
 * @param {AssistantMessageInput} input The assistant message fields.
 * @return {Record<string, unknown>} The document payload.
 */
export function assistantMessageData(
  input: AssistantMessageInput,
): Record<string, unknown> {
  return {
    kind: "chat",
    role: "assistant",
    content: input.content,
    status: input.status,
    files: input.files,
    questions: input.questions,
    suggestions: input.suggestions,
    versionN: input.versionN,
    contextTokens: input.contextTokens,
    tokensConsumed: input.tokensConsumed,
    costCents: input.costCents,
    model: input.model,
    requestId: input.requestId,
    error: input.error,
  };
}

/**
 * Creates a message doc with a transactionally allocated `seq`.
 * @param {string} uid The owner's uid.
 * @param {string} projectId The project id.
 * @param {Record<string, unknown>} data The payload (without seq/createdAt).
 * @return {Promise<{id: string, seq: number}>} The new doc id and seq.
 */
async function writeMessage(
  uid: string,
  projectId: string,
  data: Record<string, unknown>,
): Promise<{id: string; seq: number}> {
  const db = getFirestore();
  const project = projectRef(uid, projectId);
  return db.runTransaction(async (t) => {
    const snap = await t.get(project);
    if (!snap.exists) throw new Error("Project no longer exists.");
    const seq =
      ((snap.get("lastMessageSeq") as number | undefined) ?? 0) + 1;
    const ref = messagesCollection(uid, projectId).doc();
    t.update(project, {lastMessageSeq: seq});
    t.create(ref, {...data, seq, createdAt: FieldValue.serverTimestamp()});
    return {id: ref.id, seq};
  });
}

/**
 * Persists one user turn.
 * @param {string} uid The owner's uid.
 * @param {string} projectId The project id.
 * @param {string} content The rendered message text.
 * @param {Answer[] | null} answers Structured answers when the turn replies
 *   to assistant questions.
 * @return {Promise<{id: string, seq: number}>} The new doc id and seq.
 */
export function writeUserMessage(
  uid: string,
  projectId: string,
  content: string,
  answers: Answer[] | null,
): Promise<{id: string; seq: number}> {
  return writeMessage(uid, projectId, {
    kind: "chat",
    role: "user",
    content,
    answers,
    tokensConsumed: 0,
  });
}

/**
 * Persists an assistant turn outside the atomic commit path (interrupted,
 * error, and no-file-change turns).
 * @param {string} uid The owner's uid.
 * @param {string} projectId The project id.
 * @param {AssistantMessageInput} input The assistant message fields.
 * @return {Promise<{id: string, seq: number}>} The new doc id and seq.
 */
export function writeAssistantMessage(
  uid: string,
  projectId: string,
  input: AssistantMessageInput,
): Promise<{id: string; seq: number}> {
  return writeMessage(uid, projectId, assistantMessageData(input));
}

/**
 * Persists a compaction summary marker.
 * @param {string} uid The owner's uid.
 * @param {string} projectId The project id.
 * @param {object} input The summary fields.
 * @param {string} input.content The summary text.
 * @param {number} input.compactedThroughSeq Highest seq the summary covers.
 * @param {number} input.tokensConsumed Tokens used by the summarizer call.
 * @param {number} input.costCents Cost of the summarizer call.
 * @param {string} input.requestId The chat request that triggered it.
 * @return {Promise<{id: string, seq: number}>} The new doc id and seq.
 */
export function writeSummaryMessage(
  uid: string,
  projectId: string,
  input: {
    content: string;
    compactedThroughSeq: number;
    tokensConsumed: number;
    costCents: number;
    requestId: string;
  },
): Promise<{id: string; seq: number}> {
  return writeMessage(uid, projectId, {
    kind: "summary",
    role: "system",
    content: input.content,
    compactedThroughSeq: input.compactedThroughSeq,
    tokensConsumed: input.tokensConsumed,
    costCents: input.costCents,
    requestId: input.requestId,
  });
}

/**
 * Reads the full transcript ordered by seq.
 * @param {string} uid The owner's uid.
 * @param {string} projectId The project id.
 * @return {Promise<HistoryMessage[]>} All messages, oldest first.
 */
export async function readHistory(
  uid: string,
  projectId: string,
): Promise<HistoryMessage[]> {
  const snap = await messagesCollection(uid, projectId)
    .orderBy("seq", "asc")
    .get();
  return snap.docs.map((d) => ({
    id: d.id,
    kind: (d.get("kind") as HistoryMessage["kind"]) ?? "chat",
    role: (d.get("role") as HistoryMessage["role"]) ?? "user",
    seq: (d.get("seq") as number) ?? 0,
    content: (d.get("content") as string) ?? "",
    files: (d.get("files") as FileChange[]) ?? [],
    questions: (d.get("questions") as ChatQuestion[]) ?? [],
    status: (d.get("status") as MessageStatus) ?? null,
    contextTokens: (d.get("contextTokens") as number) ?? 0,
    compactedThroughSeq: (d.get("compactedThroughSeq") as number) ?? 0,
  }));
}

export interface EffectiveHistory {
  // The latest compaction summary, if any.
  summary: HistoryMessage | null;
  // Chat turns after the summary marker (or all turns when no summary).
  turns: HistoryMessage[];
}

/**
 * Resolves the effective conversation: the newest summary plus every chat
 * turn after its marker.
 * @param {HistoryMessage[]} all The full transcript, oldest first.
 * @return {EffectiveHistory} The prompt-ready view of the conversation.
 */
export function effectiveHistory(all: HistoryMessage[]): EffectiveHistory {
  let summary: HistoryMessage | null = null;
  for (const m of all) {
    if (m.kind === "summary") summary = m;
  }
  const cutoff = summary ? summary.compactedThroughSeq : 0;
  const turns = all.filter((m) => m.kind === "chat" && m.seq > cutoff);
  return {summary, turns};
}

/**
 * Acquires the per-project chat lock (one generation at a time). A stale
 * lock past its TTL is stolen.
 * @param {string} uid The owner's uid.
 * @param {string} projectId The project id.
 * @param {string} requestId This request's id.
 * @return {Promise<boolean>} True if the lock was acquired.
 */
export async function acquireChatLock(
  uid: string,
  projectId: string,
  requestId: string,
): Promise<boolean> {
  const ref = projectRef(uid, projectId).collection("state").doc("chat");
  return getFirestore().runTransaction(async (t) => {
    const snap = await t.get(ref);
    const expiresAt = snap.get("expiresAt") as Timestamp | undefined;
    if (snap.exists && expiresAt && expiresAt.toMillis() > Date.now()) {
      return false;
    }
    t.set(ref, {
      activeRequestId: requestId,
      expiresAt: Timestamp.fromMillis(Date.now() + LOCK_TTL_MS),
    });
    return true;
  });
}

/**
 * Releases the chat lock if this request still owns it.
 * @param {string} uid The owner's uid.
 * @param {string} projectId The project id.
 * @param {string} requestId This request's id.
 * @return {Promise<void>} Resolves once released.
 */
export async function releaseChatLock(
  uid: string,
  projectId: string,
  requestId: string,
): Promise<void> {
  const ref = projectRef(uid, projectId).collection("state").doc("chat");
  await getFirestore().runTransaction(async (t) => {
    const snap = await t.get(ref);
    if (snap.exists && snap.get("activeRequestId") === requestId) {
      t.delete(ref);
    }
  });
}
