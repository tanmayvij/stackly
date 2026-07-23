import {onCall, HttpsError} from "firebase-functions/https";
import {PREVIEW_TOKEN_SECRET} from "../../shared/config";
import {ghlConnectionRef} from "../../shared/firestore/refs";
import {mintToken} from "./preview.service";

// Mints a preview token for the caller's connected HighLevel location.
// The frontend injects the result into the preview iframe; the token only
// grants access to the ghlProxy path allowlist, never to Firebase.
export const mintPreviewToken = onCall(
  {secrets: [PREVIEW_TOKEN_SECRET], enforceAppCheck: true},
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Sign in to preview apps.");
    }
    const uid = request.auth.uid;
    const snap = await ghlConnectionRef(uid).get();
    if (!snap.exists) {
      throw new HttpsError(
        "failed-precondition",
        "HighLevel is not connected.",
      );
    }
    const {token, expiresAtMs} = mintToken(uid);
    return {
      token,
      expiresAtMs,
      locationId: (snap.get("locationId") as string) ?? "",
    };
  },
);
