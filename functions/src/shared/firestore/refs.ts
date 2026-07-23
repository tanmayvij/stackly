// Central Firestore reference builders. Every document/collection path used
// by the backend is constructed here, so a path is spelled exactly once and
// callers never rebuild `users/{uid}/projects/{id}` (or its subcollections)
// by hand. All builders read getFirestore() lazily, after bootstrap.

import {getFirestore} from "firebase-admin/firestore";

/**
 * The caller's projects collection `users/{uid}/projects`.
 * @param {string} uid The owner's uid.
 * @return {FirebaseFirestore.CollectionReference} The projects collection.
 */
export function userProjectsCollection(uid: string) {
  return getFirestore().collection("users").doc(uid).collection("projects");
}

/**
 * A single project document `users/{uid}/projects/{projectId}`.
 * @param {string} uid The owner's uid.
 * @param {string} projectId The project id.
 * @return {FirebaseFirestore.DocumentReference} The project doc ref.
 */
export function userProjectRef(uid: string, projectId: string) {
  return userProjectsCollection(uid).doc(projectId);
}

/**
 * The messages collection for a project.
 * @param {string} uid The owner's uid.
 * @param {string} projectId The project id.
 * @return {FirebaseFirestore.CollectionReference} The messages collection.
 */
export function projectMessagesCollection(uid: string, projectId: string) {
  return userProjectRef(uid, projectId).collection("messages");
}

/**
 * The versions collection for a project.
 * @param {string} uid The owner's uid.
 * @param {string} projectId The project id.
 * @return {FirebaseFirestore.CollectionReference} The versions collection.
 */
export function projectVersionsCollection(uid: string, projectId: string) {
  return userProjectRef(uid, projectId).collection("versions");
}

/**
 * The per-project chat lock doc `.../state/chat`.
 * @param {string} uid The owner's uid.
 * @param {string} projectId The project id.
 * @return {FirebaseFirestore.DocumentReference} The chat lock doc ref.
 */
export function chatLockRef(uid: string, projectId: string) {
  return userProjectRef(uid, projectId).collection("state").doc("chat");
}

/**
 * The caller's wallet doc `wallets/{uid}`.
 * @param {string} uid The owner's uid.
 * @return {FirebaseFirestore.DocumentReference} The wallet doc ref.
 */
export function walletRef(uid: string) {
  return getFirestore().collection("wallets").doc(uid);
}

/**
 * The transactions ledger `wallets/{uid}/transactions`.
 * @param {string} uid The owner's uid.
 * @return {FirebaseFirestore.CollectionReference} The transactions collection.
 */
export function walletTransactionsCollection(uid: string) {
  return walletRef(uid).collection("transactions");
}

/**
 * The caller's GHL connection doc `ghlConnections/{uid}`.
 * @param {string} uid The owner's uid.
 * @return {FirebaseFirestore.DocumentReference} The connection doc ref.
 */
export function ghlConnectionRef(uid: string) {
  return getFirestore().collection("ghlConnections").doc(uid);
}
