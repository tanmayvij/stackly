// Self-running unit tests for parser.ts. Executed with plain Node
// (no framework): `npm test` → `node lib/modules/builder/parser/parser.test.js`.
// Exits non-zero on the first failure.

import assert from "node:assert";
import {Test, main} from "../../../test/harness";
import {
  AccumulatedResponse,
  LlmStreamParser,
  NO_VARIANT,
  ParseEvent,
  ParseFinish,
  ResponseAccumulator,
  VariantResult,
  normalizePath,
  selectUsableVariants,
} from "./parser";

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
    variants: r.variants.map((v) => ({
      index: v.index,
      rank: v.rank,
      summary: v.summary,
      writes: [...v.writes.entries()],
      deletes: [...v.deletes].sort(),
    })),
    questions: r.questions,
    suggestions: r.suggestions,
  };
}

/**
 * Asserts the response holds exactly one variant and returns it. Responses
 * with no <variant> tags fall back to a single implicit variant, which is how
 * every pre-variant expectation below still reads.
 * @param {AccumulatedResponse} r The response.
 * @return {VariantResult} The only variant.
 */
function only(r: AccumulatedResponse): VariantResult {
  assert.equal(r.variants.length, 1, "expected exactly one variant");
  return r.variants[0] as VariantResult;
}

/**
 * Wraps file blocks in a ranked variant with a summary.
 * @param {number} rank The variant's rank attribute.
 * @param {string} summary The summary line.
 * @param {string} body The file/delete blocks.
 * @return {string} The variant block.
 */
function variant(rank: number, summary: string, body: string): string {
  return [
    `<variant rank="${rank}">`,
    `<summary>${summary}</summary>`,
    body,
    "</variant>",
  ].join("\n");
}

const APP_A = [
  "import React from 'react'",
  "export default function App() {",
  "  return <div className=\"p-4\">table</div>",
  "}",
].join("\n");

const APP_B = [
  "import React from 'react'",
  "export default function App() {",
  "  return <div className=\"grid\">cards</div>",
  "}",
].join("\n");

const FULL_RESPONSE = [
  "<reply>",
  "Built a contacts list with search.",
  "</reply>",
  variant(
    1,
    "Sortable table with inline filters",
    [
      "<file path=\"src/App.jsx\">",
      APP_A,
      "</file>",
      "<file path=\"src/styles.css\">",
      ".card { color: red; }",
      "</file>",
      "<delete path=\"src/Old.jsx\"/>",
    ].join("\n"),
  ),
  variant(
    2,
    "Card grid with a search bar",
    ["<file path=\"src/App.jsx\">", APP_B, "</file>"].join("\n"),
  ),
  "<suggest label=\"Add search\">Add a search box to the list</suggest>",
  "<suggest>Paginate the contacts list, 10 per page</suggest>",
].join("\n");

const TESTS: Test[] = [
  [
    "full two-variant response parses in one shot",
    () => {
      const {finish, result} = run(FULL_RESPONSE, FULL_RESPONSE.length);
      assert.equal(finish.defects.size, 0);
      assert.equal(result.reply, "Built a contacts list with search.");
      assert.equal(result.variants.length, 2);

      const [a, b] = result.variants as [VariantResult, VariantResult];
      assert.equal(a.index, 0);
      assert.equal(a.rank, 1);
      assert.equal(a.summary, "Sortable table with inline filters");
      assert.deepEqual(
        [...a.writes.keys()],
        ["src/App.jsx", "src/styles.css"],
      );
      assert.equal(a.writes.get("src/App.jsx"), APP_A);
      assert.equal(a.writes.get("src/styles.css"), ".card { color: red; }");
      assert.deepEqual([...a.deletes], ["src/Old.jsx"]);

      assert.equal(b.index, 1);
      assert.equal(b.rank, 2);
      assert.equal(b.summary, "Card grid with a search bar");
      assert.deepEqual([...b.writes.keys()], ["src/App.jsx"]);
      assert.equal(b.writes.get("src/App.jsx"), APP_B);
      assert.equal(b.deletes.size, 0);

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
      // Sizes 1-3 split "<variant"/"</variant>" at every offset. Without the
      // tag-prefix hold-back the tags leak into the reply as literal text and
      // both variants silently merge into one write set.
      const oneShot = flat(run(FULL_RESPONSE, FULL_RESPONSE.length).result);
      for (const size of [1, 2, 3, 5, 7, 11, 64]) {
        assert.deepEqual(flat(run(FULL_RESPONSE, size).result), oneShot,
          `chunk size ${size}`);
      }
    },
  ],
  [
    "unclosed file in variant 1 defects only variant 1",
    () => {
      const input = [
        "<variant rank=\"1\">",
        "<file path=\"a.js\">",
        "let x = 1",
        "</variant>",
        "<variant rank=\"2\">",
        "<file path=\"b.js\">",
        "let y = 2",
        "</file>",
        "</variant>",
      ].join("\n");
      for (const size of [1, 4, 13, input.length]) {
        const {finish, result} = run(input, size);
        assert.deepEqual([...finish.defects.keys()], [0], `size ${size}`);
        assert.equal(finish.defects.get(0)?.invalidFileBlocks, 1);
        assert.equal(result.variants.length, 2, `size ${size}`);
        // Variant 2 must survive intact rather than being swallowed as
        // variant 1's file content.
        assert.equal(
          result.variants[1]?.writes.get("b.js"), "let y = 2", `size ${size}`);

        const usable = selectUsableVariants(
          result.variants, finish.defects, []);
        assert.equal(usable.length, 1);
        assert.equal(usable[0]?.index, 1);
        assert.equal(usable[0]?.rank, 1);
      }
    },
  ],
  [
    "missing </variant> before the next variant closes it",
    () => {
      const input = [
        "<variant rank=\"1\">",
        "<file path=\"a.js\">",
        "one",
        "</file>",
        "<variant rank=\"2\">",
        "<file path=\"b.js\">",
        "two",
        "</file>",
        "</variant>",
      ].join("\n");
      const {finish, result} = run(input, 6);
      assert.equal(finish.defects.size, 0);
      assert.equal(result.variants.length, 2);
      assert.equal(result.variants[0]?.writes.get("a.js"), "one");
      assert.equal(result.variants[1]?.writes.get("b.js"), "two");
    },
  ],
  [
    "variants beyond the cap are dropped",
    () => {
      const input = [
        variant(1, "one", "<file path=\"a.js\">\nA\n</file>"),
        variant(2, "two", "<file path=\"b.js\">\nB\n</file>"),
        variant(3, "three", "<file path=\"c.js\">\nC\n</file>"),
      ].join("\n");
      const {result} = run(input, 11);
      assert.equal(result.variants.length, 2);
      assert.deepEqual(
        result.variants.map((v) => [...v.writes.keys()]),
        [["a.js"], ["b.js"]],
      );
      assert.ok(result.warnings.some((w) => w.includes("extra <variant>")));
    },
  ],
  [
    "file blocks outside a variant are dropped when variants exist",
    () => {
      const input = [
        "<file path=\"stray.js\">\nnope\n</file>",
        variant(1, "one", "<file path=\"a.js\">\nA\n</file>"),
        variant(2, "two", "<file path=\"b.js\">\nB\n</file>"),
      ].join("\n");
      const {result} = run(input, 7);
      assert.equal(result.variants.length, 2);
      assert.equal(
        result.variants.some((v) => v.writes.has("stray.js")), false);
      assert.ok(result.warnings.some((w) => w.includes("outside a <variant>")));
    },
  ],
  [
    "a response with no variant tags becomes one implicit variant",
    () => {
      const input =
        "<reply>done</reply>\n<file path=\"a.js\">\nx\n</file>\n" +
        "<delete path=\"b.js\"/>";
      const {finish, result} = run(input, 5);
      assert.equal(finish.defects.size, 0);
      const v = only(result);
      assert.equal(v.index, NO_VARIANT);
      assert.equal(v.rank, 1);
      assert.equal(v.writes.get("a.js"), "x");
      assert.deepEqual([...v.deletes], ["b.js"]);
    },
  ],
  [
    "unusable ranks fall back to emission order",
    () => {
      // Out of range, duplicated, and absent — the model's rank is untrusted
      // input, so emission order is the fallback ordering.
      const cases: [string, string][] = [
        ["<variant rank=\"9\">", "<variant rank=\"1\">"],
        ["<variant rank=\"0\">", "<variant rank=\"1\">"],
        ["<variant rank=\"1\">", "<variant rank=\"1\">"],
        ["<variant>", "<variant>"],
      ];
      for (const [openA, openB] of cases) {
        const input = [
          openA,
          "<file path=\"a.js\">\nA\n</file>",
          "</variant>",
          openB,
          "<file path=\"b.js\">\nB\n</file>",
          "</variant>",
        ].join("\n");
        const {result} = run(input, 9);
        assert.equal(result.variants.length, 2, `${openA} ${openB}`);
        assert.deepEqual(result.variants.map((v) => v.rank), [1, 2],
          `${openA} ${openB}`);
        assert.equal(result.variants[0]?.writes.get("a.js"), "A");
        assert.equal(result.variants[1]?.writes.get("b.js"), "B");
        assert.ok(result.warnings.some((w) => w.includes("ranks unusable")));
      }
    },
  ],
  [
    "a variant tag with extra attributes is ignored, not merged",
    () => {
      const input = [
        "<variant rank=\"1\" summary=\"prose here\">",
        "<file path=\"stray.js\">\nA\n</file>",
        "</variant>",
        variant(1, "ok", "<file path=\"b.js\">\nB\n</file>"),
      ].join("\n");
      const {result} = run(input, 6);
      assert.ok(result.warnings.some((w) => w.includes("malformed variant")));
      const v = only(result);
      assert.equal(v.writes.has("stray.js"), false);
      assert.equal(v.writes.get("b.js"), "B");
    },
  ],
  [
    "a rank-2-first response sorts recommended first",
    () => {
      const input = [
        variant(2, "elaborate", "<file path=\"a.js\">\nA\n</file>"),
        variant(1, "simple", "<file path=\"b.js\">\nB\n</file>"),
      ].join("\n");
      const {finish, result} = run(input, 8);
      assert.deepEqual(result.variants.map((v) => v.rank), [2, 1]);
      const usable = selectUsableVariants(result.variants, finish.defects, []);
      assert.deepEqual(usable.map((v) => v.rank), [1, 2]);
      assert.equal(usable[0]?.summary, "simple");
      assert.equal(usable[0]?.index, 1);
    },
  ],
  [
    "summary is collapsed, clamped, and ignored outside a variant",
    () => {
      const long = "x".repeat(200);
      const input = [
        "<summary>orphan</summary>",
        "<variant rank=\"1\">",
        "<summary>  multi\n  line   summary  </summary>",
        "<file path=\"a.js\">\nA\n</file>",
        "</variant>",
        "<variant rank=\"2\">",
        `<summary>${long}</summary>`,
        "<file path=\"b.js\">\nB\n</file>",
        "</variant>",
      ].join("\n");
      const {result} = run(input, 13);
      assert.equal(result.variants[0]?.summary, "multi line summary");
      assert.equal(result.variants[1]?.summary.length, 120);
      assert.equal(result.reply, "");
      assert.ok(result.warnings.some((w) => w.includes("<summary> outside")));
    },
  ],
  [
    "selectUsableVariants drops empties and collapses duplicates",
    () => {
      const make = (
        index: number,
        rank: number,
        writes: [string, string][],
      ): VariantResult => ({
        index,
        rank,
        summary: `v${rank}`,
        writes: new Map(writes),
        deletes: new Set<string>(),
      });
      const warnings: string[] = [];
      const usable = selectUsableVariants(
        [
          make(0, 1, [["a.js", "A"]]),
          make(1, 2, []),
          // Same content in a different emission order — still a duplicate.
          make(2, 3, [["a.js", "A"]]),
          make(3, 4, [["a.js", "B"]]),
        ],
        new Map(),
        warnings,
      );
      assert.deepEqual(usable.map((v) => [v.index, v.rank]), [[0, 1], [3, 2]]);
      assert.equal(warnings.length, 2);
      assert.ok(warnings.some((w) => w.includes("no file changes")));
      assert.ok(warnings.some((w) => w.includes("identical")));
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
      assert.equal(only(r).writes.get("a.js"), "let x = 1");
      assert.equal(r.reply, "ok");
    },
  ],
  [
    "empty file block",
    () => {
      const {finish, result} = run(
        "<file path=\"empty.txt\">\n</file>\n", 4);
      assert.equal(finish.defects.size, 0);
      assert.equal(only(result).writes.get("empty.txt"), "");
    },
  ],
  [
    "closer-lookalikes inside code stay in content",
    () => {
      const body =
        "const s = \"</file>\";\nconst v = \"</variant>\";\nconst t = 1";
      const input = `<file path="a.js">\n${body}\n</file>\n`;
      for (const size of [1, 9, input.length]) {
        const {result} = run(input, size);
        assert.equal(only(result).writes.get("a.js"), body,
          `chunk size ${size}`);
      }
    },
  ],
  [
    "stray text outside tags becomes reply",
    () => {
      const {result} = run(
        "Sure! Here you go.\n<file path=\"a.js\">\nx\n</file>\n", 5);
      assert.equal(result.reply, "Sure! Here you go.");
      assert.equal(only(result).writes.get("a.js"), "x");
    },
  ],
  [
    "unterminated file block defects its variant",
    () => {
      const {finish, result} = run(
        "<reply>hi</reply>\n<variant rank=\"1\">\n" +
          "<file path=\"a.js\">\nlet x = 1\n", 6);
      assert.equal(finish.defects.get(0)?.incompleteFile, "a.js");
      assert.equal(result.reply, "hi");
      assert.equal(
        selectUsableVariants(result.variants, finish.defects, []).length, 0);
    },
  ],
  [
    "file closer at end of input (no trailing newline)",
    () => {
      const {finish, result} = run(
        "<file path=\"a.js\">\nlet x = 1\n</file>", 5);
      assert.equal(finish.defects.size, 0);
      assert.equal(only(result).writes.get("a.js"), "let x = 1");
    },
  ],
  [
    "variant closer at end of input closes the variant",
    () => {
      const input =
        "<variant rank=\"1\">\n<file path=\"a.js\">\nx\n</file>\n</variant>";
      const {finish, result} = run(input, 5);
      assert.equal(finish.defects.size, 0);
      assert.equal(only(result).writes.get("a.js"), "x");
      assert.equal(
        result.warnings.some((w) => w.includes("stream ended inside")), false);
    },
  ],
  [
    "malformed file tag skips block and defects the variant",
    () => {
      const {finish, result} = run(
        "<variant rank=\"1\">\n<file>\nsecret\n</file>\n</variant>\n" +
          "<reply>done</reply>", 3);
      assert.equal(finish.defects.get(0)?.invalidFileBlocks, 1);
      assert.equal(result.variants[0]?.writes.size, 0);
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
      assert.equal(result.variants.length, 0);
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
      assert.equal(result.suggestions[0]?.label,
        "Show unread conversations first");
      assert.equal(result.suggestions[1]?.label, "B");
    },
  ],
  [
    "protected ghl client cannot be written or deleted in any variant",
    () => {
      const input = [
        variant(1, "one", [
          "<file path=\"src/lib/ghl.js\">",
          "evil()",
          "</file>",
          "<delete path=\"./src/lib/ghl.js\"/>",
          "<file path=\"src/App.jsx\">",
          "ok",
          "</file>",
        ].join("\n")),
        variant(2, "two", [
          "<file path=\"src/lib/ghl.js\">",
          "also evil()",
          "</file>",
          "<file path=\"src/App.jsx\">",
          "ok2",
          "</file>",
        ].join("\n")),
      ].join("\n");
      const {finish, result} = run(input, 7);
      assert.equal(finish.defects.size, 0);
      for (const v of result.variants) {
        assert.equal(v.writes.has("src/lib/ghl.js"), false);
        assert.equal(v.deletes.size, 0);
      }
      assert.equal(result.variants[0]?.writes.get("src/App.jsx"), "ok");
      assert.equal(result.variants[1]?.writes.get("src/App.jsx"), "ok2");
      assert.ok(result.warnings.length >= 3);
    },
  ],
  [
    "delete without self-close plus </delete> is tolerated",
    () => {
      const {result} = run(
        "<delete path=\"a.js\"></delete><reply>ok</reply>", 4);
      assert.deepEqual([...only(result).deletes], ["a.js"]);
      assert.equal(result.reply, "ok");
    },
  ],
  [
    "last write wins and delete-then-write revives, per variant",
    () => {
      const input = [
        variant(1, "one", [
          "<file path=\"a.js\">\nfirst\n</file>",
          "<file path=\"./a.js\">\nsecond\n</file>",
          "<delete path=\"b.js\"/>",
          "<file path=\"b.js\">\nback\n</file>",
        ].join("\n")),
        variant(2, "two", [
          "<file path=\"a.js\">\nother\n</file>",
          "<delete path=\"b.js\"/>",
        ].join("\n")),
      ].join("\n");
      const {result} = run(input, 9);
      const [a, b] = result.variants as [VariantResult, VariantResult];
      assert.equal(a.writes.get("a.js"), "second");
      assert.equal(a.writes.get("b.js"), "back");
      assert.equal(a.deletes.size, 0);
      assert.equal(b.writes.get("a.js"), "other");
      assert.deepEqual([...b.deletes], ["b.js"]);
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
      assert.equal(result.variants.length, 0);
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

void main("parser (pure)", TESTS);
