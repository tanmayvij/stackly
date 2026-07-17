<script setup lang="ts">
import { computed, ref } from 'vue'
import { Monitor, Smartphone } from '@lucide/vue'
import SegmentedControl from '@/components/builder/SegmentedControl.vue'
import { PREVIEW_SRCDOC } from '@/lib/builder-fixtures'
import type { DeviceKind } from '@/stores/builder'

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
    </div>

    <div class="flex min-h-0 flex-1 justify-center overflow-y-auto p-4">
      <div
        class="w-full self-stretch overflow-hidden rounded-xl border bg-white transition-[max-width] duration-300 ease-in-out"
        :class="meta.maxWidth"
      >
        <iframe :srcdoc="PREVIEW_SRCDOC" sandbox="" title="App preview" class="h-full w-full border-0" />
      </div>
    </div>
  </div>
</template>
