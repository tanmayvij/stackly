// Server-side GHL proxy for generated apps. The preview iframe calls this
// with a short-lived preview token (see modules/preview); the proxy owns
// the real GHL credentials end-to-end: it preemptively refreshes the access
// token, pins the connected locationId onto every request, restricts the
// reachable surface to the three allowed API families, and forwards the
// response verbatim. Generated code never sees a GHL token.

import {onRequest} from "firebase-functions/https";
import * as logger from "firebase-functions/logger";
import {Timestamp} from "firebase-admin/firestore";
import {
  GHL_CLIENT_ID,
  GHL_CLIENT_SECRET,
  PREVIEW_TOKEN_SECRET,
} from "../../shared/config";
import {applyCors, handlePreflight} from "../../shared/http";
import {ghlConnectionRef} from "../../shared/firestore/refs";
import {API_BASE, API_VERSION, refreshConnection} from "./ghl.service";
import {verifyPreviewToken} from "../preview/preview.service";

const ALLOWED_PATH = /^\/(contacts|conversations|calendars)(\/|$)/;
const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "DELETE"]);

/**
 * Whether the proxy may forward a request to this path. The reachable surface
 * is restricted to the contacts, conversations, and calendars API families,
 * and any path-traversal segment is rejected outright.
 * @param {string} path The request path (e.g. "/contacts/123").
 * @return {boolean} True if the path is allowed.
 */
export function isAllowedGhlPath(path: string): boolean {
  return ALLOWED_PATH.test(path) && !path.includes("..");
}
// Refresh the stored access token when it expires within this margin, so
// only our backend ever exercises the refresh grant.
const REFRESH_MARGIN_MS = 5 * 60_000;
const UPSTREAM_TIMEOUT_MS = 25_000;

export const ghlProxy = onRequest(
  {
    secrets: [GHL_CLIENT_ID, GHL_CLIENT_SECRET, PREVIEW_TOKEN_SECRET],
    timeoutSeconds: 60,
  },
  async (req, res) => {
    // The preview iframe is origin-null, so the only workable CORS origin
    // is the wildcard. The bearer token is the actual access control.
    applyCors(res, {
      origin: "*",
      methods: "GET, POST, PUT, DELETE, OPTIONS",
      headers: "Authorization, Content-Type",
    });
    if (handlePreflight(req, res)) return;
    if (!ALLOWED_METHODS.has(req.method)) {
      res.status(405).json({error: "method_not_allowed"});
      return;
    }

    const header = req.headers.authorization ?? "";
    const verdict = header.startsWith("Bearer ") ?
      verifyPreviewToken(header.slice(7)) :
      null;
    if (verdict === "expired") {
      res.status(401).json({error: "preview_token_expired"});
      return;
    }
    if (!verdict) {
      res.status(401).json({error: "unauthenticated"});
      return;
    }
    const uid = verdict.uid;

    const path = req.path;
    if (!isAllowedGhlPath(path)) {
      res.status(403).json({error: "path_not_allowed"});
      return;
    }

    const snap = await ghlConnectionRef(uid).get();
    if (!snap.exists) {
      res.status(409).json({error: "ghl_not_connected"});
      return;
    }
    let accessToken = snap.get("accessToken") as string;
    const locationId = (snap.get("locationId") as string) ?? "";
    const expiresAt = snap.get("expiresAt") as Timestamp | undefined;

    if (
      !expiresAt ||
      expiresAt.toMillis() - Date.now() < REFRESH_MARGIN_MS
    ) {
      try {
        accessToken = await refreshConnection(uid);
      } catch (err) {
        logger.error("preemptive GHL refresh failed", {uid, err});
        res.status(502).json({error: "ghl_refresh_failed"});
        return;
      }
    }

    // Pin the connected location onto the request (overwriting anything
    // the generated app sent): query for reads, body for writes.
    const qIndex = req.url.indexOf("?");
    const search = new URLSearchParams(
      qIndex >= 0 ? req.url.slice(qIndex + 1) : "",
    );
    let body: string | undefined;
    if (req.method === "GET" || req.method === "DELETE") {
      search.set("locationId", locationId);
    } else {
      const payload =
        req.body && typeof req.body === "object" ?
          (req.body as Record<string, unknown>) :
          {};
      payload.locationId = locationId;
      body = JSON.stringify(payload);
    }
    const query = search.toString();
    const url = `${API_BASE}${path}${query ? `?${query}` : ""}`;

    /**
     * Forwards the request upstream with the given access token.
     * @param {string} token The GHL access token to send.
     * @return {Promise<globalThis.Response>} The upstream response.
     */
    const forward = (token: string) =>
      fetch(url, {
        method: req.method,
        headers: {
          "Authorization": `Bearer ${token}`,
          "Version": API_VERSION,
          "Accept": "application/json",
          ...(body ? {"Content-Type": "application/json"} : {}),
        },
        body,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });

    try {
      let upstream = await forward(accessToken);
      if (upstream.status === 401) {
        // The stored token was revoked or expired early: refresh once and
        // retry before giving up.
        try {
          accessToken = await refreshConnection(uid);
          upstream = await forward(accessToken);
        } catch (err) {
          logger.warn("GHL refresh-on-401 failed", {uid, err});
        }
      }
      const text = await upstream.text();
      res.status(upstream.status);
      try {
        res.json(JSON.parse(text));
      } catch {
        res.send(text);
      }
    } catch (err) {
      logger.error("GHL upstream request failed", {uid, path, err});
      res.status(502).json({error: "ghl_unreachable"});
    }
  },
);
