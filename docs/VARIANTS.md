# Response variants

**Every builder generation returns two ranked alternatives instead of one, and the user picks which one gets committed.** The model proposes two genuinely different implementations of the same request, ranks them by suitability, and the chat panel lets the user toggle between them — previewing each in the live iframe and diffing it against the current code — before anything is written. Only the chosen variant becomes a version; the other is discarded.

This document covers why the feature exists, how it works end to end, and the trade-offs behind the decisions that shaped it.

---

## Table of contents

1. [Business context](#business-context)
2. [What the user sees](#what-the-user-sees)
3. [Architecture](#architecture)
   - [Output protocol](#1-output-protocol-promptts)
   - [Parser](#2-parser-parserts)
   - [Chat endpoint](#3-chat-endpoint-chatcontrollerts)
   - [Resolution callables](#4-resolution-callables-variants)
   - [Client](#5-client)
4. [Billing](#billing)
5. [Trade-offs and decisions](#trade-offs-and-decisions)
6. [Edge cases](#edge-cases)
   - [The first-generation preview](#the-first-generation-preview)
   - [The concurrency conflict](#the-concurrency-conflict)
7. [Known limitations](#known-limitations)
8. [Future enhancements](#future-enhancements)
9. [Testing](#testing)
10. [File reference](#file-reference)

---

## Business context

Before this feature, one generation produced one outcome, committed the instant the stream closed. The user's only recourse for a result they disliked was to describe the problem in another message and pay for another generation — and the unwanted code was already the new head version, sitting in their history.

That is a poor fit for the actual job. "Show me my contacts" has many reasonable answers — a table, a card grid, grouped by letter — and which one is *right* is a matter of taste the model cannot know in advance. Asking the model to guess once and committing the guess saves the cheapest thing in the loop (extra output tokens) but wastes the most expensive (a round trip through the user's attention).

Two variants change the interaction from *describe → receive → correct* to *describe → choose*. The incremental cost is modest: the prompt resends every project file each turn and dominates the token count, so only the completion half doubles. Measured against the live models, a two-variant turn costs roughly **1.2–1.4× a single-variant turn** — nearer the low end the larger the project, because the prompt grows while the completion does not. The user gets a decision instead of a correction.

A second benefit falls out of the design: because nothing is committed until the user chooses, **a generation can no longer put code into a project against the user's will.** Preview-before-commit is a safety property, not just a convenience.

---

## What the user sees

```
you: Show my contacts with names and emails

✨ I built two takes on the contacts view.

   ┌──────────────────────────────────────────────────┐
   │ Two ways to do this — preview each, then keep one.│
   │                                                   │
   │  [★ Option A · Recommended]  [Option B]           │
   │                                                   │
   │  Plain sortable table, no extra files             │
   │   ▸ src/App.jsx                        +42 -8     │
   │                                                   │
   │  [ ✓ Keep Option A ]      [ Discard ]             │
   └──────────────────────────────────────────────────┘

composer: disabled — "Keep or discard an option to continue…"
```

- Toggling an option rebuilds the **live preview** from that variant, with an amber banner naming what is on screen and reminding that it is not applied yet.
- Expanding a file row shows an inline **Monaco diff** of the current code against that variant.
- The rank-1 variant is badged **Recommended** and is previewed by default.
- The composer and the whole file-editing surface (save, create, rename, delete, restore) are **locked** while a turn is pending — the turn is not over until it is resolved.
- **Discard** goes through a confirmation that states plainly that the changes are not saved anywhere and that the generation has already been charged.

---

## Architecture

The pipeline is the existing one with a variant layer threaded through it. The single structural change is **where the commit happens**: it moved out of the streaming request into a separate callable, invoked by an explicit user action.

```
┌── chat (onRequest, SSE) ─────────────────────────────────────────────┐
│  balance gate → chat lock → compaction → streamed LLM call           │
│      ↓                                                               │
│  LlmStreamParser ──► ResponseAccumulator ──► selectUsableVariants     │
│      ↓ (mirrored to the wire, per variant)                           │
│  reply-delta · variant-start · variant-summary · file-start           │
│  file-delta · file-end · file-delete · variant-end                   │
│      ↓                                                               │
│  debit wallet  →  send `variants` frame  →  done.  COMMITS NOTHING.   │
└──────────────────────────────────────────────────────────────────────┘
                                   ↓
                    client holds both variants in memory,
                    verifies each file against the server's sha256,
                    previews / diffs from that content
                                   ↓
              user picks ──────────┴────────── user discards
                    ↓                                ↓
      applyVariant (onCall)              discardVariants (onCall)
      upload chosen blobs                 no version; writes an
      conflict check → rebase             `interrupted` assistant
      → version + message (1 txn)         turn so the ledger reconciles
```

### 1. Output protocol (`prompt.ts`)

The OUTPUT PROTOCOL keeps the original `<file>` / `<delete>` grammar untouched and wraps **a set of them** in each variant:

```
<reply>
One to three sentences: what you built or changed.
</reply>
<variant rank="1">
<summary>Plain sortable table, no extra files</summary>
<file path="src/App.jsx">
...entire file content...
</file>
</variant>
<variant rank="2">
<summary>Card grid with a search bar</summary>
<file path="src/App.jsx">
...entire file content...
</file>
<delete path="src/Old.jsx"/>
</variant>
<suggest label="Add search">Add a search box to filter contacts</suggest>
```

`<reply>`, `<question>` and `<suggest>` stay global. The prompt states several rules that each defend against a specific observed failure:

| Rule | Failure it prevents |
|---|---|
| Variants must be **genuinely different approaches** | Two cosmetic rewrites, charging double for a meaningless choice |
| Each variant is **independent** — full `<file>` blocks measured against the *current* files, never against the other variant; never "same as variant 1 but…" | A lazy second variant produces a syntactically valid file that would commit cleanly. **There is no server-side detector for this** — it is prompt-enforced only |
| Put the **simpler variant first** | If output is truncated, the elaborate one is lost rather than the safe one |
| A turn that asks a `<question>` emits **no variants** | A blocked turn should not be offering options |
| Summary is one line, no angle brackets, and the prompt **asks** for under 80 chars | See the parser note on attributes below |

Note the two summary numbers, which are deliberate and not a contradiction: the prompt *asks* for under 80 characters, while `MAX_VARIANT_SUMMARY_CHARS` (120) is the *enforced* clamp — headroom so a slightly chatty summary gets trimmed instead of costing the variant. 80 is an instruction to the model; 120 is the only value any code checks.

Every enforced bound in the feature lives in `shared/config/limits.ts` — `VARIANT_COUNT`, `MAX_VARIANT_SUMMARY_CHARS`, `MAX_VARIANT_FILES`, `MAX_VARIANT_PATH_CHARS`, `MAX_VERSION_TITLE_CHARS`, `DEFAULT_VERSION_TITLE`, `BLOB_HASH_PATTERN`, `MAX_ECHOED_LIST_ITEMS` — so the parser (bounding model output) and the resolution callables (bounding the client's echo of it) can never drift apart. `VARIANT_COUNT` is additionally spelled out in prose in the protocol, so raising it means editing both.

### 2. Parser (`parser.ts`)

The parser is a streaming state machine, and it stays one — variants are handled by a **counter, not a state**. Three implementation details here are load-bearing rather than stylistic, and each was a real bug caught during development:

- **A `"variant"` parser state hangs the instance.** `push()` drives `switch (this.state)` inside a `while (again)` loop, and `scanText` returns `true` the moment the state leaves `text|reply`. An unhandled state means `again` keeps its previous value and the loop spins forever inside the streaming `for await` — burning to the 540 s Cloud Run timeout without ever checking the abort signal. Variants are tracked with `private variant` / `private variantCount`, set from `applyTag` without touching `this.state`, and the switch now has a `default: again = false` as a structural guard.

- **`<variant` must be registered in the tag hold-back sets.** `couldBeTagPrefix` decides whether a partial `"<vari"` at a chunk boundary is worth waiting for. Unregistered, it is flushed into the reply as literal text, the variant never opens, and **every file from both variants merges into one last-write-wins set** — producing a Frankenstein tree that passes every existing validity check. Chunk sizes of 1–3 characters in the test suite exist specifically to catch this.

- **`</variant>` alone on a line is a hard terminator inside a `<file>` block.** `scanFile` only ever recognised `</file>`. If the model forgets one, `</variant>` and all of variant 2 become variant 1's file content, and the block closes on variant 2's *first* `</file>` — leaving `incompleteFile` null, so the corrupt result passes the malformed check. Hitting `</variant>` inside a file now marks that variant defective and closes it.

- **The summary is a nested block, not an attribute.** `scanText` finds a tag's end with a bare `indexOf(">")`. A model-authored `summary="Uses grid > flexbox"` or `summary="Adds a <select> filter"` truncates the tag at the wrong character and lands in the merge bug above. `rank` — digits only — is the sole attribute.

Downstream of the state machine:

- **Events carry their variant.** `file-start` / `file-delta` / `file-end` / `file-delete` gained a `variant: number`. `NO_VARIANT` (`-1`) marks blocks emitted outside any variant.
- **`ParseFinish.defects` is per variant** (`Map<number, VariantDefect>`), replacing the old scalar `incompleteFile` / `invalidFileBlocks`. A bad tag in variant 1 must not poison variant 2 — that is the entire point of the relaxation.
- **`ResponseAccumulator`** keeps `reply`, `questions`, `suggestions` and `warnings` shared, and moves `writes` / `deletes` into per-variant records. The full path policy (`normalizePath`, `PROTECTED_PATHS`, last-write-wins, write/delete exclusivity) applies per variant, unchanged.
- **`selectUsableVariants`** is the policy gate: it drops defective variants, drops variants with no file changes, collapses variants whose content signatures are identical, and re-ranks the survivors contiguously from 1 so a rank-1 "Recommended" always exists.
- **Tolerance is preserved.** A response with no `<variant>` tag at all becomes a single implicit variant, so a model that ignores the protocol still produces a usable turn. Rank is untrusted: emission order is authoritative for `index`, and ranks are honoured only when they form a clean permutation of `1..n`.

### 3. Chat endpoint (`chat.controller.ts`)

`forward` mirrors the new variant events to the wire and **normalizes file paths server-side** — the client keys its assembled content by path, so `./src/Card.jsx` on the wire would not match `src/Card.jsx` in the `variants` frame.

The terminal branches, in order (the guards come first: staging after a late `clientGone` abort would produce both an `interrupted` message and a charge the code declares free):

1. client gone / timed out / stream failed → unchanged, nothing billed
2. `selectUsableVariants` → zero survivors **and** defects present → `malformed_output` (the existing path)
3. zero file changes anywhere → plain assistant message, committed immediately (questions, refusals — unchanged)
4. otherwise → debit, emit `variants`, `done`. **No blobs, no version, no message.**

The `variants` frame carries what resolution needs:

```ts
{
  requestId: string        // keys the ledger lookup and the idempotency check
  baseVersion: number      // head at generation time — what a conflict is measured from
  title: string            // version title for the user turn THIS generation answers
  platformFiles: { path, hash }[]   // preview-only; see below
  variants: [{
    index, rank, summary,
    writes: { path, hash }[],   // server-computed sha256 per file
    deletes: string[],
  }]
}
```

`baseVersion` and `title` are **pinned here, to this generation.** Both would be wrong if derived at apply time — see [the concurrency conflict](#the-concurrency-conflict).

`platformFiles` carries the platform-owned `src/lib/ghl.js` when the head tree doesn't already have it at the current hash, via `ensurePlatformFiles`, which also uploads the blob. It exists purely so the **preview** can resolve the import; the commit injects the same file server-side regardless of what the client sends. See [the first-generation preview](#the-first-generation-preview).

Shipping the hashes serves two purposes: the client verifies the content it assembled from the stream (`chat-stream.ts` skips malformed SSE frames silently, so a dropped `file-delta` would otherwise commit truncated code), and they name the blobs it uploads.

### 4. Resolution callables (`variants/`)

Messages are client-write-`false` in `firestore.rules`, and the version + message create must stay in one transaction, so the server remains the sole committer.

**`applyVariant`**

1. `requireUid`, project exists and is not soft-deleted.
2. **Idempotency on `requestId`** — if an assistant turn already exists for this generation, return its `versionN` and commit nothing. A double-click must not commit twice: `commitAiVersionAndMessage`'s slot scan is designed to *skip* taken slots, so two concurrent calls would otherwise both succeed at `n` and `n+1`.
3. Validate the delta — `normalizePath`, reject `PROTECTED_PATHS`, cap at `MAX_VARIANT_FILES`, require a lowercase 64-hex hash, and confirm every blob actually exists in Storage (`missingBlobs`). A version pointing at a missing blob is unrecoverable.
4. **Conflict check** — see below.
5. **Rebase, don't snapshot** — `rebaseOntoTree` applies the hash delta onto the *current* head and force-injects the platform `src/lib/ghl.js`.
6. Commit the version + assistant message in one transaction, with `files` derived from the validated delta and the title from the payload.

Billing figures are **never taken from the caller**: `readTurnBilling` reads the ledger entry the chat endpoint wrote at `chat:${requestId}`. `contextTokens` drives compaction, so a client-supplied value would quietly stop long conversations from ever being summarized.

`reply`, `summary`, `title`, `questions` and `suggestions` *are* caller-supplied — the server keeps no copy once the stream closes. That is a deliberate, bounded exposure: they land only in the caller's own transcript, they are all length- and type-validated, and a user can already put arbitrary text there by typing it.

**`discardVariants`** — same guards, then writes an assistant turn with `status: "interrupted"`, no files, no version, and ledger-derived billing. See [the discard marker decision](#5-discard-writes-a-stopped-marker).

### 5. Client

The store keeps each variant's file contents in memory, assembled from the `file-delta` frames it previously **dropped**:

```ts
interface PendingVariant {
  index: number; rank: number; summary: string
  contents: Map<string, string>   // path → full content, from the stream
  hashes:   Map<string, string>   // path → server sha256
  deletes: string[]
}
interface PendingTurn {
  projectId, requestId, reply, title, baseVersion,
  questions, suggestions, variants: PendingVariant[]
}
```

Notable pieces:

- **The pending turn is a first-class pseudo-message, not the stream overlay.** `armOverlayClear` clears the overlay 5 s after a stream ends; with no message doc to replace it, the reply would simply vanish. The reply is snapshotted onto `pendingTurn` and the overlay clears normally.
- **Hash verification is async, so it runs after the stream closes.** `onStreamEvent` stashes the `variants` frame; `runStream` then awaits `finalizePendingTurn`, which hashes each assembled file and drops any variant that does not match.
- **Preview needs no new plumbing.** `previewManifest` is head with the selected variant applied on top (deleted paths *removed*, not nulled — a null key comes back as an empty folder in `manifestToRows`), and `previewContents` supplies the bytes for paths that have no blob yet. `bundlePreview` resolves purely by path, so an overlay reader is enough. The rebuild watch key includes `requestId` — discarding one turn and generating another can land on the same variant index with head unmoved, which would otherwise look like no change at all.
- **`usePreview` no longer short-circuits on `headVersion === 0`.** A brand-new project's first turn is generated at head 0; emptiness now comes from the manifest alone, or both variant previews would render blank on the product's most visible moment.
- **`isBusy` = streaming ∨ pending ∨ applying** gates every chat affordance, and `filesLocked` gates every commit path plus the Monaco editor's `readOnly`.
- **Resolution hands off like the stream does.** `armPendingClear` keeps the chooser on screen (disabled) until the resulting message doc arrives, so the turn never blinks out of the transcript.

`ChatFileDiff.vue` was split: the Monaco wrapper is now content-agnostic `FileDiff.vue`, with `ChatFileDiff` resolving committed blobs and `VariantDiff` resolving head-blob-vs-in-memory-content.

---

## Billing

**Unchanged in model: the user is charged for the tokens actually used.** Mechanically:

- The wallet is debited **once, at generation time**, before the options are offered, at `refId: chat:${requestId}` — idempotent as always.
- The tokens are spent whether or not a variant is applied, so **discarding is not a refund.** The confirmation dialog says so explicitly.
- Resolution reads the figures back off that ledger entry rather than re-deriving or trusting the client.


---

## Trade-offs and decisions

### 1. Two variants from the model, not four ranked down to two

The original design was for the model to return **four** variants, scored on weighted parameters in the backend, with the worst two eliminated before anything reached the user.

**This was dropped, deliberately, in favour of streaming.** Ranking four candidates requires all four in memory before any judgement can be made — which means the backend cannot forward *anything* until generation is complete. That is a direct trade of the product's most visible quality (code appearing as it is written) for an invisible one (slightly better candidate selection).

If backend ranking becomes non-negotiable, there is a middle path: **stream `<reply>` to the user in real time, then buffer the file blocks server-side**, rank once all variants are complete, and release only the winners. The reply still arrives instantly, so the turn does not feel dead. But the file chips, the per-file progress, and the whole "watching it build" affordance would appear only after the *entire* generation finished — on a 4-variant turn, that is a multiple of today's already-substantial wait, staring at a static sentence. That is a real UX downgrade, and it is why the current design asks the model to do its own ranking instead.

The model's self-ranking is imperfect but nearly free, and `rank` is treated as untrusted input in any case.

### 2. Two variants in one run, not two concurrent runs

The alternative was two parallel single-variant calls, possibly against different models. That would have deleted several parser problems outright — no new tags, no attribute escaping, no nesting, no chunk-boundary hazards, and per-variant validity for free.

It was rejected on cost and complexity. `costForTokens` bills a flat per-token rate with **no prompt-cache discount**, and every turn resends all project files — so the prompt is the expensive half, and sending it twice costs roughly **1.4–1.7× a single two-variant call**, rising with project size. It also means maintaining two concurrent streams with independent failure modes, and it loses the cross-variant ranking the "Recommended" badge depends on (recoverable with a flash-model judge, at the cost of another call).


### 3. Variants live in browser memory, not on the server

The considered alternative was to upload both variants' blobs during the run and stage their manifests in a server-side document.

**In-memory was chosen** because persisting uncommitted work is not a business requirement today, and the server-side version means new infrastructure to own: staging documents to write, stale ones to garbage-collect, and orphaned blobs from every unselected variant — permanent garbage, since the repo has no blob GC.

What it costs:

- **A reload loses the variants.** The user message is left unanswered, which the existing "Generation was interrupted — Resume" affordance already handles, so this degrades to a known state rather than a broken one.
- **The client authors part of the assistant turn** (reply, summary, title). Bounded and validated, as described above.
- **Other tabs cannot see that a turn is mid-choice**, which is what made [the concurrency conflict](#the-concurrency-conflict) reachable.

Worth noting that letting the client assemble blobs crosses **no new trust boundary**: `storage.rules` already permits the client to `create` a blob at any hash path, and `firestore.rules` already permits it to create version documents and advance `headVersion` — that is exactly how manual saves work today.

This is the decision to revisit first when cross-session persistence is needed. See [future enhancements](#future-enhancements).

### 4. Shared reply, per-variant summary

The alternative — a `<reply>` inside each variant — was rejected on UX grounds: two replies read as **the chat having answered twice, which looks like a bug.** One reply describes the change; each variant carries a one-line `<summary>` describing how it differs.

### 5. Discard writes a "Stopped" marker

The wallet is debited at generation time, so a discard that wrote nothing would leave a charge in the ledger with **no corresponding row in the transcript** — unauditable, and impossible to reconcile against.

Discard therefore writes an assistant turn with `status: "interrupted"`, no files and no version. This reuses the existing "Stopped" pill and Retry button, keeps compaction accounting correct (it reads `lastAssistant.contextTokens`), and prevents the transcript from accumulating consecutive user turns — which would otherwise put two adjacent user messages in the next prompt and have the model redo work.

The variants themselves are still never persisted.

### 6. Partial validity: offer the valid variant

Doubling output length makes truncation meaningfully more likely, so validity is tracked **per variant**. One truncated variant is dropped and the other is still offered; only if *every* variant is malformed does the turn fail with the existing `malformed_output` error.

The alternative — today's all-or-nothing rule — would waste a perfectly good variant, and charge for it either way. The cost of the relaxation is that per-variant defect tracking has to be genuinely correct, which is what the `</variant>`-as-terminator fix is about.

### 7. One usable variant still requires a choice

When the model returns near-identical variants (collapsed by content signature) or only one valid one, the chooser still appears with a single option plus Discard.

Auto-applying would mean two code paths and, worse, would make the preview-before-commit step appear and disappear **depending on what the model happened to return** — unpredictable in exactly the way a safety property should not be.

### 8. No output-token cap

An explicit `max_tokens` was implemented and then **deliberately removed**: capping output risks truncating the stream mid-file, and a truncated file is a wasted generation.

Because per-variant validity absorbs most of the truncation risk, the failure mode without a cap is *degraded choice* (one variant dropped, the other offered), not a bad commit. Only if both truncate does the turn fail.

The better version of this belongs in the billing module, and the streaming design makes it possible: **enforce the cap at our level and cut the stream at a file boundary.** Because tokens arrive incrementally and the parser already knows when a `<file>` block closes, generation can be stopped *after* the current file completes rather than mid-content — yielding a shorter but structurally valid response instead of a malformed one.

---

## Edge cases

| Case | Behaviour |
|---|---|
| Both variants fail hash verification client-side | The turn is not offered; an error asks the user to try again |
| One variant fails hash verification | It is dropped and survivors are re-ranked from 1, so option letters stay contiguous |
| Model ignores the protocol entirely (bare `<file>` blocks) | Treated as one implicit variant — pre-variant behaviour preserved |
| Model emits more than `VARIANT_COUNT` variants | Extras are dropped with a warning; their blocks fall to `NO_VARIANT` and are discarded |
| Model emits duplicate, out-of-range or non-numeric ranks | Emission order is used instead, with a warning |
| File blocks outside any `<variant>` when real variants exist | Dropped with a warning — never merged into a real variant |
| Turn changes no files (question, refusal) | Committed immediately as before; no chooser |
| Turn has both questions and variants | Variants are offered; the questions ride along and become answerable once applied |
| Double-click on Keep | Idempotent on `requestId` — the second call returns the first commit |
| Apply fails mid-way (network, timeout) | The pending turn stays; retrying is safe because of the idempotency check |
| Blob upload partially fails | `missingBlobs` rejects the commit before anything is written; the user can retry |
| Project switched while applying | `runSeq` discards the stale UI update; the commit still lands server-side, which is what the user asked for |
| Head moves via a manual save in **another** tab, no file overlap | Rebased cleanly — the manual edit survives, the preview auto-tracks the new head |
| Head moves and a file **does** overlap | Rejected — see below |

### The first-generation preview

Generated apps import `./lib/ghl`, and `src/lib/ghl.js` is platform-owned — the model is forbidden from writing it (`PROTECTED_PATHS`), and a commit injects it.

Injecting it *at commit* was sufficient while the commit happened inside the streaming request: the preview always read a head that already had the file. Moving the commit behind a user action broke that. The preview now reads an uncommitted manifest, and on a project's **first** generation head is empty — so the manifest has `src/App.jsx` and nothing else, the import cannot resolve, and the bundle fails:

```
head 0 + variant writes only
  manifest: src/App.jsx
  BUILD WOULD FAIL: Cannot resolve './lib/ghl' from 'src/App.jsx'
```

Worse, the client could not have fixed this locally: the frontend holds no copy of the client source, and for a never-committed project the blob does not exist in Storage either. This hit the most visible moment in the product — the auto-run generation immediately after Create Project.

`ensurePlatformFiles(uid, projectId, tree)` now owns the whole concern. It returns the platform files a tree is missing *and* uploads their blobs, and both callers go through it — `rebaseOntoTree` at commit, and the chat endpoint when it offers variants — so the condition (`tree[GHL_CLIENT_PATH] !== GHL_CLIENT_SHA256`) is stated once and a preview always matches what applying would produce:

```
head 0 + variant writes + platform files
  manifest: src/App.jsx, src/lib/ghl.js
  resolved -> src/lib/ghl.js (1685 bytes readable from Storage)
```

Only the *first* generation of a project was affected: after any commit, head carries the file and the preview picks it up from `headManifest`. A stale copy at head resolved but would have previewed the outdated client — the hash comparison covers that too.

### The concurrency conflict

**This is the one non-obvious failure the pending window introduced, and it was found and fixed after the initial implementation.**

The old design was accidentally safe. The per-project chat lock was held for the whole request, and the commit happened *inside* that request — so a second generation could not start until the first one's changes were already at head, and its prompt saw them.

Offering variants ends the request. The lock releases, and a second tab is free to run. Worse, that second tab **cannot even tell** the first one is mid-choice: the variants live in the first tab's memory, so tab B sees only an unanswered user turn and a live composer.

**The scenario.** Both tabs at head v1. Tab A generates, offers options. Tab B — seeing a dangling turn — sends its own message and generates. Both tabs now hold variants built against **v1**. Tab A applies. Tab B applies.

Reproduced against the emulator before the fix:

```
apply A -> v2   apply B -> v3

head v3:  src/App.jsx = B's version      ← A's change silently gone
transcript: seq 1 user  seq 2 user  seq 3 assistant v=2  seq 4 assistant v=3
versions:   v2 "add a contacts table"    v3 "add a contacts table"
```

Three distinct defects:

1. **Silent lost update.** Variants carry *full* file contents built against v1. Committing B's `src/App.jsx` over A's v2 discarded A's change completely — while the transcript still showed A's turn as successfully applied at v2. The user has a version history that lies.
2. **Wrong version title.** Both versions came out titled *"add a contacts table"*. `versionTitle` scans for the **last** user turn, which by A's apply time was B's — so A's version was labelled with B's request in the sidebar.
3. **Transcript ordering.** `[userA, userB, assistantA, assistantB]` — A's reply answers A's request but is appended after B's. The next prompt shows the model two consecutive user turns followed by two replies, with no way to pair them.

**The fix — optimistic concurrency on the touched paths.**

The `variants` frame pins `baseVersion` (head at generation time) and `title` (derived from the user turn that generation answers). At apply time, when head still equals `baseVersion` nothing extra happens — the common case costs zero reads. When head has moved, the server compares the base tree against the current head over **only the paths this variant writes or deletes**:

```ts
const touched = [...delta.writes.keys(), ...delta.deletes];
return touched.filter((path) => baseTree[path] !== headTree[path]);
```

Any overlap aborts the commit with `HttpsError("aborted")` naming the files. Non-overlapping changes still rebase cleanly, which preserves the genuinely useful case — a manual `styles.css` save while the user reads the options.

Comparing hashes catches every kind of change, including a path added or deleted at head (`undefined` versus a hash).

Same scenario, after the fix:

```
apply A -> v2
apply B -> REJECTED (aborted) src/App.jsx changed since these options were
           generated. Discard them and ask again so the change isn't lost.

head v2:  src/App.jsx = A's version      ← survived
versions: v2 "A request"                 ← titled after its own turn
```

**First to apply wins; the loser gets an actionable error and nothing is destroyed.** This matches the posture already used elsewhere in the repo — client-side `commitVersion` retries on slot collision rather than locking.

In the UI, a conflict is terminal: head only moves forward, so applying can never succeed afterwards. The chooser shows the conflict inline and **removes the Keep button**, leaving Discard as the only move.

A deliberate non-choice: no "reject if a newer user turn exists" guard was added, even though it would make transcript ordering strictly correct. It would punish the **first** tab — which did nothing wrong and has already paid for its generation — merely because a second tab typed something.

---

## Known limitations

- **Variants do not survive a reload**, by design. The user turn is left unanswered and the existing Resume affordance re-runs it.
- **The standalone preview tab (`/preview/:id`) always shows head.** It is a separate app instance with its own Pinia store, so it cannot see another tab's in-memory variants.
- **Transcript ordering can still interleave** in the narrow case where two concurrent turns touch no common file. Both commit, every turn is present and honest, but replies sit after a later user turn. Cosmetic, and rare — two prompts about the same app almost always overlap on `src/App.jsx`.
- **A lazy second variant is prompt-enforced only.** If the model writes "same as variant 1 but with…" inside a `<file>` block, the result is syntactically valid and will commit. There is no server-side detector.
- **Cross-tab awareness is impossible** at this design point — nothing is staged for another tab to observe. The conflict check converts this from data loss into a clear rejection.

---

## Future enhancements

1. **Persist variants across sessions — close to a must-have.** Once the stream completes, write the variants to the database so a reload, a crash, or a different device can resume the choice instead of losing a paid generation. The cheapest shape is a **turn receipt**: a small server-side document holding the message payload plus each variant's `{path → sha256}` delta and `deletes` — **hashes only, never file contents** (a 30-file, two-variant turn of file bodies would be ~480 KB against Firestore's 1 MiB document limit). This also gives cross-tab awareness for free, which would let a second tab block or warn instead of racing.
2. **Enforce an output cap at the file boundary** (see [decision 8](#8-no-output-token-cap)) — a billing-module concern, and the reason `max_tokens` is currently unset.
3. **Backend ranking of a larger candidate pool** (see [decision 1](#1-two-variants-from-the-model-not-four-ranked-down-to-two)) — viable if the reply-first / buffer-files trade is judged acceptable, or if a cheap judge model can rank streamed variants after the fact without blocking them.
4. **Raise `LOW_BALANCE_THRESHOLD_CENTS`**, which is calibrated for single-variant turns.
5. **Per-variant cost display**, so the user can see what a choice cost before discarding it.

---

## Testing

`93` pure unit tests and `41` emulator tests, all framework-free (`functions/src/test/harness.ts`).

**Parser** (`parser.test.ts`) — the variant protocol touches `couldBeTagPrefix`, `applyTag`, `scanFile`, `finish` and every `ParseEvent` shape, so coverage was largely rewritten. Load-bearing cases:

- chunk splits **inside** `<variant` / `</variant>` at every offset (sizes 1, 2, 3, 5, 7, 11, 64) — the tag-merge bug is only findable this way
- an unclosed `<file>` in variant 1 → variant 1 defective **and** variant 2 parses cleanly
- variants beyond the cap; duplicate, out-of-range, absent and non-numeric ranks; extra attributes on the variant tag
- file blocks outside a variant; a response with no variant tags at all
- `</file>` **and** `</variant>` lookalikes inside file content staying content
- `selectUsableVariants` dropping empties and collapsing duplicates

**Resolution** — `variants.service.test.ts` (path/hash/title/baseVersion validation) and `variants.service.emulator.test.ts` (commit shape, ledger-derived billing, idempotent double-apply, benign rebase, **conflict abort on both write and delete**, title pinned against a newer user turn, missing-blob refusal, discard writing an `interrupted` turn).

**Beyond the suites**, three checks were run that unit tests cannot cover:

- **Server → wire → client contract**, replaying real controller output through the client's assembly logic at seven chunk sizes: two variants reassembled byte-exact, hashes verified, `./src/Card.jsx` normalized so the client's keys match.
- **The concurrency conflict**, reproduced against the emulator before and after the fix (output quoted above).
- **Live protocol adherence** on all three production models — `zai-org/GLM-5.2`, `openai/gpt-oss-120b`, `moonshotai/Kimi-K2.7-Code`. All three obeyed the protocol on the first attempt, with genuinely different approaches, full file content, and zero parse defects or warnings. Completion length was 2.5k–4.5k tokens.

---

## File reference

**Server**

| Path | Role |
|---|---|
| `functions/src/shared/config/limits.ts` | `VARIANT_COUNT`, `MAX_VARIANT_SUMMARY_CHARS`, `MAX_VARIANT_FILES` |
| `functions/src/modules/builder/chat/prompt.ts` | OUTPUT PROTOCOL with `<variant>` / `<summary>` |
| `functions/src/modules/builder/parser/parser.ts` | Per-variant parsing, `ParseFinish.defects`, `selectUsableVariants` |
| `functions/src/modules/builder/chat/chat.controller.ts` | Streams variant events, emits the `variants` frame, commits nothing |
| `functions/src/modules/builder/variants/variants.service.ts` | Validation, conflict check, apply / discard |
| `functions/src/modules/builder/variants/variants.controller.ts` | `applyVariant`, `discardVariants` callables |
| `functions/src/modules/builder/versions/versions.service.ts` | `rebaseOntoTree`, `missingBlobs`, `versionTitle` |

**Client**

| Path | Role |
|---|---|
| `stackly-frontend/src/lib/chat-stream.ts` | Variant stream event types, `ChatVariantSummary` |
| `stackly-frontend/src/lib/callables.ts` | `applyVariant`, `discardVariants` |
| `stackly-frontend/src/stores/builder.ts` | `pendingTurn`, `previewManifest`, `previewContents`, `variantConflict`, `filesLocked` |
| `stackly-frontend/src/components/builder/VariantChooser.vue` | The chooser: toggle, Recommended badge, Keep / Discard |
| `stackly-frontend/src/components/builder/VariantDiff.vue` | Head blob vs in-memory variant content |
| `stackly-frontend/src/components/builder/FileDiff.vue` | Content-agnostic Monaco diff (extracted from `ChatFileDiff`) |
| `stackly-frontend/src/composables/usePreview.ts` | Builds from `previewManifest` with an in-memory overlay reader |
| `stackly-frontend/src/components/builder/PreviewPanel.vue` | "not applied yet" banner |
