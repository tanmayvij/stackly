<script setup lang="ts">
import { ref, watch } from 'vue'
import { LoaderCircle } from '@lucide/vue'
import FileDiff from '@/components/builder/FileDiff.vue'
import { fetchBlob } from '@/lib/builder-repo'
import { useAuthStore } from '@/stores/auth'
import { useBuilderStore } from '@/stores/builder'

// Diff of one file in an uncommitted variant: the current head blob against
// the content held in memory. `modified` is empty for a delete.
const props = defineProps<{ path: string; content: string | null }>()
const emit = defineEmits<{ stats: [{ additions: number; deletions: number }] }>()

const builder = useBuilderStore()
const auth = useAuthStore()

const original = ref<string | null>(null)
const error = ref(false)

async function load() {
  const uid = auth.user?.uid
  const pid = builder.projectId
  if (!uid || !pid) return
  const hash = builder.headManifest[props.path]
  try {
    original.value = hash ? await fetchBlob(uid, pid, hash) : ''
  } catch {
    error.value = true
  }
}

watch(() => props.path, () => void load(), { immediate: true })
</script>

<template>
  <div class="h-60 border-t">
    <div v-if="error" class="text-muted-foreground p-3 text-xs">Diff unavailable.</div>
    <div v-else-if="original === null" class="flex h-full items-center justify-center">
      <LoaderCircle class="text-muted-foreground size-4 animate-spin" />
    </div>
    <FileDiff
      v-else
      :path="path"
      :original="original"
      :modified="content ?? ''"
      @stats="(s) => emit('stats', s)"
    />
  </div>
</template>
