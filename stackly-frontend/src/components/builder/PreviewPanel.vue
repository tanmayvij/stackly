<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ExternalLink, Monitor, Smartphone } from '@lucide/vue'
import SegmentedControl from '@/components/builder/SegmentedControl.vue'
import { PREVIEW_SRCDOC } from '@/lib/builder-fixtures'
import { useBuilderStore, type DeviceKind } from '@/stores/builder'

const builder = useBuilderStore()
const route = useRoute()
const router = useRouter()

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
        <iframe :srcdoc="PREVIEW_SRCDOC" sandbox="" title="App preview" class="h-140 w-full" />
      </div>
    </div>
  </div>
</template>
