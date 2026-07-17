<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { LoaderCircle, Monitor, RotateCw, Smartphone, X } from '@lucide/vue'
import SegmentedControl from '@/components/builder/SegmentedControl.vue'
import { usePreview } from '@/composables/usePreview'
import { useBuilderStore, type DeviceKind } from '@/stores/builder'

const route = useRoute()
const builder = useBuilderStore()

watch(
  () => route.params.id as string,
  (id) => {
    if (id) builder.initForProject(id)
  },
  { immediate: true },
)

const preview = usePreview()

const DEVICE_OPTIONS = [
  { value: 'phone', label: 'Mobile', icon: Smartphone },
  { value: 'desktop', label: 'Desktop', icon: Monitor },
]

const DEVICE_META: Record<DeviceKind, { label: string; maxWidth: string }> = {
  phone: { label: '390 px', maxWidth: 'max-w-[390px]' },
  desktop: { label: 'Desktop', maxWidth: 'max-w-full' },
}

const device = ref<DeviceKind>('desktop')
const meta = computed(() => DEVICE_META[device.value])
</script>

<template>
  <div class="bg-background flex h-svh flex-col">
    <div class="flex h-11 shrink-0 items-center justify-center gap-2 border-b px-3">
      <SegmentedControl v-model="device" :options="DEVICE_OPTIONS" />
      <span class="text-muted-foreground font-mono text-[10px]">{{ meta.label }}</span>
      <button
        type="button"
        title="Refresh preview"
        class="text-muted-foreground hover:text-foreground hover:border-border-strong flex size-6.5 cursor-pointer items-center justify-center rounded-md border transition-colors"
        @click="preview.rebuild()"
      >
        <RotateCw class="size-3.5" />
      </button>
    </div>

    <div class="flex min-h-0 flex-1 justify-center overflow-y-auto p-4">
      <div
        class="relative w-full self-stretch overflow-hidden rounded-xl border bg-white transition-[max-width] duration-300 ease-in-out"
        :class="meta.maxWidth"
      >
        <div
          v-if="preview.status.value === 'empty'"
          class="flex h-full w-full items-center justify-center text-sm text-black/40"
        >
          No files to preview yet
        </div>
        <pre
          v-else-if="preview.status.value === 'error'"
          class="h-full w-full overflow-auto bg-red-50 p-4 font-mono text-xs whitespace-pre-wrap text-red-800"
          >{{ preview.buildError.value }}</pre
        >
        <iframe
          v-else
          :key="preview.iframeKey.value"
          :srcdoc="preview.srcdoc.value"
          sandbox="allow-scripts allow-forms allow-modals"
          title="App preview"
          class="h-full w-full border-0"
        />

        <div
          v-if="preview.status.value === 'building'"
          class="absolute inset-0 flex items-center justify-center bg-white/60"
        >
          <LoaderCircle class="size-5 animate-spin text-black/40" />
        </div>

        <div
          v-if="preview.runtimeError.value"
          class="absolute inset-x-0 bottom-0 flex items-start gap-2 border-t border-red-200 bg-red-50 px-3 py-2 font-mono text-[11px] text-red-800"
        >
          <span class="min-w-0 flex-1 break-words">{{ preview.runtimeError.value }}</span>
          <button
            type="button"
            title="Dismiss"
            class="shrink-0 cursor-pointer text-red-400 hover:text-red-700"
            @click="preview.runtimeError.value = null"
          >
            <X class="size-3.5" />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
