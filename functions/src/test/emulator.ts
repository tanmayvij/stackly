// Plumbing for the Admin-SDK emulator suites. These run under
// `firebase emulators:exec`, which sets FIRESTORE_EMULATOR_HOST and
// FIREBASE_STORAGE_EMULATOR_HOST so the Admin SDK automatically talks to the
// local emulators. One Admin app is initialized for the whole run; the clear
// helpers reset emulator state between tests so each test starts clean.

import {initializeApp, getApps} from "firebase-admin/app";
import {getStorage} from "firebase-admin/storage";

// A `demo-` project id keeps the emulator in offline mode (no credentials, no
// real project). The bucket name only has to be non-empty so
// getStorage().bucket() resolves against the Storage emulator.
export const TEST_PROJECT_ID = "demo-stackly";
export const TEST_BUCKET = "demo-stackly.appspot.com";

/**
 * Initializes the single Admin app used by every emulator suite. Idempotent.
 */
export function initTestApp(): void {
  if (getApps().length === 0) {
    initializeApp({projectId: TEST_PROJECT_ID, storageBucket: TEST_BUCKET});
  }
}

/**
 * Wipes all Firestore documents via the emulator's clear-data endpoint.
 * @return {Promise<void>} Resolves once the emulator is empty.
 */
export async function clearFirestore(): Promise<void> {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  if (!host) {
    throw new Error(
      "FIRESTORE_EMULATOR_HOST is not set — run via `firebase emulators:exec`.",
    );
  }
  const url =
    `http://${host}/emulator/v1/projects/${TEST_PROJECT_ID}` +
    "/databases/(default)/documents";
  const res = await fetch(url, {method: "DELETE"});
  if (!res.ok) {
    throw new Error(`Failed to clear Firestore emulator (${res.status}).`);
  }
}

/**
 * Deletes every object in the test bucket on the Storage emulator. A no-op if
 * the bucket is empty or has not been created yet.
 * @return {Promise<void>} Resolves once the bucket is empty.
 */
export async function clearStorage(): Promise<void> {
  try {
    await getStorage().bucket().deleteFiles();
  } catch {
    // Bucket may not exist yet on a fresh emulator — nothing to clear.
  }
}
