// HighLevel OAuth callables: finish the connect flow, read connection status
// (never tokens), and disconnect.

import {onCall, HttpsError} from "firebase-functions/https";
import {
  GHL_CLIENT_ID,
  GHL_CLIENT_SECRET,
  GHL_REDIRECT_URI,
} from "../../shared/config";
import {requireUid} from "../../shared/auth";
import {ghlConnectionRef} from "../../shared/firestore/refs";
import {
  fetchLocationName,
  requestGhlToken,
  scopeCount,
  writeConnection,
} from "./ghl.service";

// Finalizes the OAuth flow: exchanges the authorization code for tokens and
// stores the connection under the caller's uid. Returns only non-secret status
// for the client.
export const exchangeGhlCode = onCall(
  {secrets: [GHL_CLIENT_ID, GHL_CLIENT_SECRET, GHL_REDIRECT_URI]},
  async (request) => {
    const uid = requireUid(request.auth, "Sign in to connect HighLevel.");

    const code = request.data?.code;
    if (typeof code !== "string" || !code) {
      throw new HttpsError("invalid-argument", "Missing authorization code.");
    }
    // Must match the redirect the frontend used on the authorize screen or GHL rejects it.
    const redirectUri = GHL_REDIRECT_URI.value();
    if (!redirectUri) {
      throw new HttpsError(
        "failed-precondition",
        "HighLevel authorization failed.",
      );
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
export const getGhlConnection = onCall(
  {enforceAppCheck: true},
  async (request) => {
    const uid = requireUid(request.auth, "Sign in to connect HighLevel.");
    const snap = await ghlConnectionRef(uid).get();
    if (!snap.exists) return null;
    const scope = (snap.get("scope") as string) || "";
    return {
      locationName: (snap.get("locationName") as string) || "",
      scopesGranted: scopeCount(scope),
    };
  },
);

// Removes the caller's stored connection.
export const disconnectGhl = onCall(
  {enforceAppCheck: true},
  async (request) => {
    const uid = requireUid(request.auth, "Sign in to connect HighLevel.");
    await ghlConnectionRef(uid).delete();
    return {ok: true as const};
  },
);
