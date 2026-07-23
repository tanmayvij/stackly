// CORS helpers shared by the onRequest endpoints (chat, ghlProxy), which
// run on a different origin than cloudfunctions.net and must set their own
// CORS headers and answer the preflight.

import type {Request} from "firebase-functions/https";
import type {Response} from "express";

export interface CorsOptions {
  // The exact Access-Control-Allow-Origin value to send.
  origin: string;
  // The Access-Control-Allow-Methods value.
  methods: string;
  // The Access-Control-Allow-Headers value.
  headers: string;
  // Whether to add `Vary: Origin` (needed when the origin is reflected).
  varyOrigin?: boolean;
}

/**
 * Sets CORS response headers.
 * @param {Response} res The response to decorate.
 * @param {CorsOptions} opts The origin/methods/headers to allow.
 */
export function applyCors(res: Response, opts: CorsOptions): void {
  res.set("Access-Control-Allow-Origin", opts.origin);
  if (opts.varyOrigin) res.set("Vary", "Origin");
  res.set("Access-Control-Allow-Methods", opts.methods);
  res.set("Access-Control-Allow-Headers", opts.headers);
  res.set("Access-Control-Max-Age", "3600");
}

/**
 * Answers a CORS preflight. Call after applyCors().
 * @param {Request} req The incoming request.
 * @param {Response} res The response to end on a preflight.
 * @return {boolean} True if this was an OPTIONS preflight (already answered
 *   with 204); the caller should return immediately.
 */
export function handlePreflight(req: Request, res: Response): boolean {
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return true;
  }
  return false;
}
