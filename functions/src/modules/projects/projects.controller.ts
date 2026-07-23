import {FieldValue} from "firebase-admin/firestore";
import {onCall, HttpsError} from "firebase-functions/https";
import {
  MAX_PROMPT_CHARS,
  MODEL_PRICING,
  OPENAI_API_KEY,
  OPENAI_BASE_URL,
} from "../../shared/config";
import {requireUid} from "../../shared/auth";
import {userProjectsCollection} from "../../shared/firestore/refs";
import {generateProjectMeta} from "./projects.service";

// Generates a name and description for the given prompt via the LLM, then
// stores a new project under `users/{uid}/projects/{guid}`. The document's
// auto-generated id doubles as the storage folder reference for its files.
export const createProject = onCall(
  {secrets: [OPENAI_API_KEY, OPENAI_BASE_URL], enforceAppCheck: true},
  async (request) => {
    const uid = requireUid(request.auth, "Sign in to create a project.");

    const prompt = request.data?.prompt;
    if (typeof prompt !== "string" || !prompt.trim()) {
      throw new HttpsError("invalid-argument", "A prompt is required.");
    }
    if (prompt.length > MAX_PROMPT_CHARS) {
      throw new HttpsError(
        "invalid-argument",
        `The prompt must be at most ${MAX_PROMPT_CHARS} characters.`,
      );
    }

    const modelId = request.data?.modelId;
    if (
      typeof modelId !== "string" ||
      !MODEL_PRICING.some((m) => m.model === modelId)
    ) {
      throw new HttpsError("invalid-argument", "Unknown model id.");
    }

    const meta = await generateProjectMeta(prompt.trim());

    const ref = userProjectsCollection(uid).doc();
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
