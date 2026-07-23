// Short-lived HMAC tokens that let a generated app (running in Stackly's
// origin-null preview iframe, with no Firebase auth) call the ghlProxy
// function. Minted for the signed-in owner and injected into the preview
// srcdoc as window.__STACKLY_GHL__; verified stateless by the proxy.

import {createHmac, timingSafeEqual} from "node:crypto";
import {PREVIEW_TOKEN_SECRET} from "../../shared/config";

const TOKEN_TTL_MS = 30 * 60_000;
const TOKEN_VERSION = 1;

interface TokenPayload {
  v: number;
  uid: string;
  // Expiry, epoch seconds.
  exp: number;
}

/**
 * Base64url-encodes a UTF-8 string.
 * @param {string} text The text to encode.
 * @return {string} The base64url encoding.
 */
function b64url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

/**
 * Computes the HMAC-SHA256 signature of an encoded payload.
 * @param {string} encodedPayload The base64url payload half of the token.
 * @return {Buffer} The raw signature bytes.
 */
function sign(encodedPayload: string): Buffer {
  return createHmac("sha256", PREVIEW_TOKEN_SECRET.value())
    .update(encodedPayload)
    .digest();
}

/**
 * Mints a preview token for one uid.
 * @param {string} uid The owner's uid.
 * @return {{token: string, expiresAtMs: number}} The token and its expiry.
 */
export function mintToken(uid: string): {token: string; expiresAtMs: number} {
  const expiresAtMs = Date.now() + TOKEN_TTL_MS;
  const payload: TokenPayload = {
    v: TOKEN_VERSION,
    uid,
    exp: Math.floor(expiresAtMs / 1000),
  };
  const encoded = b64url(JSON.stringify(payload));
  const signature = sign(encoded).toString("base64url");
  return {token: `${encoded}.${signature}`, expiresAtMs};
}

/**
 * Verifies a preview token.
 * @param {string} token The bearer token from the proxy request.
 * @return {{uid: string} | "expired" | null} The uid when valid, "expired"
 *   for a well-signed but stale token, null for anything else.
 */
export function verifyPreviewToken(
  token: string,
): {uid: string} | "expired" | null {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const encoded = token.slice(0, dot);
  let provided: Buffer;
  try {
    provided = Buffer.from(token.slice(dot + 1), "base64url");
  } catch {
    return null;
  }
  const expected = sign(encoded);
  if (
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  ) {
    return null;
  }
  let payload: TokenPayload;
  try {
    payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as TokenPayload;
  } catch {
    return null;
  }
  if (payload.v !== TOKEN_VERSION || typeof payload.uid !== "string") {
    return null;
  }
  if (typeof payload.exp !== "number" || payload.exp * 1000 < Date.now()) {
    return "expired";
  }
  return {uid: payload.uid};
}
