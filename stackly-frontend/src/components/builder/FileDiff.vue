<script setup lang="ts">
import { onBeforeUnmount } from 'vue'
import { VueMonacoDiffEditor } from '@guolao/vue-monaco-editor'
import type * as Monaco from 'monaco-editor'
import { languageFromPath } from '@/lib/monaco'
import { useTheme } from '@/composables/useTheme'

// Inline read-only diff of two revisions of one file. Content-agnostic: the
// caller resolves it, whether from committed blobs (ChatFileDiff) or from a
// variant that only exists in memory (VariantChooser).
const props = defineProps<{ path: string; original: string; modified: string }>()
const emit = defineEmits<{ stats: [{ additions: number; deletions: number }] }>()

const { resolvedTheme } = useTheme()

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
  <VueMonacoDiffEditor
    :original="props.original"
    :modified="props.modified"
    :language="languageFromPath(props.path)"
    :theme="resolvedTheme === 'dark' ? 'vs-dark' : 'vs'"
    :options="DIFF_OPTIONS"
    @mount="onMount"
  />
</template>
