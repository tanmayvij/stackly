// Resolution of a pending generation turn: the user has seen the ranked
// variants the chat endpoint streamed and either applies one or discards them.
//
// The variants themselves are never persisted — their file contents live only
// in the browser for the length of the session (see stores/builder.ts). What
// the client sends back is a delta of blob hashes for the variant it chose,
// which this module validates, rebases onto the current head, and commits
// together with the assistant message. The chat endpoint already debited the
// wallet, so the authoritative token/cost figures for the message are read
// back off the ledger rather than taken from the caller.

import {HttpsError} from "firebase-functions/https";
import {
  BLOB_HASH_PATTERN,
  DEFAULT_VERSION_TITLE,
  MAX_ANSWER_CHARS,
  MAX_ECHOED_LIST_ITEMS,
  MAX_PROMPT_CHARS,
  MAX_VARIANT_FILES,
  MAX_VARIANT_PATH_CHARS,
  MAX_VARIANT_SUMMARY_CHARS,
  MAX_VERSION_TITLE_CHARS,
} from "../../../shared/config";
import {
  projectMessagesCollection,
  userProjectRef,
  walletTransactionsCollection,
} from "../../../shared/firestore/refs";
import {
  CHOICES_PER_QUESTION,
  MAX_QUESTIONS,
  MAX_SUGGESTIONS,
  PROTECTED_PATHS,
  ChatQuestion,
  ChatSuggestion,
  normalizePath,
} from "../parser/parser";
import {
  AssistantMessageInput,
  FileChange,
  MessageStatus,
  writeAssistantMessage,
} from "../messages/messages.service";
import {
  CommitResult,
  commitAiVersionAndMessage,
  missingBlobs,
  readTree,
  rebaseOntoTree,
} from "../versions/versions.service";

// Every bound here comes from shared/config/limits.ts. The reply, summary,
// title, questions and suggestions are all supplied by the caller — the server
// keeps no copy once the stream closes — so they are bounded by the same
// constants that bound the model output they were parsed from.

export interface VariantDelta {
  // path → blob sha256 for every file this variant writes.
  writes: Map<string, string>;
  deletes: Set<string>;
}

export interface TurnPayload {
  reply: string;
  summary: string;
  // Version title, derived by the chat endpoint from the user turn THIS
  // generation answered. Deriving it at apply time would mislabel the version
  // whenever another tab appended a newer user turn in the meantime.
  title: string;
  // Head at generation time. The variant's file contents were produced against
  // this tree, so it is what a conflict is measured from.
  baseVersion: number;
  questions: ChatQuestion[];
  suggestions: ChatSuggestion[];
}

/**
 * Validates the caller-supplied writes/deletes for one variant, applying the
 * same path policy the parser applies to model output.
 * @param {unknown} rawWrites The `writes` field: {path, hash} objects.
 * @param {unknown} rawDeletes The `deletes` field: path strings.
 * @return {VariantDelta} The normalized delta.
 */
export function parseVariantDelta(
  rawWrites: unknown,
  rawDeletes: unknown,
): VariantDelta {
  const writes = new Map<string, string>();
  const deletes = new Set<string>();

  const writeList = Array.isArray(rawWrites) ? rawWrites : [];
  const deleteList = Array.isArray(rawDeletes) ? rawDeletes : [];
  if (writeList.length + deleteList.length === 0) {
    throw new HttpsError("invalid-argument", "The variant changes no files.");
  }
  if (writeList.length + deleteList.length > MAX_VARIANT_FILES) {
    throw new HttpsError("invalid-argument", "Too many files in one variant.");
  }

  for (const item of writeList) {
    const rawPath = (item as {path?: unknown})?.path;
    const hash = (item as {hash?: unknown})?.hash;
    if (typeof rawPath !== "string" || rawPath.length > MAX_VARIANT_PATH_CHARS) {
      throw new HttpsError("invalid-argument", "Invalid file path.");
    }
    if (typeof hash !== "string" || !BLOB_HASH_PATTERN.test(hash)) {
      throw new HttpsError("invalid-argument", `Invalid hash for ${rawPath}.`);
    }
    const path = normalizePath(rawPath);
    if (!path || PROTECTED_PATHS.has(path)) {
      throw new HttpsError("invalid-argument", `Path not writable: ${rawPath}`);
    }
    writes.set(path, hash);
    deletes.delete(path);
  }

  for (const rawPath of deleteList) {
    if (typeof rawPath !== "string" || rawPath.length > MAX_VARIANT_PATH_CHARS) {
      throw new HttpsError("invalid-argument", "Invalid delete path.");
    }
    const path = normalizePath(rawPath);
    if (!path || PROTECTED_PATHS.has(path)) {
      throw new HttpsError("invalid-argument", `Path not deletable: ${rawPath}`);
    }
    if (!writes.has(path)) deletes.add(path);
  }

  return {writes, deletes};
}

/**
 * Validates the caller-supplied conversational half of the turn.
 * @param {Record<string, unknown>} data The callable request payload.
 * @return {TurnPayload} The bounded payload.
 */
export function parseTurnPayload(
  data: Record<string, unknown>,
): TurnPayload {
  const reply = typeof data.reply === "string" ? data.reply.trim() : "";
  const summary = typeof data.summary === "string" ? data.summary.trim() : "";
  if (reply.length > MAX_PROMPT_CHARS || summary.length > MAX_VARIANT_SUMMARY_CHARS) {
    throw new HttpsError("invalid-argument", "Reply or summary too long.");
  }
  const rawTitle = typeof data.title === "string" ? data.title.trim() : "";
  const baseVersion = data.baseVersion;
  if (
    baseVersion !== undefined &&
    (typeof baseVersion !== "number" ||
      !Number.isInteger(baseVersion) ||
      baseVersion < 0)
  ) {
    throw new HttpsError("invalid-argument", "Invalid base version.");
  }
  return {
    reply,
    summary,
    title: rawTitle.replace(/\s+/g, " ").slice(0, MAX_VERSION_TITLE_CHARS) ||
      DEFAULT_VERSION_TITLE,
    baseVersion: typeof baseVersion === "number" ? baseVersion : 0,
    questions: parseQuestions(data.questions),
    suggestions: parseSuggestions(data.suggestions),
  };
}

/**
 * Validates the questions echoed back from the streamed turn.
 * @param {unknown} raw The `questions` field.
 * @return {ChatQuestion[]} The accepted questions.
 */
function parseQuestions(raw: unknown): ChatQuestion[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatQuestion[] = [];
  // Malformed entries are skipped rather than consuming a slot, matching how
  // the parser's accumulator clamps model output.
  for (const item of raw.slice(0, MAX_ECHOED_LIST_ITEMS)) {
    if (out.length >= MAX_QUESTIONS) break;
    const text = (item as {text?: unknown})?.text;
    const choices = (item as {choices?: unknown})?.choices;
    if (typeof text !== "string" || !text.trim()) continue;
    if (!Array.isArray(choices)) continue;
    const clean = choices
      .filter((c): c is string => typeof c === "string" && !!c.trim())
      .slice(0, CHOICES_PER_QUESTION)
      .map((c) => c.trim().slice(0, MAX_ANSWER_CHARS));
    if (clean.length < CHOICES_PER_QUESTION) continue;
    out.push({text: text.trim().slice(0, MAX_ANSWER_CHARS), choices: clean});
  }
  return out;
}

/**
 * Validates the suggestions echoed back from the streamed turn.
 * @param {unknown} raw The `suggestions` field.
 * @return {ChatSuggestion[]} The accepted suggestions.
 */
function parseSuggestions(raw: unknown): ChatSuggestion[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatSuggestion[] = [];
  for (const item of raw.slice(0, MAX_ECHOED_LIST_ITEMS)) {
    if (out.length >= MAX_SUGGESTIONS) break;
    const label = (item as {label?: unknown})?.label;
    const prompt = (item as {prompt?: unknown})?.prompt;
    if (typeof label !== "string" || !label.trim()) continue;
    if (typeof prompt !== "string" || !prompt.trim()) continue;
    out.push({
      label: label.trim().slice(0, MAX_VARIANT_SUMMARY_CHARS),
      prompt: prompt.trim().slice(0, MAX_PROMPT_CHARS),
    });
  }
  return out;
}

export interface TurnBilling {
  tokensUsed: number;
  costCents: number;
}

/**
 * Reads back what the generation actually cost, from the ledger entry the chat
 * endpoint wrote. Never taken from the caller: `contextTokens` drives
 * compaction, so an under-reported value would quietly stop the conversation
 * from ever being summarized.
 * @param {string} uid The owner's uid.
 * @param {string} requestId The generation's request id.
 * @return {Promise<TurnBilling>} The recorded usage (zeroes if none was
 *   written, which means the turn was free).
 */
export async function readTurnBilling(
  uid: string,
  requestId: string,
): Promise<TurnBilling> {
  const snap = await walletTransactionsCollection(uid)
    .where("refId", "==", `chat:${requestId}`)
    .limit(1)
    .get();
  const doc = snap.docs[0];
  if (!doc) return {tokensUsed: 0, costCents: 0};
  const tokensUsed = doc.get("tokensUsed");
  const valueInCents = doc.get("valueInCents");
  return {
    tokensUsed: typeof tokensUsed === "number" ? tokensUsed : 0,
    costCents: typeof valueInCents === "number" ? Math.abs(valueInCents) : 0,
  };
}

export interface ResolvedTurn {
  // Set when this call did the work; null when a previous call already did.
  committed: CommitResult | null;
  versionN: number | null;
}

/**
 * Paths this variant would change that someone else has already changed since
 * it was generated.
 *
 * The variant's file contents are FULL files produced against `baseVersion`,
 * so committing one over a newer head silently discards whatever landed in
 * between. This is reachable without any misuse: a second tab sees only a
 * dangling user turn (the pending variants live in the first tab's memory),
 * so it will happily run and commit its own turn while these options wait.
 * Non-overlapping changes are left alone — those rebase cleanly.
 * @param {string} uid The owner's uid.
 * @param {string} projectId The project id.
 * @param {number} baseVersion Head at generation time.
 * @param {number} head Head now.
 * @param {VariantDelta} delta The variant's changes.
 * @return {Promise<string[]>} Conflicting paths, empty when safe to commit.
 */
async function conflictingPaths(
  uid: string,
  projectId: string,
  baseVersion: number,
  head: number,
  delta: VariantDelta,
): Promise<string[]> {
  if (head === baseVersion) return [];
  const [baseTree, headTree] = await Promise.all([
    readTree(uid, projectId, baseVersion),
    readTree(uid, projectId, head),
  ]);
  const touched = [...delta.writes.keys(), ...delta.deletes];
  return touched.filter((path) => baseTree[path] !== headTree[path]);
}

/**
 * Loads the project, rejecting anything that is not a live project the caller
 * can still write a turn into.
 * @param {string} uid The owner's uid.
 * @param {string} projectId The project id.
 * @return {Promise<FirebaseFirestore.DocumentSnapshot>} The project snapshot.
 */
async function loadProject(
  uid: string,
  projectId: string,
): Promise<FirebaseFirestore.DocumentSnapshot> {
  const snap = await userProjectRef(uid, projectId).get();
  if (!snap.exists || snap.get("deleted") === true) {
    throw new HttpsError("not-found", "Project not found.");
  }
  return snap;
}

/**
 * Finds an assistant turn already written for this generation. Resolution is
 * idempotent on `requestId`: a double-click must not commit the same variant
 * twice, and the version slot scan in commitAiVersionAndMessage is designed to
 * SKIP taken slots, so it would happily produce two versions.
 * @param {string} uid The owner's uid.
 * @param {string} projectId The project id.
 * @param {string} requestId The generation's request id.
 * @return {Promise<number | null | undefined>} The existing turn's versionN
 *   (possibly null), or undefined when no turn exists yet.
 */
async function existingTurnVersion(
  uid: string,
  projectId: string,
  requestId: string,
): Promise<number | null | undefined> {
  const snap = await projectMessagesCollection(uid, projectId)
    .where("requestId", "==", requestId)
    .where("role", "==", "assistant")
    .limit(1)
    .get();
  const doc = snap.docs[0];
  if (!doc) return undefined;
  return (doc.get("versionN") as number | null) ?? null;
}

/**
 * Builds the assistant message for a resolved turn.
 * @param {TurnPayload} payload The conversational half of the turn.
 * @param {FileChange[]} files The applied file changes.
 * @param {MessageStatus} status The terminal status.
 * @param {TurnBilling} billing The recorded usage.
 * @param {string} model The model that generated it.
 * @param {string} requestId The generation's request id.
 * @return {AssistantMessageInput} The message payload.
 */
function turnMessage(
  payload: TurnPayload,
  files: FileChange[],
  status: MessageStatus,
  billing: TurnBilling,
  model: string,
  requestId: string,
): AssistantMessageInput {
  return {
    content: payload.reply,
    status,
    files,
    questions: payload.questions,
    suggestions: payload.suggestions,
    versionN: null,
    contextTokens: billing.tokensUsed,
    tokensConsumed: billing.tokensUsed,
    costCents: billing.costCents,
    model,
    requestId,
    error: null,
  };
}

/**
 * Commits one variant: validates its blobs, rebases its delta onto the current
 * head, and atomically appends the version plus the assistant message.
 * @param {string} uid The owner's uid.
 * @param {string} projectId The project id.
 * @param {string} requestId The generation's request id.
 * @param {VariantDelta} delta The chosen variant's changes.
 * @param {TurnPayload} payload The conversational half of the turn.
 * @return {Promise<ResolvedTurn>} The commit result, or the prior one.
 */
export async function applyPendingVariant(
  uid: string,
  projectId: string,
  requestId: string,
  delta: VariantDelta,
  payload: TurnPayload,
): Promise<ResolvedTurn> {
  const project = await loadProject(uid, projectId);
  const already = await existingTurnVersion(uid, projectId, requestId);
  if (already !== undefined) return {committed: null, versionN: already};

  const missing = await missingBlobs(uid, projectId, [...delta.writes.values()]);
  if (missing.length) {
    throw new HttpsError(
      "failed-precondition",
      "Some generated files were not uploaded. Try applying again.",
    );
  }

  const head = (project.get("headVersion") as number | undefined) ?? 0;
  const conflicts = await conflictingPaths(
    uid,
    projectId,
    payload.baseVersion,
    head,
    delta,
  );
  if (conflicts.length) {
    throw new HttpsError(
      "aborted",
      `${conflicts.join(", ")} changed since these options were generated. ` +
        "Discard them and ask again so the change isn't lost.",
    );
  }

  const tree = await rebaseOntoTree(
    uid,
    projectId,
    await readTree(uid, projectId, head),
    delta.writes,
    delta.deletes,
  );

  const files: FileChange[] = [
    ...[...delta.writes.keys()].map(
      (path): FileChange => ({path, action: "write"}),
    ),
    ...[...delta.deletes].map(
      (path): FileChange => ({path, action: "delete"}),
    ),
  ];
  const billing = await readTurnBilling(uid, requestId);
  const committed = await commitAiVersionAndMessage(
    uid,
    projectId,
    tree,
    payload.title,
    turnMessage(
      payload,
      files,
      "complete",
      billing,
      (project.get("modelId") as string) ?? "",
      requestId,
    ),
  );
  return {committed, versionN: committed.n};
}

/**
 * Discards a pending turn: no version, but the assistant turn is still
 * recorded as interrupted so the ledger entry the generation already produced
 * has a matching row in the transcript, the compaction accounting stays
 * correct, and the user's message doesn't sit unanswered before the next one.
 * @param {string} uid The owner's uid.
 * @param {string} projectId The project id.
 * @param {string} requestId The generation's request id.
 * @param {TurnPayload} payload The conversational half of the turn.
 * @return {Promise<ResolvedTurn>} Always an uncommitted result.
 */
export async function discardPendingTurn(
  uid: string,
  projectId: string,
  requestId: string,
  payload: TurnPayload,
): Promise<ResolvedTurn> {
  const project = await loadProject(uid, projectId);
  const already = await existingTurnVersion(uid, projectId, requestId);
  if (already !== undefined) return {committed: null, versionN: already};

  const billing = await readTurnBilling(uid, requestId);
  await writeAssistantMessage(
    uid,
    projectId,
    turnMessage(
      payload,
      [],
      "interrupted",
      billing,
      (project.get("modelId") as string) ?? "",
      requestId,
    ),
  );
  return {committed: null, versionN: null};
}
