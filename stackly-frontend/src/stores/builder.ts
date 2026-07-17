import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  CANNED_REPLY,
  DEFAULT_ACTIVE_FILE_ID,
  FILE_SEED,
  MESSAGE_SEED,
  VERSION_SEED,
} from '@/lib/builder-fixtures'
import type { DiffFile } from '@/lib/builder-fixtures'

export type BuilderTab = 'chat' | 'code'
export type DeviceKind = 'phone' | 'desktop'

export interface BuilderFile {
  id: string
  name: string
  parentId: string | null
  kind: 'file' | 'folder'
  content: string
  savedContent: string
}

export interface TreeRow extends BuilderFile {
  depth: number
  path: string
}

export interface BuilderVersion {
  n: number
  message: string
  timeAgo: string
}

export type ChatMessage =
  | { id: number; role: 'user' | 'assistant'; text: string }
  | {
      id: number
      role: 'diff'
      summary: string
      files: DiffFile[]
    }

// All seeded state below is temporary until the files/versions/chat backend
// exists — components consume this store, never the fixtures directly.
export const useBuilderStore = defineStore('builder', () => {
  const projectId = ref<string | null>(null)
  const files = ref<BuilderFile[]>([])
  const activeFileId = ref<string | null>(null)
  const versions = ref<BuilderVersion[]>([])
  const activeVersionN = ref(0)
  const messages = ref<ChatMessage[]>([])
  const isTyping = ref(false)
  const activeTab = ref<BuilderTab>('chat')
  const device = ref<DeviceKind>('desktop')
  const lastSavedAt = ref(0)

  let nextMessageId = 1
  let pendingTimers: ReturnType<typeof setTimeout>[] = []

  const treeRows = computed<TreeRow[]>(() => {
    const rows: TreeRow[] = []
    const walk = (parentId: string | null, depth: number, parentPath: string) => {
      for (const file of files.value) {
        if (file.parentId !== parentId) continue
        const path = parentPath ? `${parentPath}/${file.name}` : file.name
        rows.push({ ...file, depth, path })
        if (file.kind === 'folder') walk(file.id, depth + 1, path)
      }
    }
    walk(null, 0, '')
    return rows
  })

  const activeFile = computed(
    () => treeRows.value.find((row) => row.id === activeFileId.value) ?? null,
  )

  const isActiveFileDirty = computed(() => {
    const file = files.value.find((f) => f.id === activeFileId.value)
    return !!file && file.content !== file.savedContent
  })

  function clearTimers() {
    pendingTimers.forEach(clearTimeout)
    pendingTimers = []
  }

  function initForProject(id: string) {
    if (projectId.value === id) return
    clearTimers()
    projectId.value = id
    files.value = FILE_SEED.map((seed) => ({
      ...seed,
      content: seed.content ?? '',
      savedContent: seed.content ?? '',
    }))
    activeFileId.value = DEFAULT_ACTIVE_FILE_ID
    versions.value = structuredClone(VERSION_SEED)
    activeVersionN.value = versions.value[0]?.n ?? 0
    messages.value = MESSAGE_SEED.map((seed) => ({ ...structuredClone(seed), id: nextMessageId++ }))
    isTyping.value = false
    activeTab.value = 'chat'
    device.value = 'desktop'
    lastSavedAt.value = 0
  }

  function selectFile(id: string) {
    const file = files.value.find((f) => f.id === id)
    if (!file || file.kind !== 'file') return
    activeFileId.value = id
    activeTab.value = 'code'
  }

  function updateActiveFile(content: string) {
    const file = files.value.find((f) => f.id === activeFileId.value)
    if (file) file.content = content
  }

  function saveActiveFile() {
    const file = files.value.find((f) => f.id === activeFileId.value)
    if (!file || file.content === file.savedContent) return
    file.savedContent = file.content
    lastSavedAt.value = Date.now()
  }

  function restoreVersion(n: number) {
    activeVersionN.value = n
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

  return {
    projectId,
    files,
    activeFileId,
    versions,
    activeVersionN,
    messages,
    isTyping,
    activeTab,
    device,
    lastSavedAt,
    treeRows,
    activeFile,
    isActiveFileDirty,
    initForProject,
    selectFile,
    updateActiveFile,
    saveActiveFile,
    restoreVersion,
    sendMessage,
  }
})
