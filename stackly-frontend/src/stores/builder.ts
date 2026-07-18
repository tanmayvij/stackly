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
import { subscribeMessages, type ChatMessageDoc, type ChatQuestion } from '@/lib/chat-repo'
import {
  GenerationInProgressError,
  InsufficientBalanceError,
  streamChat,
  type ChatAnswer,
  type ChatRequestBody,
  type ChatStreamEvent,
} from '@/lib/chat-stream'
import type { Unsubscribe } from 'firebase/firestore'

export type BuilderTab = 'chat' | 'code'
export type DeviceKind = 'phone' | 'desktop'
export type StreamPhase = 'compacting' | 'committing' | null

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
  const streamingFiles = reactive(new Map<string, 'writing' | 'done'>())
  const phase = ref<StreamPhase>(null)
  const chatError = ref<string | null>(null)
  const insufficientBalance = ref(false)
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

  const suggestions = computed(() => {
    if (isStreaming.value || localEcho.value) return []
    const last = lastMessage.value
    return last?.role === 'assistant' && last.status === 'complete' ? last.suggestions : []
  })

  // Questions are answerable only while their message is the final turn —
  // derived from the persisted doc, so they survive a reload.
  const pendingQuestions = computed<PendingQuestions | null>(() => {
    if (isStreaming.value || localEcho.value) return null
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
      !isStreaming.value &&
      !serverBusy.value &&
      !localEcho.value &&
      lastMessage.value?.role === 'user',
  )

  // The failed/stopped assistant turn that can be retried inline.
  const retryableMessageId = computed(() => {
    if (isStreaming.value || localEcho.value) return null
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
    phase.value = null
    awaitingMessageId = null
    streamEnded = false
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
      case 'file-start':
        streamingFiles.set(event.path, 'writing')
        break
      case 'file-end':
      case 'file-delete':
        streamingFiles.set(event.path, 'done')
        break
      case 'status':
        phase.value =
          event.phase === 'compacting' || event.phase === 'committing' ? event.phase : null
        break
      case 'message':
        awaitingMessageId = event.id
        break
      case 'error':
        chatError.value = event.message
        break
      default:
        // user-message / file-delta / question / suggestion / version / done:
        // the Firestore snapshot (or versions listener) carries these.
        break
    }
  }

  async function runStream(body: ChatRequestBody) {
    if (isStreaming.value || !uid()) return
    const myRun = ++runSeq
    chatError.value = null
    insufficientBalance.value = false
    clearServerBusy()
    isStreaming.value = true
    streamingText.value = ''
    streamingFiles.clear()
    phase.value = null
    awaitingMessageId = null
    streamEnded = false
    lastRequest = body
    streamAbort = new AbortController()

    try {
      await streamChat(body, (e) => {
        if (runSeq === myRun) onStreamEvent(e)
      }, streamAbort.signal)
      if (runSeq === myRun) armOverlayClear(myRun)
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
    if (!trimmed || !pid || isStreaming.value) return
    localEcho.value = trimmed
    void runStream({ projectId: pid, message: trimmed })
  }

  function answerQuestions(answers: ChatAnswer[]) {
    const pid = projectId.value
    if (!pid || isStreaming.value || !answers.length) return
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
    if (!pid || isStreaming.value) return
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
    if (autoRunAttempted || isStreaming.value) return
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

  async function saveActiveFile() {
    const p = activeFileId.value
    const u = uid()
    if (!p || !u || !projectId.value) return
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
    if (!u || !projectId.value || !clean) return
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
    if (!u || !projectId.value || !clean) return
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
    if (!u || !projectId.value) return
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
    if (!u || !projectId.value || n === headVersion.value) return
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
    phase,
    chatError,
    insufficientBalance,
    serverBusy,
    localEcho,
    isTyping,
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
    reset,
  }
})
