// Self-running unit tests for the pure request-shaping helpers in
// chat.controller.ts: answer validation/rendering and version-title derivation.
// Run with plain Node: `node lib/modules/builder/chat/chat.controller.js` is
// the handler; this compiles to chat.controller.test.js. The streaming/stateful
// runGeneration path is covered by the emulator tests, not here.

import assert from "node:assert";
import {Test, main} from "../../../test/harness";
import {MAX_ANSWER_CHARS} from "../../../shared/config";
import {HistoryMessage} from "../messages/messages.service";
import {parseAnswers, renderAnswers, versionTitle} from "./chat.controller";

/**
 * Minimal HistoryMessage builder for versionTitle (which only reads role and
 * content).
 * @param {"user" | "assistant" | "system"} role The turn role.
 * @param {string} content The turn text.
 * @return {HistoryMessage} A message with defaults for the unused fields.
 */
function turn(
  role: "user" | "assistant" | "system",
  content: string,
): HistoryMessage {
  return {
    id: "id",
    kind: "chat",
    role,
    seq: 0,
    content,
    files: [],
    questions: [],
    status: null,
    contextTokens: 0,
    compactedThroughSeq: 0,
  };
}

const TESTS: Test[] = [
  [
    "parseAnswers rejects non-arrays, empty arrays, and > 4 items",
    () => {
      assert.equal(parseAnswers(undefined), null);
      assert.equal(parseAnswers("nope"), null);
      assert.equal(parseAnswers([]), null);
      const five = Array.from({length: 5}, () => ({question: "q", choice: "c"}));
      assert.equal(parseAnswers(five), null);
    },
  ],
  [
    "parseAnswers rejects items missing or blanking question/choice",
    () => {
      assert.equal(parseAnswers([{choice: "c"}]), null);
      assert.equal(parseAnswers([{question: "q"}]), null);
      assert.equal(parseAnswers([{question: "  ", choice: "c"}]), null);
      assert.equal(parseAnswers([{question: "q", choice: "   "}]), null);
      assert.equal(parseAnswers([{question: 1, choice: "c"}]), null);
    },
  ],
  [
    "parseAnswers rejects over-long question or choice",
    () => {
      const long = "x".repeat(MAX_ANSWER_CHARS + 1);
      assert.equal(parseAnswers([{question: long, choice: "c"}]), null);
      assert.equal(parseAnswers([{question: "q", choice: long}]), null);
    },
  ],
  [
    "parseAnswers accepts up to 4 valid items and trims them",
    () => {
      const got = parseAnswers([
        {question: "  Which color?  ", choice: "  blue  "},
        {question: "Size?", choice: "large"},
      ]);
      assert.deepEqual(got, [
        {question: "Which color?", choice: "blue"},
        {question: "Size?", choice: "large"},
      ]);
    },
  ],
  [
    "renderAnswers formats each Q/A block and joins with blank lines",
    () => {
      const rendered = renderAnswers([
        {question: "Color?", choice: "blue"},
        {question: "Size?", choice: "large"},
      ]);
      assert.equal(rendered, "Q: Color?\nA: blue\n\nQ: Size?\nA: large");
    },
  ],
  [
    "versionTitle uses the last user turn, collapsing whitespace",
    () => {
      const title = versionTitle([
        turn("user", "first request"),
        turn("assistant", "did it"),
        turn("user", "add   a\nsearch\tbox"),
      ]);
      assert.equal(title, "add a search box");
    },
  ],
  [
    "versionTitle truncates a long title to 57 chars + ellipsis",
    () => {
      const long = "a".repeat(80);
      const title = versionTitle([turn("user", long)]);
      assert.equal(title.length, 60);
      assert.equal(title, "a".repeat(57) + "...");
    },
  ],
  [
    "versionTitle skips blank user turns and falls back to \"AI update\"",
    () => {
      assert.equal(versionTitle([turn("assistant", "no user here")]), "AI update");
      assert.equal(versionTitle([turn("user", "   ")]), "AI update");
      assert.equal(versionTitle([]), "AI update");
    },
  ],
];

void main("chat.controller helpers (pure)", TESTS);
