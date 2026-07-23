// Incremental parser for the tagged output protocol the code-generation
// model streams back (see chat/prompt.ts OUTPUT PROTOCOL). Pure and I/O-free
// so it can be unit tested against arbitrary chunk boundaries.
//
// Grammar (tolerant, line-oriented where it matters):
//   <reply>conversational text</reply>
//   <file path="src/App.jsx">
//   ...entire file content...
//   </file>                      <- closer alone on its own line
//   <delete path="src/Old.jsx"/>
//   <question>
//   Question text
//   - choice
//   - choice
//   - choice
//   </question>
//   <suggest label="Short label">full prompt to run when clicked</suggest>
//
// Text outside any tag is treated as reply text (weak-model tolerance) and
// unrecognized tags are passed through as literal text.

export type ParseEvent =
  | {type: "reply-delta"; text: string}
  | {type: "file-start"; path: string}
  | {type: "file-delta"; path: string; text: string}
  | {type: "file-end"; path: string}
  | {type: "file-delete"; path: string}
  | {type: "question"; text: string; choices: string[]}
  | {type: "suggestion"; label: string; prompt: string}
  | {type: "warning"; reason: string};

export interface ParseFinish {
  events: ParseEvent[];
  // Path of a <file> block the stream ended inside of, if any. A non-null
  // value means the output is malformed and MUST NOT be committed.
  incompleteFile: string | null;
  // Count of <file> blocks with a missing/invalid path whose content was
  // skipped. Non-zero also means the output MUST NOT be committed.
  invalidFileBlocks: number;
  warnings: string[];
}

type State = "text" | "reply" | "file" | "question" | "suggest";

// Longest run held back while a possibly chunk-split tag finishes arriving.
const MAX_TAG_LEN = 512;

// A <file> closer strictly alone on its own line, terminated by a newline.
const FILE_CLOSER_MID = /\r?\n[ \t]*<\/file>[ \t]*\r?\n/;
// Same, but terminated by end-of-input (only valid in finish()).
const FILE_CLOSER_END = /\r?\n[ \t]*<\/file>[ \t]*$/;
// Closers at the very start of a block (empty file, no leading newline).
const FILE_CLOSER_FIRST_MID = /^[ \t]*<\/file>[ \t]*\r?\n/;
const FILE_CLOSER_FIRST_END = /^[ \t]*<\/file>[ \t]*$/;

const FILE_OPEN = /^<file\s+path\s*=\s*(?:"([^"]+)"|'([^']+)')\s*>$/;
const DELETE_TAG = /^<delete\s+path\s*=\s*(?:"([^"]+)"|'([^']+)')\s*\/?\s*>$/;
const SUGGEST_OPEN =
  /^<suggest(?:\s+label\s*=\s*(?:"([^"]*)"|'([^']*)'))?\s*>$/;
const CHOICE_LINE = /^(?:[-*•]|\d+[.)])\s+(.+)$/;

// Fixed tags recognized in text/reply state. Orphan closers are consumed
// (with a warning) instead of leaking into the reply text.
const FIXED_TAGS = [
  "<reply>",
  "</reply>",
  "<question>",
  "</question>",
  "</file>",
  "</suggest>",
  "</delete>",
];
const ATTR_TAG_NAMES = ["<file", "<delete", "<suggest"];

/**
 * Whether `s` (which contains no ">") could still grow into a recognized
 * tag once more input arrives.
 * @param {string} s The buffered text starting at "<".
 * @return {boolean} True if we should wait for more input.
 */
function couldBeTagPrefix(s: string): boolean {
  for (const tag of FIXED_TAGS) {
    if (tag.startsWith(s)) return true;
  }
  for (const name of ATTR_TAG_NAMES) {
    if (name.startsWith(s)) return true;
    if (s.startsWith(name)) {
      const c = s.charAt(name.length);
      if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "/") {
        return true;
      }
    }
  }
  return false;
}

/**
 * Whether `line` (the text after the last newline) could still grow into a
 * `</file>` closer line once more input arrives.
 * @param {string} line The trailing partial line of a file block.
 * @return {boolean} True if the tail must be held back.
 */
function couldBeCloserPrefix(line: string): boolean {
  let i = 0;
  while (i < line.length && (line[i] === " " || line[i] === "\t")) i++;
  const rest = line.slice(i);
  const tag = "</file>";
  if (rest.length <= tag.length) return tag.startsWith(rest);
  if (!rest.startsWith(tag)) return false;
  return /^[ \t]*\r?$/.test(rest.slice(tag.length));
}

/**
 * Incremental state-machine parser. Feed stream deltas via push() and call
 * finish() exactly once when the stream ends.
 */
export class LlmStreamParser {
  private buf = "";
  private state: State = "text";
  private filePath = "";
  private fileSkip = false;
  private fileEmitted = false;
  private suggestLabel = "";
  private invalidFiles = 0;
  private warningsList: string[] = [];
  private done = false;

  /**
   * Consumes one stream delta and returns the events it completed.
   * @param {string} delta The next chunk of model output.
   * @return {ParseEvent[]} Events parsed out of the buffered input so far.
   */
  push(delta: string): ParseEvent[] {
    if (this.done) throw new Error("push() after finish()");
    this.buf += delta;
    const events: ParseEvent[] = [];
    let again = true;
    while (again) {
      switch (this.state) {
      case "text":
      case "reply":
        again = this.scanText(events);
        break;
      case "file":
        again = this.scanFile(events);
        break;
      case "question":
        again = this.scanBlock(events, "question");
        break;
      case "suggest":
        again = this.scanBlock(events, "suggest");
        break;
      }
    }
    return events;
  }

  /**
   * Flushes any pending state at end-of-stream.
   * @return {ParseFinish} Final events plus malformed-output indicators.
   */
  finish(): ParseFinish {
    if (this.done) throw new Error("finish() called twice");
    this.done = true;
    const events: ParseEvent[] = [];
    let incompleteFile: string | null = null;

    if (this.state === "text" || this.state === "reply") {
      this.flushText(events, this.buf);
    } else if (this.state === "file") {
      const m =
        FILE_CLOSER_END.exec(this.buf) ||
        (this.fileEmitted ? null : FILE_CLOSER_FIRST_END.exec(this.buf));
      if (m) {
        this.emitFileDelta(events, this.buf.slice(0, m.index));
        if (!this.fileSkip) {
          events.push({type: "file-end", path: this.filePath});
        }
      } else if (this.fileSkip) {
        this.warn(events, "stream ended inside a malformed <file> block");
      } else {
        incompleteFile = this.filePath;
        this.warn(
          events,
          `stream ended inside <file path="${this.filePath}">`,
        );
      }
    } else {
      this.warn(events, `stream ended inside <${this.state}> block`);
    }
    this.buf = "";

    return {
      events,
      incompleteFile,
      invalidFileBlocks: this.invalidFiles,
      warnings: this.warningsList,
    };
  }

  /**
   * Records a warning both as an inline event and in the summary list.
   * @param {ParseEvent[]} events The event sink for the current push.
   * @param {string} reason Human-readable description of the anomaly.
   */
  private warn(events: ParseEvent[], reason: string): void {
    this.warningsList.push(reason);
    events.push({type: "warning", reason});
  }

  /**
   * Emits buffered text as reply content. In "text" state (outside any
   * <reply> block) whitespace-only runs are dropped so newlines between
   * blocks don't pollute the reply.
   * @param {ParseEvent[]} events The event sink for the current push.
   * @param {string} text The raw text run to flush.
   */
  private flushText(events: ParseEvent[], text: string): void {
    if (!text) return;
    if (this.state === "text" && !/\S/.test(text)) return;
    events.push({type: "reply-delta", text});
  }

  /**
   * Scans text/reply state: plain text runs interleaved with tags.
   * @param {ParseEvent[]} events The event sink for the current push.
   * @return {boolean} True if the state changed and scanning should resume.
   */
  private scanText(events: ParseEvent[]): boolean {
    for (;;) {
      const lt = this.buf.indexOf("<");
      if (lt === -1) {
        this.flushText(events, this.buf);
        this.buf = "";
        return false;
      }
      if (lt > 0) {
        this.flushText(events, this.buf.slice(0, lt));
        this.buf = this.buf.slice(lt);
      }
      const gt = this.buf.indexOf(">");
      if (gt === -1) {
        if (this.buf.length < MAX_TAG_LEN && couldBeTagPrefix(this.buf)) {
          return false;
        }
        this.flushText(events, "<");
        this.buf = this.buf.slice(1);
        continue;
      }
      const tag = this.buf.slice(0, gt + 1);
      if (!this.applyTag(tag, events)) {
        this.flushText(events, "<");
        this.buf = this.buf.slice(1);
        continue;
      }
      this.buf = this.buf.slice(tag.length);
      if (this.state !== "text" && this.state !== "reply") return true;
    }
  }

  /**
   * Interprets one complete "<...>" run in text/reply state.
   * @param {string} tag The candidate tag text including both brackets.
   * @param {ParseEvent[]} events The event sink for the current push.
   * @return {boolean} True if consumed as a tag, false to treat "<" as
   *   literal text.
   */
  private applyTag(tag: string, events: ParseEvent[]): boolean {
    if (tag === "<reply>") {
      this.state = "reply";
      return true;
    }
    if (tag === "</reply>") {
      this.state = "text";
      return true;
    }
    if (tag === "<question>") {
      this.state = "question";
      return true;
    }
    if (tag === "</delete>") return true;
    if (tag === "</question>" || tag === "</file>" || tag === "</suggest>") {
      this.warn(events, `orphan ${tag} ignored`);
      return true;
    }

    let m = FILE_OPEN.exec(tag);
    if (m) {
      this.filePath = (m[1] ?? m[2]) as string;
      this.fileSkip = false;
      this.fileEmitted = false;
      this.state = "file";
      events.push({type: "file-start", path: this.filePath});
      return true;
    }
    if (/^<file[\s/>]/.test(tag)) {
      this.warn(events, `malformed file tag ${tag} — block skipped`);
      this.invalidFiles += 1;
      this.filePath = "";
      this.fileSkip = true;
      this.fileEmitted = false;
      this.state = "file";
      return true;
    }

    m = DELETE_TAG.exec(tag);
    if (m) {
      events.push({type: "file-delete", path: (m[1] ?? m[2]) as string});
      return true;
    }
    if (/^<delete[\s/>]/.test(tag)) {
      this.warn(events, `malformed delete tag ${tag} ignored`);
      return true;
    }

    m = SUGGEST_OPEN.exec(tag);
    if (m) {
      this.suggestLabel = (m[1] ?? m[2] ?? "").trim();
      this.state = "suggest";
      return true;
    }
    if (/^<suggest[\s/>]/.test(tag)) {
      this.warn(events, `malformed suggest tag ${tag} ignored`);
      return true;
    }

    return false;
  }

  /**
   * Scans file state: streams content deltas while holding back any tail
   * that could still turn out to be the block closer.
   * @param {ParseEvent[]} events The event sink for the current push.
   * @return {boolean} True if the block closed and scanning should resume.
   */
  private scanFile(events: ParseEvent[]): boolean {
    let m = FILE_CLOSER_MID.exec(this.buf);
    if (!m && !this.fileEmitted) m = FILE_CLOSER_FIRST_MID.exec(this.buf);
    if (m) {
      this.emitFileDelta(events, this.buf.slice(0, m.index));
      if (!this.fileSkip) {
        events.push({type: "file-end", path: this.filePath});
      }
      this.buf = this.buf.slice(m.index + (m[0] ?? "").length);
      this.state = "text";
      return true;
    }

    // No complete closer yet: emit everything that can no longer be part
    // of one. A closer needs its own line, so hold the trailing partial
    // line only when it still looks like one (plus any trailing "\r").
    let holdFrom = this.buf.length;
    if (this.buf.endsWith("\r")) holdFrom -= 1;
    const searchable = this.buf.slice(0, holdFrom);
    const nl = searchable.lastIndexOf("\n");
    if (nl === -1) {
      if (!this.fileEmitted && couldBeCloserPrefix(searchable)) return false;
      this.emitFileDelta(events, searchable);
      this.buf = this.buf.slice(holdFrom);
      return false;
    }
    const tail = searchable.slice(nl + 1);
    if (couldBeCloserPrefix(tail)) {
      this.emitFileDelta(events, searchable.slice(0, nl));
      this.buf = this.buf.slice(nl);
    } else {
      this.emitFileDelta(events, searchable);
      this.buf = this.buf.slice(holdFrom);
    }
    return false;
  }

  /**
   * Emits one file content delta, stripping the single newline that
   * follows the opening tag and suppressing output for skipped blocks.
   * @param {ParseEvent[]} events The event sink for the current push.
   * @param {string} raw The raw content run (pre-strip).
   */
  private emitFileDelta(events: ParseEvent[], raw: string): void {
    if (raw === "") return;
    let text = raw;
    if (!this.fileEmitted) {
      text = text.replace(/^\r?\n/, "");
      this.fileEmitted = true;
    }
    if (text && !this.fileSkip) {
      events.push({type: "file-delta", path: this.filePath, text});
    }
  }

  /**
   * Scans question/suggest state: buffers until the closing tag arrives
   * (these blocks are small, so no incremental deltas are emitted).
   * @param {ParseEvent[]} events The event sink for the current push.
   * @param {"question" | "suggest"} kind Which block is being buffered.
   * @return {boolean} True if the block closed and scanning should resume.
   */
  private scanBlock(
    events: ParseEvent[],
    kind: "question" | "suggest",
  ): boolean {
    const closer = kind === "question" ? "</question>" : "</suggest>";
    const idx = this.buf.indexOf(closer);
    if (idx === -1) return false;
    const raw = this.buf.slice(0, idx);
    this.buf = this.buf.slice(idx + closer.length);
    this.state = "text";
    if (kind === "question") {
      this.emitQuestion(events, raw);
    } else {
      this.emitSuggestion(events, raw);
    }
    return true;
  }

  /**
   * Parses a buffered question block into text + choices.
   * @param {ParseEvent[]} events The event sink for the current push.
   * @param {string} raw The block content between the tags.
   */
  private emitQuestion(events: ParseEvent[], raw: string): void {
    const textLines: string[] = [];
    const choices: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const m = CHOICE_LINE.exec(trimmed);
      if (m) {
        choices.push((m[1] ?? "").trim());
      } else {
        textLines.push(trimmed);
      }
    }
    events.push({type: "question", text: textLines.join(" "), choices});
  }

  /**
   * Parses a buffered suggestion block, deriving a label when absent.
   * @param {ParseEvent[]} events The event sink for the current push.
   * @param {string} raw The block content between the tags.
   */
  private emitSuggestion(events: ParseEvent[], raw: string): void {
    const prompt = raw.trim();
    if (!prompt) {
      this.warn(events, "empty <suggest> block dropped");
      return;
    }
    const label =
      this.suggestLabel ||
      prompt.split(/\s+/).slice(0, 4).join(" ").replace(/[,.;:!?]+$/, "");
    events.push({type: "suggestion", label, prompt});
  }
}

// ---------------------------------------------------------------------------
// Response accumulation + policy
// ---------------------------------------------------------------------------

export interface ChatQuestion {
  text: string;
  choices: string[];
}

export interface ChatSuggestion {
  label: string;
  prompt: string;
}

export interface AccumulatedResponse {
  reply: string;
  // path → full file content, in emission order (last write wins).
  writes: Map<string, string>;
  deletes: Set<string>;
  questions: ChatQuestion[];
  suggestions: ChatSuggestion[];
  warnings: string[];
}

export const MAX_QUESTIONS = 2;
export const CHOICES_PER_QUESTION = 3;
export const MAX_SUGGESTIONS = 2;

// The platform-owned GHL client is injected server-side at commit time and
// must never be written or deleted by the model (see
// modules/builder/versions).
export const PROTECTED_PATHS = new Set(["src/lib/ghl.js"]);

/**
 * Normalizes a model-provided file path, rejecting traversal and absolute
 * forms.
 * @param {string} path The raw path from a file/delete tag.
 * @return {string | null} The normalized project-relative path, or null if
 *   the path is unusable.
 */
export function normalizePath(path: string): string | null {
  let out = path.trim().replace(/\\/g, "/");
  while (out.startsWith("./") || out.startsWith("/")) {
    out = out.startsWith("./") ? out.slice(2) : out.slice(1);
  }
  if (!out) return null;
  const segments = out.split("/");
  for (const s of segments) {
    if (s === "" || s === "." || s === "..") return null;
  }
  return out;
}

/**
 * Applies the response policy over the raw parse events: path
 * normalization, protected-path drops, last-write-wins, and question /
 * suggestion clamps.
 */
export class ResponseAccumulator {
  private replyParts: string[] = [];
  private writeChunks = new Map<string, string[]>();
  private deletePaths = new Set<string>();
  private questionList: ChatQuestion[] = [];
  private suggestionList: ChatSuggestion[] = [];
  private warningList: string[] = [];
  // Raw path of the file block currently streaming → normalized path, or
  // null when its deltas are being dropped.
  private openFile = new Map<string, string | null>();

  /**
   * Consumes one parse event.
   * @param {ParseEvent} event The event to accumulate.
   */
  add(event: ParseEvent): void {
    switch (event.type) {
    case "reply-delta":
      this.replyParts.push(event.text);
      break;
    case "file-start":
      this.openFile.set(event.path, this.startWrite(event.path));
      break;
    case "file-delta": {
      const norm = this.openFile.get(event.path);
      if (norm != null) this.writeChunks.get(norm)?.push(event.text);
      break;
    }
    case "file-end":
      break;
    case "file-delete":
      this.addDelete(event.path);
      break;
    case "question":
      this.addQuestion(event.text, event.choices);
      break;
    case "suggestion":
      this.addSuggestion(event.label, event.prompt);
      break;
    case "warning":
      this.warningList.push(event.reason);
      break;
    }
  }

  /**
   * Finalizes the accumulated response.
   * @return {AccumulatedResponse} The policy-clean response.
   */
  result(): AccumulatedResponse {
    const writes = new Map<string, string>();
    for (const [path, chunks] of this.writeChunks) {
      writes.set(path, chunks.join(""));
    }
    return {
      reply: this.replyParts.join("").trim(),
      writes,
      deletes: this.deletePaths,
      questions: this.questionList,
      suggestions: this.suggestionList,
      warnings: this.warningList,
    };
  }

  /**
   * Validates a write target and opens its chunk list.
   * @param {string} rawPath The raw path from the file tag.
   * @return {string | null} The normalized path, or null when dropped.
   */
  private startWrite(rawPath: string): string | null {
    const norm = normalizePath(rawPath);
    if (!norm) {
      this.warningList.push(`invalid file path "${rawPath}" dropped`);
      return null;
    }
    if (PROTECTED_PATHS.has(norm)) {
      this.warningList.push(
        `attempt to write protected file ${norm} dropped`,
      );
      return null;
    }
    this.writeChunks.set(norm, []);
    this.deletePaths.delete(norm);
    return norm;
  }

  /**
   * Validates a delete target.
   * @param {string} rawPath The raw path from the delete tag.
   */
  private addDelete(rawPath: string): void {
    const norm = normalizePath(rawPath);
    if (!norm) {
      this.warningList.push(`invalid delete path "${rawPath}" dropped`);
      return;
    }
    if (PROTECTED_PATHS.has(norm)) {
      this.warningList.push(
        `attempt to delete protected file ${norm} dropped`,
      );
      return;
    }
    this.deletePaths.add(norm);
    this.writeChunks.delete(norm);
  }

  /**
   * Clamps and stores one question.
   * @param {string} text The question text.
   * @param {string[]} rawChoices The parsed choice lines.
   */
  private addQuestion(text: string, rawChoices: string[]): void {
    if (this.questionList.length >= MAX_QUESTIONS) {
      this.warningList.push("extra question dropped");
      return;
    }
    let choices = rawChoices.map((c) => c.trim()).filter(Boolean);
    if (choices.length > CHOICES_PER_QUESTION) {
      this.warningList.push("question clamped to 3 choices");
      choices = choices.slice(0, CHOICES_PER_QUESTION);
    }
    if (!text.trim() || choices.length < CHOICES_PER_QUESTION) {
      this.warningList.push("malformed question dropped");
      return;
    }
    this.questionList.push({text: text.trim(), choices});
  }

  /**
   * Clamps and stores one suggestion.
   * @param {string} label The short button label.
   * @param {string} prompt The full prompt to run when clicked.
   */
  private addSuggestion(label: string, prompt: string): void {
    if (this.suggestionList.length >= MAX_SUGGESTIONS) {
      this.warningList.push("extra suggestion dropped");
      return;
    }
    this.suggestionList.push({label, prompt});
  }
}
