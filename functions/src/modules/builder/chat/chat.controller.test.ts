// Self-running unit tests for the pure request-shaping helpers in
// chat.controller.ts: answer validation and rendering.
// Run with plain Node: `node lib/modules/builder/chat/chat.controller.js` is
// the handler; this compiles to chat.controller.test.js. The streaming/stateful
// runGeneration path is covered by the emulator tests, not here.

import assert from "node:assert";
import {Test, main} from "../../../test/harness";
import {MAX_ANSWER_CHARS} from "../../../shared/config";
import {parseAnswers, renderAnswers} from "./chat.controller";

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
];

void main("chat.controller helpers (pure)", TESTS);
