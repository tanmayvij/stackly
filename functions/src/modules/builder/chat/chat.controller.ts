// The builder chat endpoint: an authenticated, SSE-streaming onRequest
// function (callables can't stream). One request = one generation turn:
// balance gate → per-project lock → optional compaction → streamed LLM call
// parsed incrementally → atomic version+message commit → wallet debit.
// Nothing is committed until the stream completes cleanly; a client
// disconnect aborts the upstream call and persists an interrupted turn
// free of charge.

import {randomUUID} from "node:crypto";
import {onRequest} from "firebase-functions/https";
import * as logger from "firebase-functions/logger";
import {
  COMPACT_AT_FRACTION,
  FLASH_MODEL,
  LOW_BALANCE_THRESHOLD_CENTS,
  MAX_ANSWER_CHARS,
  MAX_PROMPT_CHARS,
  ModelPrice,
  OPENAI_API_KEY,
  OPENAI_BASE_URL,
  PROJECT_ID_PATTERN,
  modelConfig,
} from "../../../shared/config";
import {verifyAppCheck, verifyBearer} from "../../../shared/auth";
import {applyCors, handlePreflight} from "../../../shared/http";
import {userProjectRef} from "../../../shared/firestore/refs";
import {openaiClient} from "../../../shared/llm/client";
import {
  ParseEvent,
  LlmStreamParser,
  PROTECTED_PATHS,
  ResponseAccumulator,
  normalizePath,
} from "../parser/parser";
import {
  Answer,
  AssistantMessageInput,
  FileChange,
  HistoryMessage,
  MessageErrorCode,
  acquireChatLock,
  readEffectiveHistory,
  releaseChatLock,
  renewChatLock,
  writeAssistantMessage,
  writeSummaryMessage,
  writeUserMessage,
} from "../messages/messages.service";
import {
  ProjectFile,
  SUMMARY_SYSTEM_PROMPT,
  buildChatMessages,
  buildSummaryInput,
} from "./prompt";
import {
  GHL_CLIENT_PATH,
  applyResponseToTree,
  commitAiVersionAndMessage,
  fetchBlob,
  readTree,
} from "../versions/versions.service";
import {
  addTransaction,
  costForTokens,
  getBalanceForUser,
} from "../../wallet/wallet.service";
import {SseWriter} from "./sse";

// Abort the generation with margin before Cloud Run's hard timeout so the
// error message doc and lock release still happen.
const INTERNAL_DEADLINE_MS = 480_000;
// Recent turns kept verbatim when the older history is compacted away.
const COMPACT_KEEP_TURNS = 4;

/**
 * Validates the optional answers payload.
 * @param {unknown} raw The request body's `answers` field.
 * @return {Answer[] | null} The validated answers, or null when absent
 *   or invalid.
 */
export function parseAnswers(raw: unknown): Answer[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 4) return null;
  const answers: Answer[] = [];
  for (const item of raw) {
    const question = (item as {question?: unknown})?.question;
    const choice = (item as {choice?: unknown})?.choice;
    if (typeof question !== "string" || !question.trim()) return null;
    if (typeof choice !== "string" || !choice.trim()) return null;
    if (question.length > MAX_ANSWER_CHARS) return null;
    if (choice.length > MAX_ANSWER_CHARS) return null;
    answers.push({question: question.trim(), choice: choice.trim()});
  }
  return answers;
}

/**
 * Renders structured answers as the plain-text user turn stored in the
 * transcript, so prompt assembly never special-cases them.
 * @param {Answer[]} answers The validated answers.
 * @return {string} The rendered message content.
 */
export function renderAnswers(answers: Answer[]): string {
  return answers
    .map((a) => `Q: ${a.question}\nA: ${a.choice}`)
    .join("\n\n");
}

/**
 * Derives the committed version's title from the triggering user turn.
 * @param {HistoryMessage[]} turns The effective conversation turns.
 * @return {string} A short single-line title.
 */
export function versionTitle(turns: HistoryMessage[]): string {
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (turn?.role === "user") {
      const line = turn.content.replace(/\s+/g, " ").trim();
      if (line) return line.length > 60 ? `${line.slice(0, 57)}...` : line;
    }
  }
  return "AI update";
}

interface GenerationContext {
  uid: string;
  projectId: string;
  model: ModelPrice;
  headVersion: number;
  requestId: string;
  hadNewInput: boolean;
  sse: SseWriter;
  signal: AbortSignal;
  isClientGone: () => boolean;
  isTimedOut: () => boolean;
}

export const chat = onRequest(
  {
    secrets: [OPENAI_API_KEY, OPENAI_BASE_URL],
    timeoutSeconds: 540,
    memory: "1GiB",
    concurrency: 8,
    maxInstances: 20,
    // minInstances removes cold-start latency, but bills
    // for an always-warm 1GiB instance. Cost trade-off, revisit when budget allows.
    // minInstances: 1,
  },
  async (req, res) => {
    applyCors(res, {
      origin: req.headers.origin ?? "*",
      methods: "POST, OPTIONS",
      headers: "Authorization, Content-Type, X-Firebase-AppCheck",
      varyOrigin: true,
    });
    if (handlePreflight(req, res)) return;
    if (req.method !== "POST") {
      res.status(405).json({error: "method_not_allowed"});
      return;
    }

    if (!(await verifyAppCheck(req))) {
      res.status(401).json({error: "app_check_failed"});
      return;
    }

    const uid = await verifyBearer(req);
    if (!uid) {
      res.status(401).json({error: "unauthenticated"});
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const projectId = body.projectId;
    if (typeof projectId !== "string" || !PROJECT_ID_PATTERN.test(projectId)) {
      res.status(400).json({error: "invalid_request", detail: "projectId"});
      return;
    }
    const message =
      typeof body.message === "string" ? body.message.trim() : "";
    if (body.message !== undefined && !message) {
      res.status(400).json({error: "invalid_request", detail: "message"});
      return;
    }
    if (message.length > MAX_PROMPT_CHARS) {
      res.status(400).json({error: "invalid_request", detail: "message"});
      return;
    }
    const answers = message ? null : parseAnswers(body.answers);
    if (body.answers !== undefined && !message && !answers) {
      res.status(400).json({error: "invalid_request", detail: "answers"});
      return;
    }

    const projectSnap = await userProjectRef(uid, projectId).get();
    if (!projectSnap.exists || projectSnap.get("deleted") === true) {
      res.status(404).json({error: "project_not_found"});
      return;
    }
    let model: ModelPrice;
    try {
      model = modelConfig(projectSnap.get("modelId") as string);
    } catch {
      res.status(400).json({error: "invalid_request", detail: "modelId"});
      return;
    }

    const balanceCents = await getBalanceForUser(uid);
    if (balanceCents < LOW_BALANCE_THRESHOLD_CENTS) {
      res.status(402).json({
        error: "insufficient_balance",
        balanceCents,
        thresholdCents: LOW_BALANCE_THRESHOLD_CENTS,
      });
      return;
    }

    const requestId = randomUUID();
    if (!(await acquireChatLock(uid, projectId, requestId))) {
      res.status(409).json({error: "busy"});
      return;
    }
    // Heartbeat the lock while this run is alive; if the instance dies the
    // lock goes stale-stealable within a minute instead of the full TTL.
    const lockRenewer = setInterval(() => {
      renewChatLock(uid, projectId, requestId).catch((err) =>
        logger.warn("failed to renew chat lock", {requestId, err}),
      );
    }, 20_000);

    const sse = new SseWriter(res);
    let sseOpen = false;
    try {
      let userMessage: {id: string; seq: number} | null = null;
      if (message || answers) {
        userMessage = await writeUserMessage(
          uid,
          projectId,
          message || renderAnswers(answers as Answer[]),
          answers,
        );
      }

      sse.open();
      sseOpen = true;
      if (userMessage) {
        sse.send("user-message", {
          id: userMessage.id,
          seq: userMessage.seq,
        });
      }
      sse.send("status", {phase: "starting"});

      // Client disconnects surface on the response stream: `close` before
      // we called end() means the socket died. (req "close" fires as soon
      // as the request body is fully read on modern Node — useless here.)
      const abort = new AbortController();
      let clientGone = false;
      let timedOut = false;
      res.on("close", () => {
        if (!res.writableEnded) {
          clientGone = true;
          abort.abort();
        }
      });
      const deadline = setTimeout(() => {
        timedOut = true;
        abort.abort();
      }, INTERNAL_DEADLINE_MS);

      try {
        await runGeneration({
          uid,
          projectId,
          model,
          headVersion:
            (projectSnap.get("headVersion") as number | undefined) ?? 0,
          requestId,
          hadNewInput: Boolean(message || answers),
          sse,
          signal: abort.signal,
          isClientGone: () => clientGone,
          isTimedOut: () => timedOut,
        });
      } finally {
        clearTimeout(deadline);
      }
    } catch (err) {
      logger.error("chat request failed", {requestId, err});
      if (sseOpen) {
        sse.send("error", {
          code: "internal",
          message: "Something went wrong. Please try again.",
        });
      } else {
        res.status(500).json({error: "internal"});
      }
    } finally {
      clearInterval(lockRenewer);
      await releaseChatLock(uid, projectId, requestId).catch((err) =>
        logger.warn("failed to release chat lock", {requestId, err}),
      );
      if (sseOpen) sse.end();
    }
  },
);

/**
 * Runs one generation turn end-to-end over an open SSE stream. Handles its
 * own error taxonomy; only unexpected failures propagate to the caller.
 * @param {GenerationContext} ctx Everything the turn needs.
 * @return {Promise<void>} Resolves when the turn is fully persisted.
 */
async function runGeneration(ctx: GenerationContext): Promise<void> {
  const {uid, projectId, model, requestId, sse} = ctx;

  const effective = await readEffectiveHistory(uid, projectId);
  let summaryText = effective.summary?.content ?? null;
  let turns = effective.turns;

  // Retry requests (no new input) re-answer the pending user turn: drop
  // trailing failed assistant turns so the model gets a clean run at it.
  if (!ctx.hadNewInput) {
    while (turns.length) {
      const last = turns[turns.length - 1];
      if (
        last?.role === "assistant" &&
        (last.status === "error" || last.status === "interrupted")
      ) {
        turns = turns.slice(0, -1);
      } else {
        break;
      }
    }
  }
  const lastTurn = turns[turns.length - 1];
  if (!lastTurn || lastTurn.role !== "user") {
    sse.send("error", {
      code: "invalid_request",
      message: "There is no pending message to answer — send one.",
    });
    return;
  }

  // Compaction: triggered by the previous run's total context usage. The
  // most recent assistant turn is always within the effective window (a
  // compaction keeps the latest turns un-summarized), so scanning `turns`
  // finds it without re-reading the full transcript.
  let lastAssistant: HistoryMessage | null = null;
  for (const m of effective.turns) {
    if (m.kind === "chat" && m.role === "assistant") lastAssistant = m;
  }
  const windowTokens = model.contextWindowTokens;
  if (
    lastAssistant &&
    lastAssistant.contextTokens >= COMPACT_AT_FRACTION * windowTokens &&
    turns.length > COMPACT_KEEP_TURNS
  ) {
    sse.send("status", {phase: "compacting"});
    try {
      const cut = turns.length - COMPACT_KEEP_TURNS;
      const toSummarize = turns.slice(0, cut);
      const completion = await openaiClient().chat.completions.create(
        {
          model: FLASH_MODEL,
          messages: [
            {role: "system", content: SUMMARY_SYSTEM_PROMPT},
            {
              role: "user",
              content: buildSummaryInput(summaryText, toSummarize),
            },
          ],
        },
        {signal: ctx.signal},
      );
      const text = completion.choices[0]?.message?.content?.trim();
      if (text) {
        const tokens = completion.usage?.total_tokens ?? 0;
        const cost = costForTokens(FLASH_MODEL, tokens);
        await writeSummaryMessage(uid, projectId, {
          content: text,
          compactedThroughSeq: toSummarize[toSummarize.length - 1]?.seq ?? 0,
          tokensConsumed: tokens,
          costCents: cost,
          requestId,
        });
        if (cost > 0) {
          await addTransaction({
            userId: uid,
            type: "DEBIT",
            valueInCents: -cost,
            tokensUsed: tokens,
            refId: `compact:${requestId}`,
          });
        }
        summaryText = text;
        turns = turns.slice(cut);
      }
    } catch (err) {
      if (ctx.isClientGone()) return;
      // Best effort: continue with the uncompacted history.
      logger.warn("compaction failed; continuing", {requestId, err});
    }
  }

  // Prompt assembly: system + docs, current files, summary, chat turns.
  const tree = await readTree(uid, projectId, ctx.headVersion);
  let hasGhlClient = false;
  const filePaths: {path: string; hash: string}[] = [];
  for (const path of Object.keys(tree).sort()) {
    const hash = tree[path];
    if (hash == null) continue;
    if (path === GHL_CLIENT_PATH) {
      hasGhlClient = true;
      continue;
    }
    filePaths.push({path, hash});
  }
  const files: ProjectFile[] = await Promise.all(
    filePaths.map(async ({path, hash}) => ({
      path,
      content: await fetchBlob(uid, projectId, hash),
    })),
  );
  const llmMessages = buildChatMessages(
    files,
    hasGhlClient,
    summaryText,
    turns,
  );
  const promptChars = llmMessages.reduce(
    (sum, m) => sum + m.content.length,
    0,
  );

  // Streamed generation.
  sse.send("status", {phase: "generating"});
  const parser = new LlmStreamParser();
  const acc = new ResponseAccumulator();
  let usageTotal: number | null = null;
  let completionChars = 0;
  let finished = false;

  const forward = (events: ParseEvent[]): void => {
    for (const e of events) {
      acc.add(e);
      switch (e.type) {
      case "reply-delta":
        sse.send("reply-delta", {text: e.text});
        break;
      case "file-start":
      case "file-delta":
      case "file-end":
      case "file-delete": {
        const norm = normalizePath(e.path);
        if (norm && PROTECTED_PATHS.has(norm)) break;
        if (e.type === "file-delta") {
          sse.send("file-delta", {path: e.path, text: e.text});
        } else {
          sse.send(e.type, {path: e.path});
        }
        break;
      }
      case "question":
        sse.send("question", {text: e.text, choices: e.choices});
        break;
      case "suggestion":
        sse.send("suggestion", {label: e.label, prompt: e.prompt});
        break;
      case "warning":
        logger.warn("parser warning", {requestId, reason: e.reason});
        break;
      }
    }
  };

  try {
    const stream = await openaiClient().chat.completions.create(
      {
        model: model.model,
        stream: true,
        stream_options: {include_usage: true},
        messages: llmMessages,
      },
      {signal: ctx.signal},
    );
    for await (const chunk of stream) {
      if (chunk.usage) usageTotal = chunk.usage.total_tokens;
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        completionChars += delta.length;
        forward(parser.push(delta));
      }
    }
    finished = true;
  } catch (err) {
    if (!ctx.isClientGone() && !ctx.isTimedOut()) {
      logger.error("llm stream failed", {requestId, err});
    }
  }

  const fin = parser.finish();
  if (finished) forward(fin.events);
  else fin.events.forEach((e) => acc.add(e));
  const result = acc.result();
  if (result.warnings.length) {
    logger.warn("response warnings", {requestId, warnings: result.warnings});
  }

  const estimatedTokens = Math.ceil((promptChars + completionChars) / 4);
  const tokensUsed = usageTotal ?? estimatedTokens;
  const costCents = costForTokens(model.model, tokensUsed);
  const filesChanged: FileChange[] = [
    ...[...result.writes.keys()].map(
      (path): FileChange => ({path, action: "write"}),
    ),
    ...[...result.deletes].map(
      (path): FileChange => ({path, action: "delete"}),
    ),
  ];
  const base: AssistantMessageInput = {
    content: result.reply,
    status: "complete",
    files: filesChanged,
    questions: result.questions,
    suggestions: result.suggestions,
    versionN: null,
    contextTokens: tokensUsed,
    tokensConsumed: tokensUsed,
    costCents,
    model: model.model,
    requestId,
    error: null,
  };

  /**
   * Persists a failed/interrupted assistant turn (never commits files).
   * @param {"interrupted" | "error"} status The terminal status.
   * @param {MessageErrorCode | null} code The machine error code.
   * @param {boolean} charge Whether the turn is billed.
   * @return {Promise<{id: string, seq: number}>} The written message.
   */
  const persistFailure = (
    status: "interrupted" | "error",
    code: MessageErrorCode | null,
    charge: boolean,
  ): Promise<{id: string; seq: number}> =>
    writeAssistantMessage(uid, projectId, {
      ...base,
      status,
      error: code,
      contextTokens: charge ? tokensUsed : 0,
      tokensConsumed: charge ? tokensUsed : 0,
      costCents: charge ? costCents : 0,
    });

  /**
   * Debits the wallet for this turn (idempotent on requestId).
   * @return {Promise<void>} Resolves once recorded.
   */
  const debit = async (): Promise<void> => {
    await addTransaction({
      userId: uid,
      type: "DEBIT",
      valueInCents: -costCents,
      tokensUsed,
      refId: `chat:${requestId}`,
    });
  };

  // Cancelled: keep the partial text, commit nothing, charge nothing.
  if (ctx.isClientGone()) {
    await persistFailure("interrupted", null, false);
    return;
  }
  if (ctx.isTimedOut()) {
    await persistFailure("error", "timeout", false);
    sse.send("error", {
      code: "timeout",
      message: "Generation took too long and was stopped.",
    });
    return;
  }
  if (!finished) {
    // Upstream LLM failure. No usage arrived, so nothing is billed; with
    // no output at all the user turn alone stays pending (retry re-runs).
    if (completionChars > 0) {
      const written = await persistFailure("error", "llm_error", false);
      sse.send("message", {id: written.id, status: "error"});
    }
    sse.send("error", {
      code: "llm_error",
      message: "The model failed to respond. Try again.",
    });
    return;
  }

  const malformed = fin.incompleteFile !== null || fin.invalidFileBlocks > 0;
  if (malformed) {
    await debit();
    const written = await persistFailure("error", "malformed_output", true);
    sse.send("message", {id: written.id, status: "error"});
    sse.send("error", {
      code: "malformed_output",
      message:
        "The model returned malformed output. No changes were applied.",
    });
    return;
  }

  if (filesChanged.length === 0) {
    // Pure Q&A / refusal turn: no version.
    await debit();
    const written = await writeAssistantMessage(uid, projectId, base);
    sse.send("message", {id: written.id, status: "complete"});
    sse.send("done", {ok: true});
    return;
  }

  sse.send("status", {phase: "committing"});
  try {
    const newTree = await applyResponseToTree(
      uid,
      projectId,
      tree,
      result.writes,
      result.deletes,
    );
    const title = versionTitle(turns);
    const commit = await commitAiVersionAndMessage(
      uid,
      projectId,
      newTree,
      title,
      base,
    );
    await debit();
    sse.send("version", {n: commit.n, title, files: filesChanged});
    sse.send("message", {id: commit.messageId, status: "complete"});
    sse.send("done", {ok: true});
  } catch (err) {
    logger.error("commit failed", {requestId, err});
    await debit();
    const written = await persistFailure("error", "commit_failed", true);
    sse.send("message", {id: written.id, status: "error"});
    sse.send("error", {
      code: "commit_failed",
      message: "Generated changes could not be saved. Try again.",
    });
  }
}
