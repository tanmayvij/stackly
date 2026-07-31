// Callables that resolve a pending generation turn. The chat endpoint streams
// ranked variants and commits nothing; exactly one of these two calls ends the
// turn, and applyVariant is the only place a file-changing assistant message
// is written.

import {onCall, HttpsError} from "firebase-functions/https";
import {PROJECT_ID_PATTERN} from "../../../shared/config";
import {requireUid} from "../../../shared/auth";
import {
  applyPendingVariant,
  discardPendingTurn,
  parseTurnPayload,
  parseVariantDelta,
} from "./variants.service";

/**
 * Validates the fields both callables share.
 * @param {unknown} raw The request data.
 * @return {{projectId: string, requestId: string,
 *   data: Record<string, unknown>}} The validated common fields.
 */
function common(raw: unknown): {
  projectId: string;
  requestId: string;
  data: Record<string, unknown>;
  } {
  const data = (raw ?? {}) as Record<string, unknown>;
  const projectId = data.projectId;
  if (typeof projectId !== "string" || !PROJECT_ID_PATTERN.test(projectId)) {
    throw new HttpsError("invalid-argument", "Invalid project id.");
  }
  const requestId = data.requestId;
  // The generation's request id, minted server-side and echoed back. It keys
  // both the ledger lookup and the idempotency check.
  if (
    typeof requestId !== "string" ||
    !/^[0-9a-fA-F-]{36}$/.test(requestId)
  ) {
    throw new HttpsError("invalid-argument", "Invalid request id.");
  }
  return {projectId, requestId, data};
}

// Commits the variant the user picked, together with the assistant message for
// that turn. Idempotent on requestId, and the variant's changes are rebased
// onto the current head so a manual edit made while choosing isn't reverted.
export const applyVariant = onCall({enforceAppCheck: true}, async (request) => {
  const uid = requireUid(request.auth, "Sign in to apply changes.");
  const {projectId, requestId, data} = common(request.data);
  const delta = parseVariantDelta(data.writes, data.deletes);
  const payload = parseTurnPayload(data);
  const resolved = await applyPendingVariant(
    uid,
    projectId,
    requestId,
    delta,
    payload,
  );
  return {versionN: resolved.versionN, applied: resolved.committed !== null};
});

// Drops the pending variants without committing anything, recording the turn
// as interrupted so it stays reconciled with the ledger.
export const discardVariants = onCall(
  {enforceAppCheck: true},
  async (request) => {
    const uid = requireUid(request.auth, "Sign in to discard changes.");
    const {projectId, requestId, data} = common(request.data);
    const payload = parseTurnPayload(data);
    const resolved = await discardPendingTurn(
      uid,
      projectId,
      requestId,
      payload,
    );
    return {versionN: resolved.versionN, discarded: true};
  },
);
