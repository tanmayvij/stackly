<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { VueMonacoDiffEditor } from '@guolao/vue-monaco-editor'
import type * as Monaco from 'monaco-editor'
import { LoaderCircle } from '@lucide/vue'
import { fetchBlob } from '@/lib/builder-repo'
import { languageFromPath } from '@/lib/monaco'
import { useTheme } from '@/composables/useTheme'
import { useAuthStore } from '@/stores/auth'
import { useBuilderStore } from '@/stores/builder'

// Inline diff of one file between versionN-1 and versionN, fed from the
// content-addressed blob store. Mounted only while expanded, so collapsed
// rows cost nothing.
const props = defineProps<{ path: string; versionN: number }>()
const emit = defineEmits<{ stats: [{ additions: number; deletions: number }] }>()

const builder = useBuilderStore()
const auth = useAuthStore()
const { resolvedTheme } = useTheme()

const original = ref<string | null>(null)
const modified = ref('')
const error = ref(false)

const DIFF_OPTIONS: Monaco.editor.IDiffEditorConstructionOptions = {
  readOnly: true,
  renderSideBySide: false,
  hideUnchangedRegions: { enabled: true, contextLineCount: 3 },
  diffAlgorithm: 'advanced',
  automaticLayout: true,
  minimap: { enabled: false },
  fontSize: 12,
  fontFamily: "'Geist Mono', ui-monospace, monospace",
  scrollBeyondLastLine: false,
  renderOverviewRuler: false,
  contextmenu: false,
  folding: false,
}

async function load() {
  const uid = auth.user?.uid
  const pid = builder.projectId
  const version = builder.versions.find((v) => v.n === props.versionN)
  if (!uid || !pid || !version) return
  const prev = builder.versions.find((v) => v.n === props.versionN - 1)
  const oldHash = prev?.tree[props.path] ?? null
  const newHash = version.tree[props.path] ?? null
  try {
    const [oldText, newText] = await Promise.all([
      oldHash ? fetchBlob(uid, pid, oldHash) : Promise.resolve(''),
      newHash ? fetchBlob(uid, pid, newHash) : Promise.resolve(''),
    ])
    modified.value = newText
    original.value = oldText
  } catch {
    error.value = true
  }
}

// Versions can land after deep-history messages render; retry until found.
watch(
  () => builder.versions.length,
  () => {
    if (original.value === null && !error.value) void load()
  },
  { immediate: true },
)

let disposed = false
onBeforeUnmount(() => {
  disposed = true
})

function onMount(editor: Monaco.editor.IStandaloneDiffEditor) {
  editor.onDidUpdateDiff(() => {
    if (disposed) return
    const changes = editor.getLineChanges()
    if (!changes) return // null = diff not computed (yet, or being torn down)
    let additions = 0
    let deletions = 0
    for (const c of changes) {
      if (c.modifiedEndLineNumber > 0) {
        additions += c.modifiedEndLineNumber - c.modifiedStartLineNumber + 1
      }
      if (c.originalEndLineNumber > 0) {
        deletions += c.originalEndLineNumber - c.originalStartLineNumber + 1
      }
    }
    emit('stats', { additions, deletions })
  })
}
</script>

<template>
  <div class="h-60 border-t">
    <div v-if="error" class="text-muted-foreground p-3 text-xs">Diff unavailable.</div>
    <div v-else-if="original === null" class="flex h-full items-center justify-center">
      <LoaderCircle class="text-muted-foreground size-4 animate-spin" />
    </div>
    <VueMonacoDiffEditor
      v-else
      :original="original"
      :modified="modified"
      :language="languageFromPath(path)"
      :theme="resolvedTheme === 'dark' ? 'vs-dark' : 'vs'"
      :options="DIFF_OPTIONS"
      @mount="onMount"
    />
  </div>
</template>
