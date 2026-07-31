import { computed, reactive, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'
import { useUiStore } from '@/stores/ui'
import { useWalletStore } from '@/stores/wallet'
import {
  commitVersion,
  fetchBlob,
  sha256,
  subscribeVersions,
  uploadBlobIfAbsent,
  type Manifest,
  type Version,
} from '@/lib/builder-repo'
import {
  subscribeMessages,
  type ChatMessageDoc,
  type ChatQuestion,
  type ChatSuggestion,
} from '@/lib/chat-repo'
import { applyVariant as applyVariantCall, discardVariants } from '@/lib/callables'
import {
  GenerationInProgressError,
  InsufficientBalanceError,
  streamChat,
  type ChatAnswer,
  type ChatRequestBody,
  type ChatStreamEvent,
  type ChatVariantSummary,
} from '@/lib/chat-stream'
import type { Unsubscribe } from 'firebase/firestore'

export type BuilderTab = 'chat' | 'code'
export type DeviceKind = 'phone' | 'desktop'
export type StreamPhase = 'compacting' | null

/** One alternative the model produced, held in memory until the user chooses. */
export interface PendingVariant {
  index: number
  rank: number
  summary: string
  /** path → full file content, assembled from the stream. */
  contents: Map<string, string>
  /** path → server sha256, used to name the blob on apply. */
  hashes: Map<string, string>
  deletes: string[]
}

/**
 * A finished generation whose changes are NOT committed yet. Deliberately
 * client-only and session-scoped: the file contents live here and nowhere
 * else until the user applies one variant, at which point the blobs are
 * uploaded and the server commits the version plus the assistant message.
 * A reload therefore drops the turn, leaving the user message resumable.
 */
export interface PendingTurn {
  projectId: string
  requestId: string
  reply: string
  /** Version title and head, both pinned when the generation finished. */
  title: string
  baseVersion: number
  /**
   * Platform-owned files head doesn't have yet (src/lib/ghl.js). Preview-only:
   * the commit injects them server-side. Needed because a generated app imports
   * `./lib/ghl`, and a project's first generation has no copy of it at head.
   */
  platformFiles: { path: string; hash: string }[]
  questions: ChatQuestion[]
  suggestions: ChatSuggestion[]
  variants: PendingVariant[]
}

export interface StreamingFile {
  variant: number
  path: string
  state: 'writing' | 'done'
}

export interface TreeRow {
  id: string
  name: string
  path: string
  kind: 'file' | 'folder'
  depth: number
}

export interface PendingQuestions {
  messageId: string
  questions: ChatQuestion[]
}

interface TreeNode {
  name: string
  path: string
  kind: 'file' | 'folder'
  children: Map<string, TreeNode>
}

// Flattens a manifest into render-ordered rows: folders before files at each
// level, alphabetical within a kind. Folders are synthesized from path prefixes.
function manifestToRows(manifest: Manifest): TreeRow[] {
  const root: TreeNode = { name: '', path: '', kind: 'folder', children: new Map() }
  for (const [path, hash] of Object.entries(manifest)) {
    const parts = path.split('/')
    let node = root
    parts.forEach((name, i) => {
      const isLast = i === parts.length - 1
      let child = node.children.get(name)
      if (!child) {
        child = {
          name,
          path: parts.slice(0, i + 1).join('/'),
          kind: isLast && hash !== null ? 'file' : 'folder',
          children: new Map(),
        }
        node.children.set(name, child)
      }
      node = child
    })
  }

  const rows: TreeRow[] = []
  const walk = (node: TreeNode, depth: number) => {
    const kids = [...node.children.values()].sort((a, b) =>
      a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'folder' ? -1 : 1,
    )
    for (const kid of kids) {
      rows.push({ id: kid.path, name: kid.name, path: kid.path, kind: kid.kind, depth })
      if (kid.kind === 'folder') walk(kid, depth + 1)
    }
  }
  walk(root, 0)
  return rows
}

const basename = (path: string) => path.split('/').pop() ?? path

// Must mirror the backend's renderAnswers() so the optimistic echo bubble is
// recognized as the persisted user doc when it arrives.
function renderAnswers(answers: ChatAnswer[]): string {
  return answers.map((a) => `Q: ${a.question}\nA: ${a.choice}`).join('\n\n')
}

export const useBuilderStore = defineStore('builder', () => {
  const projectId = ref<string | null>(null)
  const versions = ref<Version[]>([])
  const versionsLoaded = ref(false)
  const activeFileId = ref<string | null>(null)
  const activeTab = ref<BuilderTab>('chat')
  const device = ref<DeviceKind>('desktop')
  const lastSavedAt = ref(0)

  // Chat: Firestore is the single source of truth for finished turns; the
  // streaming refs below are a render-only overlay for the turn in flight.
  const messages = ref<ChatMessageDoc[]>([])
  const messagesLoaded = ref(false)
  const isStreaming = ref(false)
  const streamingText = ref('')
  // Keyed `${variant}:${path}`; cleared when the model moves to the next
  // variant, so the chips always show the option currently being written.
  const streamingFiles = reactive(new Map<string, StreamingFile>())
  const streamingVariantRank = ref<number | null>(null)
  const streamingVariantSummary = ref('')
  const phase = ref<StreamPhase>(null)
  const chatError = ref<string | null>(null)
  const insufficientBalance = ref(false)

  // The finished-but-uncommitted turn awaiting the user's choice, and which of
  // its variants is currently being previewed.
  const pendingTurn = ref<PendingTurn | null>(null)
  const previewVariantIndex = ref<number | null>(null)
  const isApplying = ref(false)
  // Set when a file this turn rewrites has already been changed by another tab
  // or session. Terminal: head only moves forward, so applying can never
  // succeed after this and only Discard is left.
  const variantConflict = ref<string | null>(null)
  // Another run (zombie after a dropped connection, or a second tab) holds
  // the server-side generation lock — its result arrives via the messages
  // listener, so this is informational, not an error.
  const serverBusy = ref(false)
  const localEcho = ref<string | null>(null)

  // Editor buffers, keyed by path — ephemeral client state, never persisted
  // as-is. `openContents` is the live buffer; `savedContents` is the head
  // version's content for that path (dirty = the two differ).
  const openContents = reactive(new Map<string, string>())
  const savedContents = reactive(new Map<string, string>())

  let versionsUnsub: Unsubscribe | null = null
  let messagesUnsub: Unsubscribe | null = null
  let streamAbort: AbortController | null = null
  let lastRequest: ChatRequestBody | null = null
  let autoRunAttempted = false
  // Per-run stream scratch for the variants: file content chunks keyed
  // `${variant}:${path}`, and the `variants` frame that ends the stream
  // (resolved once it closes, since verifying the assembled contents against
  // the server hashes is async). Ranks and summaries come from that frame,
  // which is authoritative — the per-variant tags are only a live hint.
  let variantChunks = new Map<string, string[]>()
  let streamQuestions: ChatQuestion[] = []
  let streamSuggestions: ChatSuggestion[] = []
  let variantsAnnounced: ChatVariantSummary[] | null = null
  let announcedRequestId: string | null = null
  let announcedBaseVersion = 0
  let announcedTitle = ''
  let announcedPlatformFiles: { path: string; hash: string }[] = []
  // Set once apply/discard succeeds, cleared when the resulting message doc
  // lands, so the turn never blinks out of the transcript in between.
  let awaitingResolution = false
  let resolveTimer: ReturnType<typeof setTimeout> | null = null
  // Assistant doc id announced by the stream; the overlay clears when the
  // doc arrives via the snapshot (or the fallback timer below fires).
  let awaitingMessageId: string | null = null
  let streamEnded = false
  let overlayTimer: ReturnType<typeof setTimeout> | null = null
  let busyTimer: ReturnType<typeof setTimeout> | null = null
  // Guards state mutations from a stale stream after a project switch.
  let runSeq = 0

  // If the lock holder crashed and never writes a result, fall back to the
  // Resume affordance after this long (the stale lock is stealable by then).
  const SERVER_BUSY_FALLBACK_MS = 90_000

  const headVersion = computed(() => versions.value[0]?.n ?? 0)
  const headManifest = computed<Manifest>(() => versions.value[0]?.tree ?? {})
  const treeRows = computed<TreeRow[]>(() => manifestToRows(headManifest.value))

  const previewVariant = computed<PendingVariant | null>(() => {
    const turn = pendingTurn.value
    if (!turn || previewVariantIndex.value === null) return null
    return turn.variants.find((v) => v.index === previewVariantIndex.value) ?? null
  })

  // What the preview renders: head, or head with a pending variant applied on
  // top. Deleted paths are removed rather than nulled — a null key would come
  // back as an empty folder.
  const previewManifest = computed<Manifest>(() => {
    const variant = previewVariant.value
    if (!variant) return headManifest.value
    const manifest: Manifest = { ...headManifest.value }
    for (const path of variant.deletes) delete manifest[path]
    for (const [path, hash] of variant.hashes) manifest[path] = hash
    // Last, so they win: the commit forces these too, and a variant is never
    // allowed to write one (PROTECTED_PATHS).
    for (const file of pendingTurn.value?.platformFiles ?? []) {
      manifest[file.path] = file.hash
    }
    return manifest
  })

  // Content for the previewed variant's files, which have no blob in Storage
  // until the variant is applied.
  const previewContents = computed<Map<string, string>>(
    () => previewVariant.value?.contents ?? new Map(),
  )

  const activeFile = computed(() => {
    const row = treeRows.value.find((r) => r.id === activeFileId.value)
    if (!row) return null
    return { ...row, content: openContents.get(row.path) ?? '' }
  })

  const isActiveFileDirty = computed(() => {
    const p = activeFileId.value
    return !!p && openContents.has(p) && openContents.get(p) !== savedContents.get(p)
  })

  // The head version is always the current one; restore appends a new head.
  const activeVersionN = computed(() => headVersion.value)

  const lastMessage = computed(() => messages.value[messages.value.length - 1] ?? null)

  // Streaming but nothing rendered yet — drives the typing indicator.
  const isTyping = computed(
    () =>
      isStreaming.value && !streamingText.value && streamingFiles.size === 0 && !phase.value,
  )

  // A pending turn blocks every other chat affordance: the turn isn't over
  // until the user applies or discards one of its variants.
  const isBusy = computed(() => isStreaming.value || !!pendingTurn.value || isApplying.value)

  const suggestions = computed(() => {
    if (isBusy.value || localEcho.value) return []
    const last = lastMessage.value
    return last?.role === 'assistant' && last.status === 'complete' ? last.suggestions : []
  })

  // Questions are answerable only while their message is the final turn —
  // derived from the persisted doc, so they survive a reload.
  const pendingQuestions = computed<PendingQuestions | null>(() => {
    if (isBusy.value || localEcho.value) return null
    const last = lastMessage.value
    if (last?.role === 'assistant' && last.status === 'complete' && last.questions.length) {
      return { messageId: last.id, questions: last.questions }
    }
    return null
  })

  // A user turn with no reply (reload mid-generation, early failure).
  const hasDanglingUserTurn = computed(
    () =>
      messagesLoaded.value &&
      !isBusy.value &&
      !serverBusy.value &&
      !localEcho.value &&
      lastMessage.value?.role === 'user',
  )

  // The failed/stopped assistant turn that can be retried inline.
  const retryableMessageId = computed(() => {
    if (isBusy.value || localEcho.value) return null
    const last = lastMessage.value
    if (last?.role === 'assistant' && (last.status === 'error' || last.status === 'interrupted')) {
      return last.id
    }
    return null
  })

  const initialPrompt = computed(() => {
    const pid = projectId.value
    if (!pid) return null
    const project = useProjectsStore().projects.find((p) => p.id === pid)
    return project?.initialPrompt?.trim() || null
  })

  function uid() {
    return useAuthStore().user?.uid ?? null
  }

  function clearOverlay() {
    if (overlayTimer) clearTimeout(overlayTimer)
    overlayTimer = null
    isStreaming.value = false
    streamingText.value = ''
    streamingFiles.clear()
    streamingVariantRank.value = null
    streamingVariantSummary.value = ''
    phase.value = null
    awaitingMessageId = null
    streamEnded = false
  }

  function resetVariantScratch() {
    variantChunks = new Map()
    streamQuestions = []
    streamSuggestions = []
    variantsAnnounced = null
    announcedRequestId = null
    announcedBaseVersion = 0
    announcedTitle = ''
    announcedPlatformFiles = []
  }

  function clearPendingTurn() {
    if (resolveTimer) clearTimeout(resolveTimer)
    resolveTimer = null
    awaitingResolution = false
    pendingTurn.value = null
    previewVariantIndex.value = null
    isApplying.value = false
    variantConflict.value = null
  }

  // Holds the chooser on screen (disabled) between a successful apply/discard
  // and the resulting message doc arriving, so the turn never blinks out of the
  // transcript. Mirrors armOverlayClear's handoff for the stream overlay.
  function armPendingClear(myRun: number) {
    awaitingResolution = true
    if (lastMessage.value?.role === 'assistant') {
      clearPendingTurn()
      return
    }
    resolveTimer = setTimeout(() => {
      if (runSeq === myRun) clearPendingTurn()
    }, 5000)
  }

  function clearServerBusy() {
    if (busyTimer) clearTimeout(busyTimer)
    busyTimer = null
    serverBusy.value = false
  }

  // Keeps the finished overlay on screen just until its Firestore doc lands,
  // so the reply never flickers away and reappears.
  function armOverlayClear(myRun: number) {
    streamEnded = true
    if (awaitingMessageId && messages.value.some((m) => m.id === awaitingMessageId)) {
      clearOverlay()
      return
    }
    overlayTimer = setTimeout(() => {
      if (runSeq === myRun) clearOverlay()
    }, 5000)
  }

  function reconcileStream(msgs: ChatMessageDoc[]) {
    if (localEcho.value && msgs.some((m) => m.role === 'user' && m.content === localEcho.value)) {
      localEcho.value = null
    }
    // The lock-holding run finished and delivered its turn.
    if (serverBusy.value && msgs[msgs.length - 1]?.role === 'assistant') {
      clearServerBusy()
    }
    // The applied (or discarded) turn's message doc landed.
    if (awaitingResolution && msgs[msgs.length - 1]?.role === 'assistant') {
      clearPendingTurn()
    }
    if (!isStreaming.value) return
    if (awaitingMessageId) {
      if (msgs.some((m) => m.id === awaitingMessageId)) clearOverlay()
    } else if (streamEnded && msgs[msgs.length - 1]?.role === 'assistant') {
      clearOverlay()
    }
  }

  function onStreamEvent(event: ChatStreamEvent) {
    switch (event.type) {
      case 'reply-delta':
        streamingText.value += event.text
        break
      case 'variant-start':
        // Show only the option being written; the earlier one's chips have
        // served their purpose and repeating every file per variant is noise.
        streamingFiles.clear()
        streamingVariantRank.value = event.rank
        streamingVariantSummary.value = ''
        break
      case 'variant-summary':
        streamingVariantSummary.value = event.text
        break
      case 'file-start':
        variantChunks.set(`${event.variant}:${event.path}`, [])
        streamingFiles.set(`${event.variant}:${event.path}`, {
          variant: event.variant,
          path: event.path,
          state: 'writing',
        })
        break
      case 'file-delta':
        // Kept, unlike before: these deltas ARE the variant file contents, and
        // nothing else has them until one variant is applied.
        variantChunks.get(`${event.variant}:${event.path}`)?.push(event.text)
        break
      case 'file-end':
        streamingFiles.set(`${event.variant}:${event.path}`, {
          variant: event.variant,
          path: event.path,
          state: 'done',
        })
        break
      case 'file-delete':
        streamingFiles.set(`${event.variant}:${event.path}`, {
          variant: event.variant,
          path: event.path,
          state: 'done',
        })
        break
      case 'question':
        streamQuestions.push({ text: event.text, choices: event.choices })
        break
      case 'suggestion':
        streamSuggestions.push({ label: event.label, prompt: event.prompt })
        break
      case 'variants':
        // Resolved once the stream closes: verifying the assembled contents
        // against these hashes is async.
        variantsAnnounced = event.variants
        announcedRequestId = event.requestId
        announcedBaseVersion = event.baseVersion
        announcedTitle = event.title
        announcedPlatformFiles = event.platformFiles ?? []
        break
      case 'status':
        phase.value = event.phase === 'compacting' ? 'compacting' : null
        break
      case 'message':
        awaitingMessageId = event.id
        break
      case 'error':
        chatError.value = event.message
        break
      default:
        // user-message / variant-end / done: the Firestore snapshot (or the
        // `variants` frame) carries what matters.
        break
    }
  }

  /**
   * Turns the announced variants into a pending turn, verifying that what the
   * stream delivered hashes to what the server produced. The SSE reader skips
   * malformed frames silently, so an unverified variant would mean committing
   * truncated code.
   */
  async function buildPendingTurn(): Promise<PendingTurn | null> {
    const pid = projectId.value
    if (!variantsAnnounced || !announcedRequestId || !pid) return null
    const variants: PendingVariant[] = []
    for (const announced of variantsAnnounced) {
      const contents = new Map<string, string>()
      const hashes = new Map<string, string>()
      let intact = true
      for (const { path, hash } of announced.writes) {
        const text = (variantChunks.get(`${announced.index}:${path}`) ?? []).join('')
        if ((await sha256(text)) !== hash) {
          intact = false
          break
        }
        contents.set(path, text)
        hashes.set(path, hash)
      }
      if (!intact) continue
      variants.push({
        index: announced.index,
        rank: announced.rank,
        summary: announced.summary,
        contents,
        hashes,
        deletes: announced.deletes,
      })
    }
    if (!variants.length) return null
    return {
      projectId: pid,
      requestId: announcedRequestId,
      reply: streamingText.value,
      title: announcedTitle,
      baseVersion: announcedBaseVersion,
      platformFiles: announcedPlatformFiles,
      questions: streamQuestions,
      suggestions: streamSuggestions,
      // Re-ranked from 1: dropping a variant that failed verification would
      // otherwise leave a gap, and the option letters come off the rank.
      variants: variants
        .sort((a, b) => a.rank - b.rank)
        .map((v, i) => ({ ...v, rank: i + 1 })),
    }
  }

  async function finalizePendingTurn(myRun: number) {
    const turn = await buildPendingTurn()
    if (runSeq !== myRun) return
    if (!turn) {
      chatError.value = 'The generated files arrived incomplete. Try again.'
      clearOverlay()
      return
    }
    pendingTurn.value = turn
    previewVariantIndex.value = turn.variants[0]?.index ?? null
    // The reply now lives on the pending turn, so the overlay can go.
    clearOverlay()
  }

  /** The conversational half of the turn, echoed back on apply/discard. */
  function turnPayload(turn: PendingTurn) {
    return {
      projectId: turn.projectId,
      requestId: turn.requestId,
      reply: turn.reply,
      summary: '',
      title: turn.title,
      baseVersion: turn.baseVersion,
      questions: turn.questions,
      suggestions: turn.suggestions,
    }
  }

  /**
   * Commits one variant: uploads only that variant's blobs, then hands the
   * hash delta to the server, which rebases it onto the current head and
   * writes the version + assistant message in one transaction.
   */
  async function applyVariant(index: number) {
    const turn = pendingTurn.value
    const u = uid()
    if (!turn || !u || isApplying.value) return
    if (turn.projectId !== projectId.value) return
    const variant = turn.variants.find((v) => v.index === index)
    if (!variant || variantConflict.value) return
    const myRun = runSeq
    isApplying.value = true
    chatError.value = null
    try {
      await Promise.all(
        [...variant.contents].map(([path, content]) =>
          uploadBlobIfAbsent(u, turn.projectId, variant.hashes.get(path)!, content),
        ),
      )
      await applyVariantCall({
        ...turnPayload(turn),
        summary: variant.summary,
        writes: [...variant.hashes].map(([path, hash]) => ({ path, hash })),
        deletes: variant.deletes,
      })
      if (runSeq === myRun) armPendingClear(myRun)
    } catch (err) {
      if (runSeq === myRun) {
        const message = err instanceof Error ? err.message : 'Could not apply the changes.'
        if ((err as { code?: string }).code === 'functions/aborted') {
          variantConflict.value = message
        } else {
          chatError.value = message
        }
        isApplying.value = false
      }
    } finally {
      if (runSeq === myRun) void useWalletStore().fetchBalance()
    }
  }

  /**
   * Drops both variants. The turn is still recorded server-side as stopped so
   * it stays reconciled with the wallet debit the generation already took, and
   * so the message can be retried from the existing affordance.
   */
  async function discardTurn() {
    const turn = pendingTurn.value
    if (!turn || isApplying.value) return
    if (turn.projectId !== projectId.value) return
    const myRun = runSeq
    isApplying.value = true
    chatError.value = null
    try {
      await discardVariants(turnPayload(turn))
      if (runSeq === myRun) armPendingClear(myRun)
    } catch (err) {
      if (runSeq === myRun) {
        chatError.value = err instanceof Error ? err.message : 'Could not discard the changes.'
        isApplying.value = false
      }
    }
  }

  async function runStream(body: ChatRequestBody) {
    if (isBusy.value || !uid()) return
    const myRun = ++runSeq
    chatError.value = null
    insufficientBalance.value = false
    clearServerBusy()
    clearPendingTurn()
    resetVariantScratch()
    isStreaming.value = true
    streamingText.value = ''
    streamingFiles.clear()
    streamingVariantRank.value = null
    phase.value = null
    awaitingMessageId = null
    streamEnded = false
    lastRequest = body
    streamAbort = new AbortController()

    try {
      await streamChat(body, (e) => {
        if (runSeq === myRun) onStreamEvent(e)
      }, streamAbort.signal)
      if (runSeq !== myRun) return
      // A turn that produced variants ends in the chooser, not in Firestore;
      // anything else (questions, refusal, error) already has its message doc.
      if (variantsAnnounced) await finalizePendingTurn(myRun)
      else armOverlayClear(myRun)
    } catch (err) {
      if (runSeq !== myRun) return
      if ((err as DOMException)?.name === 'AbortError') {
        // User cancel: the backend persists the interrupted turn; keep the
        // partial overlay until that doc arrives.
        armOverlayClear(myRun)
      } else if (err instanceof GenerationInProgressError) {
        // 409: a previous run (dropped connection / other tab) still owns
        // the turn. Don't re-run it — its result lands via onSnapshot.
        localEcho.value = null // nothing was persisted for this attempt
        clearOverlay()
        serverBusy.value = true
        if (busyTimer) clearTimeout(busyTimer)
        busyTimer = setTimeout(() => {
          if (runSeq === myRun) serverBusy.value = false
        }, SERVER_BUSY_FALLBACK_MS)
      } else if (err instanceof InsufficientBalanceError) {
        insufficientBalance.value = true
        localEcho.value = null // nothing was persisted — retry re-sends it
        clearOverlay()
        useUiStore().walletModalOpen = true
      } else {
        chatError.value = err instanceof Error ? err.message : 'Something went wrong.'
        clearOverlay()
      }
    } finally {
      if (runSeq === myRun) {
        streamAbort = null
        void useWalletStore().fetchBalance()
      }
    }
  }

  function sendMessage(text: string) {
    const trimmed = text.trim()
    const pid = projectId.value
    if (!trimmed || !pid || isBusy.value) return
    localEcho.value = trimmed
    void runStream({ projectId: pid, message: trimmed })
  }

  function answerQuestions(answers: ChatAnswer[]) {
    const pid = projectId.value
    if (!pid || isBusy.value || !answers.length) return
    localEcho.value = renderAnswers(answers)
    void runStream({ projectId: pid, answers })
  }

  function cancelGeneration() {
    streamAbort?.abort()
  }

  /**
   * Retries the pending turn: after a 402 the original body is re-sent
   * (nothing was persisted); otherwise an empty-body request makes the
   * backend regenerate from the stored history.
   */
  function retryLast() {
    const pid = projectId.value
    if (!pid || isBusy.value) return
    chatError.value = null
    if (insufficientBalance.value && lastRequest) {
      insufficientBalance.value = false
      if (lastRequest.message) localEcho.value = lastRequest.message
      else if (lastRequest.answers) localEcho.value = renderAnswers(lastRequest.answers)
      void runStream(lastRequest)
      return
    }
    void runStream({ projectId: pid })
  }

  // First run only: a brand-new project (no versions, no messages) auto-sends
  // its creation prompt through the exact same path as any other message.
  function maybeAutoRun() {
    if (autoRunAttempted || isBusy.value) return
    if (!versionsLoaded.value || !messagesLoaded.value) return
    if (headVersion.value !== 0 || messages.value.length > 0) return
    const pid = projectId.value
    const prompt = initialPrompt.value
    if (!pid || !prompt) return
    autoRunAttempted = true
    localEcho.value = prompt
    void runStream({ projectId: pid, message: prompt })
  }

  watch([versionsLoaded, messagesLoaded, initialPrompt], () => maybeAutoRun())

  async function ensureLoaded(path: string) {
    if (openContents.has(path)) return
    const u = uid()
    if (!u || !projectId.value) return
    const hash = headManifest.value[path]
    const text = hash ? await fetchBlob(u, projectId.value, hash) : ''
    if (!openContents.has(path)) {
      openContents.set(path, text)
      savedContents.set(path, text)
    }
  }

  // Keeps open buffers in step with a new head: unchanged files follow the new
  // content live; files with unsaved edits keep the buffer but track the new
  // baseline for the dirty check.
  async function reconcileOpenFiles() {
    const u = uid()
    const pid = projectId.value
    if (!u || !pid) return
    const manifest = headManifest.value
    for (const path of openContents.keys()) {
      const hash = manifest[path]
      if (!hash) continue
      const headText = await fetchBlob(u, pid, hash)
      const wasClean = openContents.get(path) === savedContents.get(path)
      savedContents.set(path, headText)
      if (wasClean) openContents.set(path, headText)
    }
  }

  function initForProject(id: string) {
    if (projectId.value === id) return
    // Kill any in-flight stream before swapping ids so a stale event can
    // never touch the new project's state (runSeq guards the rest).
    streamAbort?.abort()
    runSeq++
    versionsUnsub?.()
    messagesUnsub?.()

    projectId.value = id
    versions.value = []
    versionsLoaded.value = false
    messages.value = []
    messagesLoaded.value = false
    activeFileId.value = null
    openContents.clear()
    savedContents.clear()
    clearOverlay()
    clearServerBusy()
    clearPendingTurn()
    resetVariantScratch()
    chatError.value = null
    insufficientBalance.value = false
    localEcho.value = null
    lastRequest = null
    autoRunAttempted = false
    activeTab.value = 'chat'
    device.value = 'desktop'
    lastSavedAt.value = 0

    const u = uid()
    if (!u) return
    versionsUnsub = subscribeVersions(u, id, (vs) => {
      versions.value = vs
      versionsLoaded.value = true
      void reconcileOpenFiles()
      // Preselect the first file without selectFile(): that would switch to
      // the code tab, yanking the user out of the chat when a generated
      // version lands.
      if (!activeFileId.value) {
        const firstFile = treeRows.value.find((r) => r.kind === 'file')
        if (firstFile) {
          activeFileId.value = firstFile.id
          void ensureLoaded(firstFile.id)
        }
      }
      maybeAutoRun()
    })
    messagesUnsub = subscribeMessages(u, id, (msgs) => {
      messages.value = msgs
      messagesLoaded.value = true
      reconcileStream(msgs)
      maybeAutoRun()
    })
  }

  function selectFile(id: string) {
    const row = treeRows.value.find((r) => r.id === id)
    if (!row || row.kind !== 'file') return
    activeFileId.value = id
    activeTab.value = 'code'
    void ensureLoaded(id)
  }

  function updateActiveFile(content: string) {
    if (activeFileId.value) openContents.set(activeFileId.value, content)
  }

  // Every commit path below is blocked while a turn is pending: advancing head
  // would leave the previewed variant showing stale code, and the applied
  // variant is rebased onto whatever head is at that moment.
  const filesLocked = computed(() => !!pendingTurn.value || isApplying.value)

  async function saveActiveFile() {
    const p = activeFileId.value
    const u = uid()
    if (!p || !u || !projectId.value || filesLocked.value) return
    const buffer = openContents.get(p) ?? ''
    if (buffer === savedContents.get(p)) return
    const hash = await sha256(buffer)
    await uploadBlobIfAbsent(u, projectId.value, hash, buffer)
    const tree = { ...headManifest.value, [p]: hash }
    await commitVersion(
      u,
      projectId.value,
      { tree, title: `Update ${basename(p)}`, source: 'manual' },
      headVersion.value,
    )
    savedContents.set(p, buffer)
    lastSavedAt.value = Date.now()
  }

  async function createFile(parentPath: string | null, name: string) {
    const u = uid()
    const clean = name.trim()
    if (!u || !projectId.value || !clean || filesLocked.value) return
    const path = parentPath ? `${parentPath}/${clean}` : clean
    if (path in headManifest.value) throw new Error('A file with that name already exists.')
    const hash = await sha256('')
    await uploadBlobIfAbsent(u, projectId.value, hash, '')
    const tree = { ...headManifest.value, [path]: hash }
    await commitVersion(
      u,
      projectId.value,
      { tree, title: `Create ${clean}`, source: 'manual' },
      headVersion.value,
    )
    openContents.set(path, '')
    savedContents.set(path, '')
    activeFileId.value = path
    activeTab.value = 'code'
  }

  async function renameFile(path: string, newName: string) {
    const u = uid()
    const clean = newName.trim()
    if (!u || !projectId.value || !clean || filesLocked.value) return
    const parent = path.split('/').slice(0, -1).join('/')
    const newPath = parent ? `${parent}/${clean}` : clean
    if (newPath === path) return
    const manifest = headManifest.value
    if (newPath in manifest) throw new Error('A file with that name already exists.')

    const remap = (k: string) =>
      k === path ? newPath : k.startsWith(`${path}/`) ? newPath + k.slice(path.length) : k
    const tree: Manifest = {}
    for (const [k, v] of Object.entries(manifest)) tree[remap(k)] = v

    await commitVersion(
      u,
      projectId.value,
      { tree, title: `Rename ${basename(path)} → ${clean}`, source: 'manual' },
      headVersion.value,
    )

    for (const map of [openContents, savedContents]) {
      for (const k of Array.from(map.keys())) {
        const nk = remap(k)
        if (nk !== k) {
          map.set(nk, map.get(k)!)
          map.delete(k)
        }
      }
    }
    if (activeFileId.value) activeFileId.value = remap(activeFileId.value)
  }

  async function deleteFile(path: string) {
    const u = uid()
    if (!u || !projectId.value || filesLocked.value) return
    const manifest = headManifest.value
    const tree: Manifest = {}
    for (const [k, v] of Object.entries(manifest)) {
      if (k === path || k.startsWith(`${path}/`)) continue
      tree[k] = v
    }
    await commitVersion(
      u,
      projectId.value,
      { tree, title: `Delete ${basename(path)}`, source: 'manual' },
      headVersion.value,
    )

    for (const map of [openContents, savedContents]) {
      for (const k of Array.from(map.keys())) {
        if (k === path || k.startsWith(`${path}/`)) map.delete(k)
      }
    }
    if (activeFileId.value === path || activeFileId.value?.startsWith(`${path}/`)) {
      activeFileId.value = null
    }
  }

  async function restoreVersion(n: number) {
    const u = uid()
    if (!u || !projectId.value || n === headVersion.value || filesLocked.value) return
    const target = versions.value.find((v) => v.n === n)
    if (!target) return
    await commitVersion(
      u,
      projectId.value,
      { tree: { ...target.tree }, title: `Restore v${n}`, source: 'restore' },
      headVersion.value,
    )
  }

  function reset() {
    streamAbort?.abort()
    runSeq++
    versionsUnsub?.()
    versionsUnsub = null
    messagesUnsub?.()
    messagesUnsub = null
    projectId.value = null
    versions.value = []
    versionsLoaded.value = false
    messages.value = []
    messagesLoaded.value = false
    activeFileId.value = null
    openContents.clear()
    savedContents.clear()
    clearOverlay()
    clearServerBusy()
    clearPendingTurn()
    resetVariantScratch()
    chatError.value = null
    insufficientBalance.value = false
    localEcho.value = null
    lastRequest = null
    autoRunAttempted = false
  }

  return {
    projectId,
    versions,
    activeFileId,
    messages,
    messagesLoaded,
    isStreaming,
    streamingText,
    streamingFiles,
    streamingVariantRank,
    streamingVariantSummary,
    phase,
    chatError,
    insufficientBalance,
    serverBusy,
    localEcho,
    isTyping,
    isBusy,
    pendingTurn,
    previewVariantIndex,
    previewVariant,
    previewManifest,
    previewContents,
    isApplying,
    variantConflict,
    filesLocked,
    suggestions,
    pendingQuestions,
    hasDanglingUserTurn,
    retryableMessageId,
    activeTab,
    device,
    lastSavedAt,
    headVersion,
    headManifest,
    treeRows,
    activeFile,
    isActiveFileDirty,
    activeVersionN,
    initForProject,
    selectFile,
    updateActiveFile,
    saveActiveFile,
    createFile,
    renameFile,
    deleteFile,
    restoreVersion,
    sendMessage,
    answerQuestions,
    cancelGeneration,
    retryLast,
    applyVariant,
    discardTurn,
    reset,
  }
})
