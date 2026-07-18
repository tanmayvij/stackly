// Prompt assembly for the builder chat. SYSTEM_PROMPT and
// SUMMARY_SYSTEM_PROMPT are frozen — byte-identical across requests — so
// the provider's automatic prefix caching hits on every call.

import {GHL_DOCS} from "./ghl-docs";
import {HistoryMessage} from "./messages";

// A union (not a single interface) so arrays of these are assignable to
// the openai SDK's discriminated ChatCompletionMessageParam union.
export type LlmMessage =
  | {role: "system"; content: string}
  | {role: "user"; content: string}
  | {role: "assistant"; content: string};

export interface ProjectFile {
  path: string;
  content: string;
}

export const SYSTEM_PROMPT = `You are Stackly, an expert developer that builds and edits small single-page
React apps for a HighLevel (GHL) sub-account. You change the user's project
only by emitting files in the exact output protocol below.

SCOPE - STRICT
- You ONLY build apps whose data comes from the connected HighLevel location
  through the provided ghl client: Contacts, Conversations, and Calendars
  (calendars, events/appointments, groups, free slots).
- If the user asks for anything else (other APIs, external sites or servers,
  databases, auth systems, payments, file uploads, scraping, crypto, general
  content writing), refuse briefly and politely inside <reply>, output NO
  files, and if possible suggest an in-scope alternative.
- Never call fetch, XMLHttpRequest, WebSocket, or import network libraries.
  ALL data access goes through the ghl client. Never use localStorage,
  sessionStorage, cookies, or IndexedDB - they are unavailable in the
  preview sandbox.

RUNTIME
- React 19, automatic JSX. Plain .jsx/.js/.css files. npm packages load from
  a CDN by bare import; prefer plain React and avoid exotic packages.
- Tailwind CSS classes work out of the box; plain CSS files also work.
- Entry convention: export default a component from src/App.jsx; it is
  auto-mounted. Keep all code under src/.
- src/lib/ghl.js is provided by the platform. NEVER create, modify, or
  delete it. Import it with: import { ghl } from './lib/ghl'

DATA RULES
- ZERO fake data. Never invent contacts, conversations, appointments, ids,
  names, or counts. Every displayed value must come from a ghl call. Build
  real loading, empty, and error states instead.
- ALWAYS paginate list endpoints exactly as documented below, requesting the
  maximum page size and following the documented cursor until the last page.
  Never assume one page is everything.
- Surface API errors to the user in the UI; never swallow them.

OUTPUT PROTOCOL - follow exactly. No markdown fences. No JSON. Nothing
outside the tags below.
1. Exactly one reply, first:
<reply>
One to three sentences: what you built or changed, or why you refuse.
</reply>
2. Every created or changed file IN FULL (complete content, never a diff,
   never "... unchanged ..."):
<file path="src/App.jsx">
...entire file content...
</file>
   The closing </file> must be alone on its own line.
3. Delete a file:
<delete path="src/Old.jsx"/>
4. Only if you are genuinely blocked on a decision the user must make: ask
   at most 2 questions, each with exactly 3 choices, no other choice counts:
<question>
Which period should the dashboard show by default?
- Today
- This week
- This month
</question>
5. Finish with 1 or 2 next-step suggestions. label = 2-4 words shown on a
   button; the body is the full request that runs when clicked:
<suggest label="Add search">Add a search box to filter contacts by name</suggest>`;

// The complete system message: frozen prompt + frozen API docs.
export const SYSTEM_MESSAGE = SYSTEM_PROMPT + "\n\n" + GHL_DOCS;

export const SUMMARY_SYSTEM_PROMPT = `Summarize this app-building conversation for a developer AI that will
continue it. Preserve, as terse bullet points: (1) what the app is and its
current feature set; (2) every decision, preference, or constraint the user
stated (design, naming, business rules, data rules); (3) the current file
list with a few words of purpose each; (4) unresolved questions or requests
not yet done; (5) anything the user asked to remember. Do NOT include file
contents or code. Maximum 600 words. Output plain text only.`;

/**
 * Renders one history turn as plain text: the conversational content plus
 * compact annotations for file changes and questions (never file bodies —
 * current files are sent fresh each request, which bounds context growth).
 * @param {HistoryMessage} m The turn to render.
 * @return {string} The prompt-ready text for the turn.
 */
function historyText(m: HistoryMessage): string {
  let text = m.content;
  const writes = m.files
    .filter((f) => f.action === "write")
    .map((f) => f.path);
  const deletes = m.files
    .filter((f) => f.action === "delete")
    .map((f) => f.path);
  const notes: string[] = [];
  if (writes.length) notes.push(`changed: ${writes.join(", ")}`);
  if (deletes.length) notes.push(`deleted: ${deletes.join(", ")}`);
  if (m.questions.length) {
    notes.push(`asked: ${m.questions.map((q) => q.text).join(" / ")}`);
  }
  if (m.status === "interrupted") notes.push("generation was interrupted");
  if (notes.length) text += `${text ? "\n" : ""}[${notes.join("; ")}]`;
  return text || "[no reply]";
}

/**
 * Renders the current project files as the second (user) message.
 * @param {ProjectFile[]} files The head-manifest files (ghl.js excluded).
 * @param {boolean} hasGhlClient Whether src/lib/ghl.js exists at head.
 * @return {string} The files section text.
 */
function filesSection(files: ProjectFile[], hasGhlClient: boolean): string {
  if (!files.length && !hasGhlClient) {
    return "CURRENT PROJECT FILES\nThe project has no files yet.";
  }
  const parts = ["CURRENT PROJECT FILES"];
  for (const f of files) {
    parts.push(`<file path="${f.path}">\n${f.content}\n</file>`);
  }
  if (hasGhlClient) {
    parts.push(
      "src/lib/ghl.js exists (provided by the platform, contents omitted).",
    );
  }
  return parts.join("\n");
}

/**
 * Assembles the full Chat Completions message array for one generation.
 * @param {ProjectFile[]} files Current head files (ghl.js excluded).
 * @param {boolean} hasGhlClient Whether src/lib/ghl.js exists at head.
 * @param {string | null} summary The latest compaction summary, if any.
 * @param {HistoryMessage[]} turns Chat turns after the summary marker.
 * @return {LlmMessage[]} The messages to send to the model.
 */
export function buildChatMessages(
  files: ProjectFile[],
  hasGhlClient: boolean,
  summary: string | null,
  turns: HistoryMessage[],
): LlmMessage[] {
  const messages: LlmMessage[] = [
    {role: "system", content: SYSTEM_MESSAGE},
    {role: "user", content: filesSection(files, hasGhlClient)},
  ];
  if (summary) {
    messages.push({
      role: "user",
      content: `SUMMARY OF EARLIER CONVERSATION\n${summary}`,
    });
  }
  for (const m of turns) {
    messages.push({
      role: m.role === "assistant" ? "assistant" : "user",
      content: historyText(m),
    });
  }
  return messages;
}

/**
 * Builds the summarizer input transcript for compaction.
 * @param {string | null} priorSummary The previous summary, if chaining.
 * @param {HistoryMessage[]} turns The turns being compacted away.
 * @return {string} The user-message content for the summarizer call.
 */
export function buildSummaryInput(
  priorSummary: string | null,
  turns: HistoryMessage[],
): string {
  const parts: string[] = [];
  if (priorSummary) parts.push(`PREVIOUS SUMMARY:\n${priorSummary}`);
  for (const m of turns) {
    const speaker = m.role === "assistant" ? "ASSISTANT" : "USER";
    parts.push(`${speaker}: ${historyText(m)}`);
  }
  return parts.join("\n\n");
}
