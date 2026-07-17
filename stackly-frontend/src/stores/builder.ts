import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import { CANNED_REPLY, MESSAGE_SEED } from '@/lib/builder-fixtures'
import type { DiffFile } from '@/lib/builder-fixtures'
import { useAuthStore } from '@/stores/auth'
import {
  commitVersion,
  fetchBlob,
  sha256,
  subscribeVersions,
  uploadBlobIfAbsent,
  type Manifest,
  type Version,
} from '@/lib/builder-repo'
import type { Unsubscribe } from 'firebase/firestore'

export type BuilderTab = 'chat' | 'code'
export type DeviceKind = 'phone' | 'desktop'

export interface TreeRow {
  id: string
  name: string
  path: string
  kind: 'file' | 'folder'
  depth: number
}

export type ChatMessage =
  | { id: number; role: 'user' | 'assistant'; text: string }
  | {
    id: number
    role: 'diff'
    summary: string
    files: DiffFile[]
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

export const useBuilderStore = defineStore('builder', () => {
  const projectId = ref<string | null>(null)
  const versions = ref<Version[]>([])
  const activeFileId = ref<string | null>(null)
  const messages = ref<ChatMessage[]>([])
  const isTyping = ref(false)
  const activeTab = ref<BuilderTab>('chat')
  const device = ref<DeviceKind>('desktop')
  const lastSavedAt = ref(0)

  // Editor buffers, keyed by path — ephemeral client state, never persisted
  // as-is. `openContents` is the live buffer; `savedContents` is the head
  // version's content for that path (dirty = the two differ).
  const openContents = reactive(new Map<string, string>())
  const savedContents = reactive(new Map<string, string>())

  let nextMessageId = 1
  let pendingTimers: ReturnType<typeof setTimeout>[] = []
  let versionsUnsub: Unsubscribe | null = null

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

  function uid() {
    return useAuthStore().user?.uid ?? null
  }

  function clearTimers() {
    pendingTimers.forEach(clearTimeout)
    pendingTimers = []
  }

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
    clearTimers()
    versionsUnsub?.()

    projectId.value = id
    versions.value = []
    activeFileId.value = null
    openContents.clear()
    savedContents.clear()
    messages.value = MESSAGE_SEED.map((seed) => ({ ...structuredClone(seed), id: nextMessageId++ }))
    isTyping.value = false
    activeTab.value = 'chat'
    device.value = 'desktop'
    lastSavedAt.value = 0

    const u = uid()
    if (!u) return
    versionsUnsub = subscribeVersions(u, id, (vs) => {
      versions.value = vs
      void reconcileOpenFiles()
      if (!activeFileId.value) {
        const firstFile = treeRows.value.find((r) => r.kind === 'file')
        if (firstFile) selectFile(firstFile.id)
      }
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
    console.log("Restoring v" + n);
    console.log(target)
    if (!target) return
    await commitVersion(
      u,
      projectId.value,
      { tree: { ...target.tree }, title: `Restore v${n}`, source: 'restore' },
      headVersion.value,
    )
  }

  function sendMessage(text: string) {
    const trimmed = text.trim()
    if (!trimmed || isTyping.value) return
    messages.value.push({ id: nextMessageId++, role: 'user', text: trimmed })
    pendingTimers.push(
      setTimeout(() => {
        isTyping.value = true
      }, 240),
      setTimeout(() => {
        isTyping.value = false
        messages.value.push({ id: nextMessageId++, role: 'assistant', text: CANNED_REPLY.text })
        messages.value.push({
          id: nextMessageId++,
          role: 'diff',
          ...structuredClone(CANNED_REPLY.diff),
        })
      }, 1400),
    )
  }

  function reset() {
    clearTimers()
    versionsUnsub?.()
    versionsUnsub = null
    projectId.value = null
    versions.value = []
    activeFileId.value = null
    openContents.clear()
    savedContents.clear()
    messages.value = []
  }

  return {
    projectId,
    versions,
    activeFileId,
    messages,
    isTyping,
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
    reset,
  }
})
