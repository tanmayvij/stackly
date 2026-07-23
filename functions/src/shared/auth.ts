// Shared authentication helpers. `requireUid` gates callables (onCall);
// `verifyAppCheck`/`verifyBearer` gate the streaming onRequest endpoints,
// which — unlike callables — must verify App Check and the ID token by hand.

import {getAppCheck} from "firebase-admin/app-check";
import {getAuth} from "firebase-admin/auth";
import {HttpsError, Request} from "firebase-functions/https";

/**
 * Rejects unauthenticated callers.
 * @param {{uid: string} | undefined} auth The callable auth context.
 * @param {string} [message] A context-specific message for the client.
 * @return {string} The authenticated uid.
 */
export function requireUid(
  auth: {uid: string} | undefined,
  message = "Sign in to continue.",
): string {
  if (!auth) throw new HttpsError("unauthenticated", message);
  return auth.uid;
}

/**
 * Verifies the App Check token from the X-Firebase-AppCheck header. onCall
 * enforces this automatically; onRequest endpoints have to do it by hand.
 * @param {Request} req The incoming request.
 * @return {Promise<boolean>} Whether the request carries a valid token.
 */
export async function verifyAppCheck(req: Request): Promise<boolean> {
  const token = req.header("X-Firebase-AppCheck");
  if (!token) return false;
  try {
    await getAppCheck().verifyToken(token);
    return true;
  } catch {
    return false;
  }
}

/**
 * Verifies the Firebase ID token from the Authorization header.
 * @param {Request} req The incoming request.
 * @return {Promise<string | null>} The uid, or null when unauthenticated.
 */
export async function verifyBearer(req: Request): Promise<string | null> {
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Bearer ")) return null;
  try {
    const decoded = await getAuth().verifyIdToken(header.slice(7));
    return decoded.uid;
  } catch {
    return null;
  }
}
