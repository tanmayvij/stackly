<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { VueMonacoEditor } from '@guolao/vue-monaco-editor'
import type * as Monaco from 'monaco-editor'
import { languageFromPath } from '@/lib/monaco'
import { useTheme } from '@/composables/useTheme'
import { useBuilderStore } from '@/stores/builder'

const builder = useBuilderStore()
const { resolvedTheme } = useTheme()

// Read-only while a generated turn is awaiting the user's choice: saving is
// blocked then (it would move head under the previewed variant), so letting
// them type would only produce edits they can't keep.
const editorOptions = computed(() => ({
  automaticLayout: true,
  minimap: { enabled: false },
  fontSize: 13,
  fontFamily: "'Geist Mono', ui-monospace, monospace",
  scrollBeyondLastLine: false,
  padding: { top: 12 },
  tabSize: 2,
  readOnly: builder.filesLocked,
}))

const savedFlash = ref(false)
let flashTimer: ReturnType<typeof setTimeout> | undefined

watch(
  () => builder.lastSavedAt,
  (at) => {
    if (!at) return
    savedFlash.value = true
    clearTimeout(flashTimer)
    flashTimer = setTimeout(() => (savedFlash.value = false), 1500)
  },
)

function onMount(editor: Monaco.editor.IStandaloneCodeEditor, monaco: typeof Monaco) {
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => builder.saveActiveFile())
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div class="flex h-9 shrink-0 items-center justify-between border-b px-3">
      <span class="text-muted-foreground truncate font-mono text-xs">
        {{ builder.activeFile?.path ?? 'No file selected' }}
      </span>
      <div class="flex shrink-0 items-center gap-2 text-xs">
        <span v-if="builder.filesLocked" class="text-muted-foreground">
          Read-only while choosing an option
        </span>
        <span v-else-if="builder.isActiveFileDirty" class="size-1.5 rounded-full bg-amber-400" />
        <span v-else-if="savedFlash" class="text-muted-foreground">Saved</span>
      </div>
    </div>
    <div class="min-h-0 flex-1">
      <VueMonacoEditor
        :path="builder.activeFile?.path"
        :value="builder.activeFile?.content ?? ''"
        :language="languageFromPath(builder.activeFile?.path ?? '')"
        :theme="resolvedTheme === 'dark' ? 'vs-dark' : 'vs'"
        :options="editorOptions"
        @change="(value) => builder.updateActiveFile(value ?? '')"
        @mount="onMount"
      />
    </div>
  </div>
</template>
