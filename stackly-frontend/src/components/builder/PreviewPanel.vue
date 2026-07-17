<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ExternalLink, LoaderCircle, Monitor, RotateCw, Smartphone, X } from '@lucide/vue'
import SegmentedControl from '@/components/builder/SegmentedControl.vue'
import { usePreview } from '@/composables/usePreview'
import { useBuilderStore, type DeviceKind } from '@/stores/builder'

const builder = useBuilderStore()
const route = useRoute()
const router = useRouter()
const preview = usePreview()

const DEVICE_OPTIONS = [
  { value: 'phone', label: 'Mobile', icon: Smartphone },
  { value: 'desktop', label: 'Desktop', icon: Monitor },
]

const DEVICE_META: Record<DeviceKind, { label: string; maxWidth: string }> = {
  phone: { label: '390 px', maxWidth: 'max-w-[390px]' },
  desktop: { label: 'Desktop', maxWidth: 'max-w-full' },
}

const meta = computed(() => DEVICE_META[builder.device])

function openPreview() {
  const id = route.params.id as string
  const href = router.resolve({ name: 'preview', params: { id } }).href
  window.open(href, '_blank', 'noopener')
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div class="flex h-11 shrink-0 items-center justify-between border-b px-3">
      <SegmentedControl v-model="builder.device" :options="DEVICE_OPTIONS" />
      <div class="flex items-center gap-2">
        <span class="text-muted-foreground font-mono text-[10px]">{{ meta.label }}</span>
        <button
          type="button"
          title="Refresh preview"
          class="text-muted-foreground hover:text-foreground hover:border-border-strong flex size-6.5 cursor-pointer items-center justify-center rounded-md border transition-colors"
          @click="preview.rebuild()"
        >
          <RotateCw class="size-3.5" />
        </button>
        <button
          type="button"
          title="Open preview in new tab"
          class="text-muted-foreground hover:text-foreground hover:border-border-strong flex size-6.5 cursor-pointer items-center justify-center rounded-md border transition-colors"
          @click="openPreview"
        >
          <ExternalLink class="size-3.5" />
        </button>
      </div>
    </div>

    <div
      class="flex min-h-0 flex-1 justify-center overflow-y-auto bg-[radial-gradient(60%_40%_at_50%_0%,rgba(99,102,241,0.06),transparent_70%)] p-4"
    >
      <div
        class="shadow-card w-full self-start overflow-hidden rounded-xl border bg-white transition-[max-width] duration-300 ease-in-out"
        :class="meta.maxWidth"
      >
        <div class="flex items-center gap-1.5 border-b border-black/10 bg-[#f6f6f7] px-3 py-2">
          <span class="size-2.5 rounded-full bg-[#e06c5b]" />
          <span class="size-2.5 rounded-full bg-[#e8b53c]" />
          <span class="size-2.5 rounded-full bg-[#54b856]" />
          <div
            class="mx-auto rounded-md bg-black/5 px-6 py-0.5 font-mono text-[10px] text-black/50"
          >
            stackly.site/preview
          </div>
        </div>

        <div class="relative">
          <div
            v-if="preview.status.value === 'empty'"
            class="flex h-140 w-full items-center justify-center text-sm text-black/40"
          >
            No files to preview yet
          </div>
          <pre
            v-else-if="preview.status.value === 'error'"
            class="h-140 w-full overflow-auto bg-red-50 p-4 font-mono text-xs whitespace-pre-wrap text-red-800"
            >{{ preview.buildError.value }}</pre
          >
          <iframe
            v-else
            :key="preview.iframeKey.value"
            :srcdoc="preview.srcdoc.value"
            sandbox="allow-scripts allow-forms allow-modals"
            title="App preview"
            class="h-140 w-full"
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
  </div>
</template>
