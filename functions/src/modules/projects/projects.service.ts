import {FLASH_MODEL} from "../../shared/config";
import {openaiClient} from "../../shared/llm/client";

// Fast + cheap; project naming is a small, latency-sensitive request.
const META_MODEL = FLASH_MODEL;

// Kept byte-identical across calls so the provider's automatic prefix caching
// hits on every request.
const META_SYSTEM_PROMPT =
  "You are given the following initial prompt for a project a user wants to " +
  "build. Write a short one-line description for this project and a suitable " +
  "name for the project. Return your response in JSON { name, description }.";

export interface ProjectMeta {
  name: string;
  description: string;
}

/**
 * Turns a user's initial project prompt into a name and one-line description
 * via a single chat-completions call. The static instruction is sent as the
 * system message (cacheable prefix) and the prompt as the user message.
 * @param {string} prompt The user's initial project prompt.
 * @return {Promise<ProjectMeta>} The generated name and description.
 */
export async function generateProjectMeta(
  prompt: string,
): Promise<ProjectMeta> {
  const completion = await openaiClient().chat.completions.create({
    model: META_MODEL,
    response_format: {type: "json_object"},
    messages: [
      {role: "system", content: META_SYSTEM_PROMPT},
      {role: "user", content: prompt},
    ],
  });

  const raw = completion.choices[0]?.message?.content;
  let parsed: Partial<ProjectMeta> = {};
  try {
    parsed = JSON.parse(raw ?? "") as Partial<ProjectMeta>;
  } catch {
    // Ignore malformed output and fall back to the defaults below.
  }

  const name =
    typeof parsed.name === "string" && parsed.name.trim() ?
      parsed.name.trim() :
      "Untitled project";
  const description =
    typeof parsed.description === "string" ? parsed.description.trim() : "";

  return {name, description};
}
