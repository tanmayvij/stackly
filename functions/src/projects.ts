import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/https";
import { MODEL_PRICING, OPENAI_API_KEY, OPENAI_BASE_URL } from "./config";
import { generateProjectMeta } from "./openai";

/**
 * Rejects unauthenticated callers.
 * @param {{uid: string} | undefined} auth The callable auth context.
 * @return {string} The authenticated uid.
 */
function requireUid(auth: { uid: string } | undefined): string {
  if (!auth) {
    throw new HttpsError("unauthenticated", "Sign in to create a project.");
  }
  return auth.uid;
}

// Generates a name and description for the given prompt via the LLM, then
// stores a new project under `users/{uid}/projects/{guid}`. The document's
// auto-generated id doubles as the storage folder reference for its files.
export const createProject = onCall(
  { secrets: [OPENAI_API_KEY, OPENAI_BASE_URL] },
  async (request) => {
    const uid = requireUid(request.auth);

    const prompt = request.data?.prompt;
    if (typeof prompt !== "string" || !prompt.trim()) {
      throw new HttpsError("invalid-argument", "A prompt is required.");
    }

    const modelId = request.data?.modelId;
    if (
      typeof modelId !== "string" ||
      !MODEL_PRICING.some((m) => m.model === modelId)
    ) {
      throw new HttpsError("invalid-argument", "Unknown model id.");
    }

    const meta = await generateProjectMeta(prompt.trim());

    const ref = getFirestore()
      .collection("users")
      .doc(uid)
      .collection("projects")
      .doc();
    await ref.set({
      name: meta.name,
      description: meta.description,
      modelId,
      deleted: false,
      headVersion: 0,
      initialPrompt: prompt.trim(),
      lastMessageSeq: 0,
      createdAt: FieldValue.serverTimestamp(),
      lastModified: FieldValue.serverTimestamp(),
    });

    return {
      id: ref.id,
      name: meta.name,
      description: meta.description,
      modelId,
    };
  },
);
