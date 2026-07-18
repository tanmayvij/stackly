// Self-running unit tests for llm-parser.ts. Executed with plain Node
// (no framework): `npm test` → `node lib/test/llm-parser.test.js`. Exits
// non-zero on the first failure.

import assert from "node:assert";
import {
  AccumulatedResponse,
  LlmStreamParser,
  ParseEvent,
  ParseFinish,
  ResponseAccumulator,
  normalizePath,
} from "../llm-parser";

interface ParseRun {
  events: ParseEvent[];
  finish: ParseFinish;
  result: AccumulatedResponse;
}

/**
 * Feeds `input` through a fresh parser in chunks of `size` characters and
 * accumulates the result.
 * @param {string} input The full model output.
 * @param {number} size The chunk size to split the input into.
 * @return {ParseRun} All events, the finish record, and the accumulated
 *   response.
 */
function run(input: string, size: number): ParseRun {
  const parser = new LlmStreamParser();
  const acc = new ResponseAccumulator();
  const events: ParseEvent[] = [];
  for (let i = 0; i < input.length; i += size) {
    for (const e of parser.push(input.slice(i, i + size))) {
      events.push(e);
      acc.add(e);
    }
  }
  const finish = parser.finish();
  for (const e of finish.events) {
    events.push(e);
    acc.add(e);
  }
  return {events, finish, result: acc.result()};
}

/**
 * Converts an accumulated response into a plain comparable object.
 * @param {AccumulatedResponse} r The response to flatten.
 * @return {object} A deep-equal-friendly projection.
 */
function flat(r: AccumulatedResponse): object {
  return {
    reply: r.reply,
    writes: [...r.writes.entries()],
    deletes: [...r.deletes].sort(),
    questions: r.questions,
    suggestions: r.suggestions,
  };
}

const FULL_RESPONSE = [
  "<reply>",
  "Built a contacts list with search.",
  "</reply>",
  "<file path=\"src/App.jsx\">",
  "import React from 'react'",
  "export default function App() {",
  "  return <div className=\"p-4\">hi</div>",
  "}",
  "</file>",
  "<file path=\"src/styles.css\">",
  ".card { color: red; }",
  "</file>",
  "<delete path=\"src/Old.jsx\"/>",
  "<suggest label=\"Add search\">Add a search box to the list</suggest>",
  "<suggest>Paginate the contacts list, 10 per page</suggest>",
].join("\n");

const TESTS: Array<[string, () => void]> = [
  [
    "full response parses in one shot",
    () => {
      const {finish, result} = run(FULL_RESPONSE, FULL_RESPONSE.length);
      assert.equal(finish.incompleteFile, null);
      assert.equal(finish.invalidFileBlocks, 0);
      assert.equal(result.reply, "Built a contacts list with search.");
      assert.deepEqual(
        [...result.writes.keys()],
        ["src/App.jsx", "src/styles.css"],
      );
      assert.equal(
        result.writes.get("src/App.jsx"),
        [
          "import React from 'react'",
          "export default function App() {",
          "  return <div className=\"p-4\">hi</div>",
          "}",
        ].join("\n"),
      );
      assert.equal(result.writes.get("src/styles.css"),
        ".card { color: red; }");
      assert.deepEqual([...result.deletes], ["src/Old.jsx"]);
      assert.deepEqual(result.suggestions, [
        {label: "Add search", prompt: "Add a search box to the list"},
        {
          label: "Paginate the contacts list",
          prompt: "Paginate the contacts list, 10 per page",
        },
      ]);
    },
  ],
  [
    "chunk boundaries never change the result",
    () => {
      const oneShot = flat(run(FULL_RESPONSE, FULL_RESPONSE.length).result);
      for (const size of [1, 2, 3, 5, 7, 11, 64]) {
        assert.deepEqual(flat(run(FULL_RESPONSE, size).result), oneShot,
          `chunk size ${size}`);
      }
    },
  ],
  [
    "file closer split across chunks",
    () => {
      const input =
        "<file path=\"a.js\">\nlet x = 1\n</fi" + "le>\n<reply>ok</reply>";
      const parser = new LlmStreamParser();
      const acc = new ResponseAccumulator();
      const feed = (s: string) => parser.push(s).forEach((e) => acc.add(e));
      feed(input.slice(0, 30));
      feed(input.slice(30));
      parser.finish().events.forEach((e) => acc.add(e));
      const r = acc.result();
      assert.equal(r.writes.get("a.js"), "let x = 1");
      assert.equal(r.reply, "ok");
    },
  ],
  [
    "empty file block",
    () => {
      const {finish, result} = run(
        "<file path=\"empty.txt\">\n</file>\n", 4);
      assert.equal(finish.incompleteFile, null);
      assert.equal(result.writes.get("empty.txt"), "");
    },
  ],
  [
    "closer-lookalike inside code stays in content",
    () => {
      const body = "const s = \"</file>\";\nconst t = 1";
      const input = `<file path="a.js">\n${body}\n</file>\n`;
      for (const size of [1, 9, input.length]) {
        const {result} = run(input, size);
        assert.equal(result.writes.get("a.js"), body, `chunk size ${size}`);
      }
    },
  ],
  [
    "stray text outside tags becomes reply",
    () => {
      const {result} = run(
        "Sure! Here you go.\n<file path=\"a.js\">\nx\n</file>\n", 5);
      assert.equal(result.reply, "Sure! Here you go.");
      assert.equal(result.writes.get("a.js"), "x");
    },
  ],
  [
    "unterminated file block reports incompleteFile",
    () => {
      const {finish, result} = run(
        "<reply>hi</reply>\n<file path=\"a.js\">\nlet x = 1\n", 6);
      assert.equal(finish.incompleteFile, "a.js");
      assert.equal(result.reply, "hi");
    },
  ],
  [
    "file closer at end of input (no trailing newline)",
    () => {
      const {finish, result} = run(
        "<file path=\"a.js\">\nlet x = 1\n</file>", 5);
      assert.equal(finish.incompleteFile, null);
      assert.equal(result.writes.get("a.js"), "let x = 1");
    },
  ],
  [
    "malformed file tag skips block and counts it",
    () => {
      const {finish, result} = run(
        "<file>\nsecret\n</file>\n<reply>done</reply>", 3);
      assert.equal(finish.invalidFileBlocks, 1);
      assert.equal(result.writes.size, 0);
      assert.equal(result.reply, "done");
    },
  ],
  [
    "questions parse text and choices, clamp and drop",
    () => {
      const input = [
        "<question>",
        "Which period should the dashboard show?",
        "- Today",
        "- This week",
        "- This month",
        "- This year",
        "</question>",
        "<question>",
        "Broken question",
        "- Only choice",
        "</question>",
        "<question>",
        "Second valid?",
        "1. A",
        "2. B",
        "3. C",
        "</question>",
        "<question>",
        "Third valid gets dropped?",
        "- A",
        "- B",
        "- C",
        "</question>",
      ].join("\n");
      const {result} = run(input, 8);
      assert.equal(result.questions.length, 2);
      assert.deepEqual(result.questions[0], {
        text: "Which period should the dashboard show?",
        choices: ["Today", "This week", "This month"],
      });
      assert.deepEqual(result.questions[1], {
        text: "Second valid?",
        choices: ["A", "B", "C"],
      });
    },
  ],
  [
    "suggestion label derived when missing, extras dropped",
    () => {
      const input =
        "<suggest>Show unread conversations first in the inbox</suggest>" +
        "<suggest label=\"B\">b</suggest>" +
        "<suggest label=\"C\">c</suggest>";
      const {result} = run(input, 10);
      assert.equal(result.suggestions.length, 2);
      assert.equal(result.suggestions[0].label,
        "Show unread conversations first");
      assert.equal(result.suggestions[1].label, "B");
    },
  ],
  [
    "protected ghl client cannot be written or deleted",
    () => {
      const input =
        "<file path=\"src/lib/ghl.js\">\nevil()\n</file>\n" +
        "<delete path=\"./src/lib/ghl.js\"/>\n" +
        "<file path=\"src/App.jsx\">\nok\n</file>\n";
      const {finish, result} = run(input, 7);
      assert.equal(result.writes.has("src/lib/ghl.js"), false);
      assert.equal(result.deletes.size, 0);
      assert.equal(result.writes.get("src/App.jsx"), "ok");
      assert.equal(finish.incompleteFile, null);
      assert.ok(result.warnings.length >= 2);
    },
  ],
  [
    "delete without self-close plus </delete> is tolerated",
    () => {
      const {result} = run(
        "<delete path=\"a.js\"></delete><reply>ok</reply>", 4);
      assert.deepEqual([...result.deletes], ["a.js"]);
      assert.equal(result.reply, "ok");
    },
  ],
  [
    "last write wins and delete-then-write revives",
    () => {
      const input =
        "<file path=\"a.js\">\nfirst\n</file>\n" +
        "<file path=\"./a.js\">\nsecond\n</file>\n" +
        "<delete path=\"b.js\"/>\n" +
        "<file path=\"b.js\">\nback\n</file>\n";
      const {result} = run(input, 9);
      assert.equal(result.writes.get("a.js"), "second");
      assert.equal(result.writes.get("b.js"), "back");
      assert.equal(result.deletes.size, 0);
    },
  ],
  [
    "path normalization",
    () => {
      assert.equal(normalizePath("./src/App.jsx"), "src/App.jsx");
      assert.equal(normalizePath("/src/App.jsx"), "src/App.jsx");
      assert.equal(normalizePath("src\\lib\\x.js"), "src/lib/x.js");
      assert.equal(normalizePath("../evil.js"), null);
      assert.equal(normalizePath("a/../b.js"), null);
      assert.equal(normalizePath("  "), null);
    },
  ],
  [
    "whole output without tags is all reply",
    () => {
      const text = "I can only build HighLevel apps, sorry.";
      const {result} = run(text, 5);
      assert.equal(result.reply, text);
      assert.equal(result.writes.size, 0);
    },
  ],
  [
    "unterminated reply flushes at finish",
    () => {
      const {result} = run("<reply>partial answer", 4);
      assert.equal(result.reply, "partial answer");
    },
  ],
  [
    "angle brackets in reply text survive",
    () => {
      const {result} = run(
        "<reply>use a < b and x > y, plus <Widget/> syntax</reply>", 3);
      assert.equal(result.reply,
        "use a < b and x > y, plus <Widget/> syntax");
    },
  ],
];

let failed = 0;
for (const [name, fn] of TESTS) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL - ${name}`);
    console.error(err);
  }
}
if (failed > 0) {
  console.error(`${failed}/${TESTS.length} tests failed`);
  process.exit(1);
}
console.log(`all ${TESTS.length} tests passed`);
