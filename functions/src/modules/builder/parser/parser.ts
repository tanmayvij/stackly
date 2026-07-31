// Incremental parser for the tagged output protocol the code-generation
// model streams back (see chat/prompt.ts OUTPUT PROTOCOL). Pure and I/O-free
// so it can be unit tested against arbitrary chunk boundaries.
//
// Grammar (tolerant, line-oriented where it matters):
//   <reply>conversational text</reply>
//   <variant rank="1">
//   <summary>one line</summary>
//   <file path="src/App.jsx">
//   ...entire file content...
//   </file>                      <- closer alone on its own line
//   <delete path="src/Old.jsx"/>
//   </variant>                   <- closer alone on its own line
//   <question>
//   Question text
//   - choice
//   - choice
//   - choice
//   </question>
//   <suggest label="Short label">full prompt to run when clicked</suggest>
//
// Each <variant> is one complete, independent alternative; the user picks one
// and only that one is committed. Variants are tracked by a counter rather
// than a parser state, because file/summary blocks nest inside them.
//
// Text outside any tag is treated as reply text (weak-model tolerance) and
// unrecognized tags are passed through as literal text.

// Imported from the leaf module, not the config barrel: the barrel pulls in
// firebase-functions secrets, and this file stays dependency-free.
import {
  MAX_VARIANT_SUMMARY_CHARS,
  VARIANT_COUNT,
} from "../../../shared/config/limits";

// Variant index used for file blocks that appear outside any <variant>.
export const NO_VARIANT = -1;

export type ParseEvent =
  | {type: "reply-delta"; text: string}
  | {type: "variant-start"; variant: number; rank: number | null}
  | {type: "variant-summary"; variant: number; text: string}
  | {type: "variant-end"; variant: number}
  | {type: "file-start"; variant: number; path: string}
  | {type: "file-delta"; variant: number; path: string; text: string}
  | {type: "file-end"; variant: number; path: string}
  | {type: "file-delete"; variant: number; path: string}
  | {type: "question"; text: string; choices: string[]}
  | {type: "suggestion"; label: string; prompt: string}
  | {type: "warning"; reason: string};

export interface VariantDefect {
  // Path of a <file> block the stream ended inside of, if any.
  incompleteFile: string | null;
  // Count of <file> blocks in this variant with a missing/invalid path, or
  // never closed before </variant>, whose content was skipped.
  invalidFileBlocks: number;
}

export interface ParseFinish {
  events: ParseEvent[];
  // Variant index → why that variant is malformed and MUST NOT be committed.
  // Absence from this map means the variant parsed cleanly. NO_VARIANT covers
  // blocks that appeared outside any <variant>.
  defects: Map<number, VariantDefect>;
  warnings: string[];
}

type State = "text" | "reply" | "file" | "question" | "suggest" | "summary";

// Longest run held back while a possibly chunk-split tag finishes arriving.
const MAX_TAG_LEN = 512;

// Block closers that must stand alone on their own line, matched either
// mid-buffer (terminated by a newline) or at end-of-input (only valid in
// finish()). The FIRST_ forms cover a closer at the very start of a block,
// with no leading newline (an empty file, or a variant closed immediately).
const FILE_CLOSER_MID = /\r?\n[ \t]*<\/file>[ \t]*\r?\n/;
const FILE_CLOSER_END = /\r?\n[ \t]*<\/file>[ \t]*$/;
const FILE_CLOSER_FIRST_MID = /^[ \t]*<\/file>[ \t]*\r?\n/;
const FILE_CLOSER_FIRST_END = /^[ \t]*<\/file>[ \t]*$/;
const VARIANT_CLOSER_MID = /\r?\n[ \t]*<\/variant>[ \t]*\r?\n/;
const VARIANT_CLOSER_END = /\r?\n[ \t]*<\/variant>[ \t]*$/;
const VARIANT_CLOSER_FIRST_MID = /^[ \t]*<\/variant>[ \t]*\r?\n/;
const VARIANT_CLOSER_FIRST_END = /^[ \t]*<\/variant>[ \t]*$/;

// Closers recognized while scanning inside a <file> block, longest-relevant
// first for the hold-back prefix check.
const IN_FILE_CLOSERS = ["</file>", "</variant>"];

const FILE_OPEN = /^<file\s+path\s*=\s*(?:"([^"]+)"|'([^']+)')\s*>$/;
const DELETE_TAG = /^<delete\s+path\s*=\s*(?:"([^"]+)"|'([^']+)')\s*\/?\s*>$/;
const SUGGEST_OPEN =
  /^<suggest(?:\s+label\s*=\s*(?:"([^"]*)"|'([^']*)'))?\s*>$/;
// rank is the ONLY attribute a variant carries: scanText finds a tag's end
// with a plain indexOf(">"), so model-authored prose in an attribute would
// truncate the tag at the first ">" it happens to contain. The one-line
// description is a nested <summary> block instead.
const VARIANT_OPEN = /^<variant(?:\s+rank\s*=\s*(?:"(\d+)"|'(\d+)'))?\s*>$/;
const CHOICE_LINE = /^(?:[-*•]|\d+[.)])\s+(.+)$/;

// Fixed tags recognized in text/reply state. Orphan closers are consumed
// (with a warning) instead of leaking into the reply text.
const FIXED_TAGS = [
  "<reply>",
  "</reply>",
  "<question>",
  "</question>",
  "<summary>",
  "</summary>",
  "</variant>",
  "</file>",
  "</suggest>",
  "</delete>",
];
const ATTR_TAG_NAMES = ["<file", "<delete", "<suggest", "<variant"];

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
 * closer line for the block being scanned once more input arrives.
 * @param {string} line The trailing partial line of a file block.
 * @return {boolean} True if the tail must be held back.
 */
function couldBeCloserPrefix(line: string): boolean {
  let i = 0;
  while (i < line.length && (line[i] === " " || line[i] === "\t")) i++;
  const rest = line.slice(i);
  for (const tag of IN_FILE_CLOSERS) {
    if (rest.length <= tag.length) {
      if (tag.startsWith(rest)) return true;
    } else if (rest.startsWith(tag) && /^[ \t]*\r?$/.test(rest.slice(tag.length))) {
      return true;
    }
  }
  return false;
}

interface CloserHit {
  index: number;
  length: number;
  kind: "file" | "variant";
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
  // Index of the <variant> currently open, or NO_VARIANT outside one.
  private variant = NO_VARIANT;
  // Variants opened so far, which is also the next index to hand out.
  private variantCount = 0;
  // Per-variant count of <file> blocks whose content had to be discarded.
  private invalidFiles = new Map<number, number>();
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
      case "suggest":
      case "summary":
        again = this.scanBlock(events, this.state);
        break;
      default:
        // Unreachable, but a missing case here would spin this loop
        // forever on the value `again` already holds.
        again = false;
        break;
      }
    }
    return events;
  }

  /**
   * Flushes any pending state at end-of-stream.
   * @return {ParseFinish} Final events plus per-variant malformed-output
   *   indicators.
   */
  finish(): ParseFinish {
    if (this.done) throw new Error("finish() called twice");
    this.done = true;
    const events: ParseEvent[] = [];
    let incompleteVariant: number | null = null;
    let incompletePath = "";

    if (this.state === "text" || this.state === "reply") {
      this.flushText(events, this.buf);
    } else if (this.state === "file") {
      const hit = this.findCloser(this.buf, true);
      if (hit) {
        this.emitFileDelta(events, this.buf.slice(0, hit.index));
        this.closeFile(events, hit.kind);
      } else if (this.fileSkip) {
        this.warn(events, "stream ended inside a malformed <file> block");
      } else {
        incompleteVariant = this.variant;
        incompletePath = this.filePath;
        this.warn(
          events,
          `stream ended inside <file path="${this.filePath}">`,
        );
      }
    } else {
      this.warn(events, `stream ended inside <${this.state}> block`);
    }
    this.buf = "";

    // A variant left open at end-of-stream keeps whatever files it closed
    // cleanly: every one of those carries its full content, which is the
    // property that makes a commit safe. (Matches how a truncation between
    // two file blocks has always been treated.)
    if (this.variant !== NO_VARIANT) {
      this.warn(events, `stream ended inside <variant> ${this.variant + 1}`);
      this.endVariant(events);
    }

    const defects = new Map<number, VariantDefect>();
    for (const [index, count] of this.invalidFiles) {
      if (count > 0) defects.set(index, {incompleteFile: null, invalidFileBlocks: count});
    }
    if (incompleteVariant !== null) {
      const existing = defects.get(incompleteVariant);
      defects.set(incompleteVariant, {
        incompleteFile: incompletePath,
        invalidFileBlocks: existing?.invalidFileBlocks ?? 0,
      });
    }

    return {events, defects, warnings: this.warningsList};
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
   * Marks the given variant's file set as unusable.
   * @param {number} variant The variant index.
   */
  private invalidate(variant: number): void {
    this.invalidFiles.set(variant, (this.invalidFiles.get(variant) ?? 0) + 1);
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
    if (tag === "<summary>") {
      this.state = "summary";
      return true;
    }
    if (tag === "</variant>") {
      if (this.variant === NO_VARIANT) {
        this.warn(events, "orphan </variant> ignored");
      } else {
        this.endVariant(events);
      }
      return true;
    }
    if (tag === "</delete>") return true;
    if (
      tag === "</question>" ||
      tag === "</file>" ||
      tag === "</suggest>" ||
      tag === "</summary>"
    ) {
      this.warn(events, `orphan ${tag} ignored`);
      return true;
    }

    let m = VARIANT_OPEN.exec(tag);
    if (m) {
      // A variant opening while one is still open means the model dropped a
      // </variant>; close it rather than nesting.
      if (this.variant !== NO_VARIANT) {
        this.warn(events, "missing </variant> before the next variant");
        this.endVariant(events);
      }
      if (this.variantCount >= VARIANT_COUNT) {
        // Its blocks fall through to NO_VARIANT and are dropped, since real
        // variants exist (see ResponseAccumulator.result).
        this.warn(events, "extra <variant> dropped");
        return true;
      }
      const raw = m[1] ?? m[2];
      this.variant = this.variantCount;
      this.variantCount += 1;
      events.push({
        type: "variant-start",
        variant: this.variant,
        rank: raw ? Number(raw) : null,
      });
      return true;
    }
    if (/^<variant[\s/>]/.test(tag)) {
      this.warn(events, `malformed variant tag ${tag} ignored`);
      return true;
    }

    m = FILE_OPEN.exec(tag);
    if (m) {
      this.filePath = (m[1] ?? m[2]) as string;
      this.fileSkip = false;
      this.fileEmitted = false;
      this.state = "file";
      events.push({
        type: "file-start",
        variant: this.variant,
        path: this.filePath,
      });
      return true;
    }
    if (/^<file[\s/>]/.test(tag)) {
      this.warn(events, `malformed file tag ${tag} — block skipped`);
      this.invalidate(this.variant);
      this.filePath = "";
      this.fileSkip = true;
      this.fileEmitted = false;
      this.state = "file";
      return true;
    }

    m = DELETE_TAG.exec(tag);
    if (m) {
      events.push({
        type: "file-delete",
        variant: this.variant,
        path: (m[1] ?? m[2]) as string,
      });
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
   * Closes the currently open variant.
   * @param {ParseEvent[]} events The event sink for the current push.
   */
  private endVariant(events: ParseEvent[]): void {
    events.push({type: "variant-end", variant: this.variant});
    this.variant = NO_VARIANT;
  }

  /**
   * Finds the earliest block closer in `buf` while inside a <file> block.
   * `</variant>` counts as one: without it a file the model forgot to close
   * would swallow the rest of the response — including the next variant —
   * and then close on that variant's first </file>, producing a merged tree
   * that looks perfectly well-formed.
   * @param {string} buf The buffered file content.
   * @param {boolean} atEnd Whether end-of-input may terminate a closer.
   * @return {CloserHit | null} The earliest closer, or null if none is
   *   complete yet.
   */
  private findCloser(buf: string, atEnd: boolean): CloserHit | null {
    const candidates: [RegExp, "file" | "variant"][] = [
      [FILE_CLOSER_MID, "file"],
      [VARIANT_CLOSER_MID, "variant"],
    ];
    if (!this.fileEmitted) {
      candidates.push(
        [FILE_CLOSER_FIRST_MID, "file"],
        [VARIANT_CLOSER_FIRST_MID, "variant"],
      );
    }
    if (atEnd) {
      candidates.push(
        [FILE_CLOSER_END, "file"],
        [VARIANT_CLOSER_END, "variant"],
      );
      if (!this.fileEmitted) {
        candidates.push(
          [FILE_CLOSER_FIRST_END, "file"],
          [VARIANT_CLOSER_FIRST_END, "variant"],
        );
      }
    }
    let best: CloserHit | null = null;
    for (const [re, kind] of candidates) {
      const m = re.exec(buf);
      if (m === null) continue;
      if (best === null || m.index < best.index) {
        best = {index: m.index, length: m[0].length, kind};
      }
    }
    return best;
  }

  /**
   * Leaves file state after a closer was consumed from the buffer.
   * @param {ParseEvent[]} events The event sink for the current push.
   * @param {"file" | "variant"} kind Which closer ended the block.
   */
  private closeFile(events: ParseEvent[], kind: "file" | "variant"): void {
    this.state = "text";
    if (kind === "file") {
      if (!this.fileSkip) {
        events.push({
          type: "file-end",
          variant: this.variant,
          path: this.filePath,
        });
      }
      return;
    }
    if (!this.fileSkip) {
      this.invalidate(this.variant);
      this.warn(
        events,
        `<file path="${this.filePath}"> was never closed — ` +
          `variant ${this.variant + 1} dropped`,
      );
    }
    if (this.variant !== NO_VARIANT) this.endVariant(events);
  }

  /**
   * Scans file state: streams content deltas while holding back any tail
   * that could still turn out to be a block closer.
   * @param {ParseEvent[]} events The event sink for the current push.
   * @return {boolean} True if the block closed and scanning should resume.
   */
  private scanFile(events: ParseEvent[]): boolean {
    const hit = this.findCloser(this.buf, false);
    if (hit) {
      this.emitFileDelta(events, this.buf.slice(0, hit.index));
      this.buf = this.buf.slice(hit.index + hit.length);
      this.closeFile(events, hit.kind);
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
      events.push({
        type: "file-delta",
        variant: this.variant,
        path: this.filePath,
        text,
      });
    }
  }

  /**
   * Scans question/suggest/summary state: buffers until the closing tag
   * arrives (these blocks are small, so no incremental deltas are emitted).
   * @param {ParseEvent[]} events The event sink for the current push.
   * @param {"question" | "suggest" | "summary"} kind Which block is buffered.
   * @return {boolean} True if the block closed and scanning should resume.
   */
  private scanBlock(
    events: ParseEvent[],
    kind: "question" | "suggest" | "summary",
  ): boolean {
    const closer = `</${kind}>`;
    const idx = this.buf.indexOf(closer);
    if (idx === -1) return false;
    const raw = this.buf.slice(0, idx);
    this.buf = this.buf.slice(idx + closer.length);
    this.state = "text";
    if (kind === "question") {
      this.emitQuestion(events, raw);
    } else if (kind === "suggest") {
      this.emitSuggestion(events, raw);
    } else {
      this.emitSummary(events, raw);
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

  /**
   * Parses a buffered variant summary: collapsed to one clamped line.
   * @param {ParseEvent[]} events The event sink for the current push.
   * @param {string} raw The block content between the tags.
   */
  private emitSummary(events: ParseEvent[], raw: string): void {
    const text = raw.replace(/\s+/g, " ").trim();
    if (!text) return;
    if (this.variant === NO_VARIANT) {
      this.warn(events, "<summary> outside a variant ignored");
      return;
    }
    events.push({
      type: "variant-summary",
      variant: this.variant,
      text: text.slice(0, MAX_VARIANT_SUMMARY_CHARS),
    });
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

export interface VariantResult {
  // Emission order, and the key the parse events / SSE frames refer to.
  index: number;
  // 1 = most suitable. Contiguous from 1 across the returned variants.
  rank: number;
  summary: string;
  // path → full file content, in emission order (last write wins).
  writes: Map<string, string>;
  deletes: Set<string>;
}

export interface AccumulatedResponse {
  reply: string;
  // In emission order. Empty for a pure Q&A / refusal turn.
  variants: VariantResult[];
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

interface VariantAcc {
  index: number;
  rank: number | null;
  summary: string;
  writeChunks: Map<string, string[]>;
  deletePaths: Set<string>;
}

/**
 * Applies the response policy over the raw parse events: per-variant path
 * normalization, protected-path drops, last-write-wins, and question /
 * suggestion clamps.
 */
export class ResponseAccumulator {
  private replyParts: string[] = [];
  private variantAccs = new Map<number, VariantAcc>();
  private questionList: ChatQuestion[] = [];
  private suggestionList: ChatSuggestion[] = [];
  private warningList: string[] = [];
  // "variant:rawPath" of the file block currently streaming → normalized
  // path, or null when its deltas are being dropped.
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
    case "variant-start":
      this.forVariant(event.variant).rank = event.rank;
      break;
    case "variant-summary":
      this.forVariant(event.variant).summary = event.text;
      break;
    case "variant-end":
      break;
    case "file-start":
      this.openFile.set(
        `${event.variant}:${event.path}`,
        this.startWrite(event.variant, event.path),
      );
      break;
    case "file-delta": {
      const norm = this.openFile.get(`${event.variant}:${event.path}`);
      if (norm != null) {
        this.forVariant(event.variant).writeChunks.get(norm)?.push(event.text);
      }
      break;
    }
    case "file-end":
      break;
    case "file-delete":
      this.addDelete(event.variant, event.path);
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
    const real = [...this.variantAccs.values()].filter(
      (v) => v.index !== NO_VARIANT,
    );
    const stray = this.variantAccs.get(NO_VARIANT);
    const strayHasFiles =
      !!stray && (stray.writeChunks.size > 0 || stray.deletePaths.size > 0);

    let chosen: VariantAcc[];
    if (real.length === 0) {
      // No <variant> tag at all: treat the whole response as one variant so
      // a model that ignores the protocol still produces a usable turn.
      chosen = strayHasFiles ? [stray as VariantAcc] : [];
    } else {
      if (strayHasFiles) {
        this.warningList.push(
          "file blocks outside a <variant> dropped",
        );
      }
      chosen = real;
    }

    return {
      reply: this.replyParts.join("").trim(),
      variants: this.rankVariants(chosen),
      questions: this.questionList,
      suggestions: this.suggestionList,
      warnings: this.warningList,
    };
  }

  /**
   * Materializes variants in emission order, honoring the model's ranks only
   * when they form a clean permutation of 1..n.
   * @param {VariantAcc[]} accs The chosen accumulators, in emission order.
   * @return {VariantResult[]} The finished variants.
   */
  private rankVariants(accs: VariantAcc[]): VariantResult[] {
    const ranks = accs.map((v) => v.rank);
    const valid =
      ranks.every((r) => r !== null && Number.isInteger(r) && r >= 1 && r <= accs.length) &&
      new Set(ranks).size === accs.length;
    if (!valid && accs.length > 1) {
      this.warningList.push("variant ranks unusable — emission order used");
    }
    return accs.map((acc, i) => {
      const writes = new Map<string, string>();
      for (const [path, chunks] of acc.writeChunks) {
        writes.set(path, chunks.join(""));
      }
      return {
        index: acc.index,
        rank: valid ? (acc.rank as number) : i + 1,
        summary: acc.summary,
        writes,
        deletes: acc.deletePaths,
      };
    });
  }

  /**
   * Returns (creating if needed) the accumulator for one variant index.
   * @param {number} index The variant index, or NO_VARIANT.
   * @return {VariantAcc} The per-variant accumulator.
   */
  private forVariant(index: number): VariantAcc {
    let acc = this.variantAccs.get(index);
    if (!acc) {
      acc = {
        index,
        rank: null,
        summary: "",
        writeChunks: new Map(),
        deletePaths: new Set(),
      };
      this.variantAccs.set(index, acc);
    }
    return acc;
  }

  /**
   * Validates a write target and opens its chunk list.
   * @param {number} variant The variant the file belongs to.
   * @param {string} rawPath The raw path from the file tag.
   * @return {string | null} The normalized path, or null when dropped.
   */
  private startWrite(variant: number, rawPath: string): string | null {
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
    const acc = this.forVariant(variant);
    acc.writeChunks.set(norm, []);
    acc.deletePaths.delete(norm);
    return norm;
  }

  /**
   * Validates a delete target.
   * @param {number} variant The variant the delete belongs to.
   * @param {string} rawPath The raw path from the delete tag.
   */
  private addDelete(variant: number, rawPath: string): void {
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
    const acc = this.forVariant(variant);
    acc.deletePaths.add(norm);
    acc.writeChunks.delete(norm);
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

/**
 * A variant's identity for duplicate detection: its complete write set plus
 * deletes. Content-based, so two variants that produce the same tree collapse
 * no matter what order they emitted files in.
 *
 * Each part is length-prefixed rather than separated by a delimiter, so the
 * encoding stays unambiguous without reserving a byte that file content is not
 * allowed to contain.
 * @param {VariantResult} v The variant.
 * @return {string} A comparable signature.
 */
function variantSignature(v: VariantResult): string {
  const parts: string[] = [];
  for (const [path, content] of [...v.writes].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    parts.push(`w:${path.length}:${path}:${content.length}:${content}`);
  }
  for (const path of [...v.deletes].sort()) {
    parts.push(`d:${path.length}:${path}`);
  }
  return parts.join("");
}

/**
 * Narrows the parsed variants to the ones that may be offered to the user:
 * drops malformed and empty ones, collapses duplicates, and re-ranks the
 * survivors contiguously from 1 so the "recommended" option always exists.
 * @param {VariantResult[]} variants The parsed variants, in emission order.
 * @param {Map<number, VariantDefect>} defects Per-variant parse defects.
 * @param {string[]} warnings Sink for anything dropped here.
 * @return {VariantResult[]} The usable variants, best first.
 */
export function selectUsableVariants(
  variants: VariantResult[],
  defects: Map<number, VariantDefect>,
  warnings: string[],
): VariantResult[] {
  const kept: VariantResult[] = [];
  const seen = new Set<string>();
  for (const v of variants) {
    if (defects.has(v.index)) {
      warnings.push(`variant ${v.rank} dropped: malformed output`);
      continue;
    }
    if (v.writes.size === 0 && v.deletes.size === 0) {
      warnings.push(`variant ${v.rank} dropped: no file changes`);
      continue;
    }
    const sig = variantSignature(v);
    if (seen.has(sig)) {
      warnings.push(`variant ${v.rank} dropped: identical to another variant`);
      continue;
    }
    seen.add(sig);
    kept.push(v);
  }
  kept.sort((a, b) => a.rank - b.rank);
  return kept.map((v, i) => ({...v, rank: i + 1}));
}
