import {getFirestore, FieldValue, Timestamp} from "firebase-admin/firestore";
import {onCall, HttpsError} from "firebase-functions/https";
import {GHL_CLIENT_ID, GHL_CLIENT_SECRET} from "./config";

const TOKEN_URL = "https://services.leadconnectorhq.com/oauth/token";
export const API_BASE = "https://services.leadconnectorhq.com";
// API version for CRM resource endpoints and the token endpoint.
export const API_VERSION = "v3";

// The subset of GetAccessTokenSuccessfulResponseDto we consume. All GHL tokens
// in this app are minted with userType "Location", so `locationId` is present.
interface GhlTokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string;
  userType: string;
  locationId?: string;
  companyId?: string;
  userId: string;
}

interface GhlConnectionDoc {
  accessToken: string;
  refreshToken: string;
  expiresAt: Timestamp;
  scope: string;
  userType: string;
  locationId: string;
  companyId?: string;
  userId: string;
  locationName: string;
  connectedAt: Timestamp | FirebaseFirestore.FieldValue;
  updatedAt: Timestamp | FirebaseFirestore.FieldValue;
}

/**
 * Returns the per-user connection document `ghlConnections/{uid}`.
 * @param {string} uid The owner's uid.
 * @return {FirebaseFirestore.DocumentReference} The connection doc ref.
 */
function connectionDoc(uid: string) {
  return getFirestore().collection("ghlConnections").doc(uid);
}

/**
 * Rejects unauthenticated callers.
 * @param {{uid: string} | undefined} auth The callable auth context.
 * @return {string} The authenticated uid.
 */
function requireUid(auth: { uid: string } | undefined): string {
  if (!auth) {
    throw new HttpsError("unauthenticated", "Sign in to connect HighLevel.");
  }
  return auth.uid;
}

interface TokenRequestParams {
  grantType: "authorization_code" | "refresh_token";
  // Required for authorization_code.
  code?: string;
  redirectUri?: string;
  // Required for refresh_token.
  refreshToken?: string;
}

/**
 * The reusable core of the OAuth flow: exchanges either an authorization code
 * or a refresh token for a fresh set of Location-scoped tokens. Uses the global
 * `fetch` (Node 24) with a form-encoded body — no HighLevel SDK needed.
 * @param {TokenRequestParams} params The grant type and its inputs.
 * @return {Promise<GhlTokenResponse>} The parsed token response.
 */
async function requestGhlToken(
  params: TokenRequestParams,
): Promise<GhlTokenResponse> {
  const body = new URLSearchParams({
    clientId: GHL_CLIENT_ID.value(),
    clientSecret: GHL_CLIENT_SECRET.value(),
    grantType: params.grantType,
    userType: "Location",
  });
  if (params.grantType === "authorization_code") {
    if (!params.code || !params.redirectUri) {
      throw new HttpsError(
        "invalid-argument",
        "code and redirectUri are required for the authorization_code grant.",
      );
    }
    body.set("code", params.code);
    body.set("redirectUri", params.redirectUri);
  } else {
    if (!params.refreshToken) {
      throw new HttpsError(
        "invalid-argument",
        "refreshToken is required for the refresh_token grant.",
      );
    }
    body.set("refreshToken", params.refreshToken);
  }

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json",
      "Version": "v3",
    },
    body,
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      (payload && (payload.message || payload.error)) ||
      `HighLevel token request failed (${response.status}).`;
    // 4xx is almost always a bad/expired code or refresh token (client's
    // fault); anything else is treated as an upstream failure.
    const code = response.status >= 400 && response.status < 500 ?
      "invalid-argument" :
      "internal";
    throw new HttpsError(code, String(message));
  }

  return payload as GhlTokenResponse;
}

/**
 * Looks up the friendly name of a location. Falls back to the location id if
 * the call fails, so a missing name never breaks the connect flow.
 * @param {string} accessToken A Location-scoped access token.
 * @param {string} locationId The location to look up.
 * @return {Promise<string>} The location name, or the id as a fallback.
 */
async function fetchLocationName(
  accessToken: string,
  locationId: string,
): Promise<string> {
  try {
    const response = await fetch(`${API_BASE}/locations/${locationId}`, {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Accept": "application/json",
        "Version": API_VERSION,
      },
    });

    if (!response.ok) return locationId;
    const payload = await response.json();
    return payload?.location?.name || locationId;
  } catch {
    return locationId;
  }
}

/**
 * Persists a token response as the user's GHL connection. Tokens are stored
 * server-side only — Firestore rules deny all client access.
 * @param {string} uid The owner's uid.
 * @param {GhlTokenResponse} token The token response to persist.
 * @param {string} locationName The resolved friendly location name.
 * @param {boolean} isNew Whether this is a new connection (stamps connectedAt).
 * @return {Promise<void>} Resolves once written.
 */
async function writeConnection(
  uid: string,
  token: GhlTokenResponse,
  locationName: string,
  isNew: boolean,
): Promise<void> {
  const expiresAt = Timestamp.fromMillis(
    Date.now() + token.expiresIn * 1000,
  );
  const data: Partial<GhlConnectionDoc> = {
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresAt,
    scope: token.scope,
    userType: token.userType,
    locationId: token.locationId as string,
    userId: token.userId,
    locationName,
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (token.companyId) data.companyId = token.companyId;
  if (isNew) data.connectedAt = FieldValue.serverTimestamp();

  await connectionDoc(uid).set(data, {merge: true});
}

/**
 * Refreshes a stored connection using its refresh token. Exported for reuse by
 * future token consumers; not wired to any scheduled trigger yet.
 * @param {string} uid The owner's uid.
 * @return {Promise<string>} The fresh access token.
 */
export async function refreshConnection(uid: string): Promise<string> {
  const snap = await connectionDoc(uid).get();
  const refreshToken = snap.get("refreshToken");
  if (!snap.exists || typeof refreshToken !== "string") {
    throw new HttpsError("not-found", "No HighLevel connection to refresh.");
  }

  const token = await requestGhlToken({
    grantType: "refresh_token",
    refreshToken,
  });
  const locationName = token.locationId ?
    await fetchLocationName(token.accessToken, token.locationId) :
    (snap.get("locationName") as string);
  await writeConnection(uid, token, locationName, false);
  return token.accessToken;
}

/**
 * Number of scopes granted, derived from the space-separated scope string.
 * @param {string} scope The scope string.
 * @return {number} The scope count.
 */
function scopeCount(scope: string): number {
  return scope.split(" ").filter(Boolean).length;
}

// Finalizes the OAuth flow: exchanges the authorization code for tokens and
// stores the connection under the caller's uid. Returns only non-secret status
// for the client.
export const exchangeGhlCode = onCall(
  {secrets: [GHL_CLIENT_ID, GHL_CLIENT_SECRET]},
  async (request) => {
    const uid = requireUid(request.auth);

    const code = request.data?.code;
    const redirectUri = request.data?.redirectUri;
    if (typeof code !== "string" || !code) {
      throw new HttpsError("invalid-argument", "Missing authorization code.");
    }
    if (typeof redirectUri !== "string" || !redirectUri) {
      throw new HttpsError("invalid-argument", "Missing redirectUri.");
    }

    const token = await requestGhlToken({
      grantType: "authorization_code",
      code,
      redirectUri,
    });
    // Only sub-account (Location) installs are supported. Agency (Company)
    // installs return a companyId with no locationId, which this app can't use.
    if (token.userType !== "Location" || !token.locationId) {
      throw new HttpsError(
        "failed-precondition",
        "Connect Stackly to a HighLevel sub-account, not an agency. " +
        "Choose a single location on the authorization screen and retry.",
      );
    }

    const locationName = await fetchLocationName(
      token.accessToken,
      token.locationId,
    );
    await writeConnection(uid, token, locationName, true);

    return {locationName, scopesGranted: scopeCount(token.scope)};
  },
);

// Returns the caller's current connection status (never any tokens), or null
// if HighLevel is not connected. Used to seed the store on login.
export const getGhlConnection = onCall(async (request) => {
  const uid = requireUid(request.auth);
  const snap = await connectionDoc(uid).get();
  if (!snap.exists) return null;
  const scope = (snap.get("scope") as string) || "";
  return {
    locationName: (snap.get("locationName") as string) || "",
    scopesGranted: scopeCount(scope),
  };
});

// Removes the caller's stored connection.
export const disconnectGhl = onCall(async (request) => {
  const uid = requireUid(request.auth);
  await connectionDoc(uid).delete();
  return {ok: true as const};
});
