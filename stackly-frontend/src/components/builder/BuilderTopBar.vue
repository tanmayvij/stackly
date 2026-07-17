<script setup lang="ts">
import { ArrowLeft } from '@lucide/vue'
import AppLogo from '@/components/shared/AppLogo.vue'
import ThemeToggle from '@/components/shared/ThemeToggle.vue'
import { useGhlStore } from '@/stores/ghl'

defineProps<{ projectName: string; versionN: number }>()

const ghlStore = useGhlStore()
</script>

<template>
  <header class="bg-card flex h-12 shrink-0 items-center justify-between border-b px-3.5">
    <div class="flex items-center gap-2.5">
      <RouterLink
        :to="{ name: 'dashboard' }"
        title="Back to projects"
        class="text-muted-foreground hover:text-foreground hover:border-border-strong flex size-7 items-center justify-center rounded-md border transition-colors"
      >
        <ArrowLeft class="size-4" />
      </RouterLink>
      <AppLogo size="sm" />
      <span class="text-sm font-semibold">{{ projectName }}</span>
      <span
        class="border-primary/30 bg-primary/15 text-link rounded-md border px-1.5 py-px font-mono text-xs"
      >
        v{{ versionN }}
      </span>
    </div>

    <div class="flex items-center gap-2.5">
      <div class="bg-card flex h-7 items-center gap-2 rounded-full border px-3 text-xs">
        <template v-if="ghlStore.connection">
          <span class="size-1.5 rounded-full bg-green-500 shadow-[0_0_8px] shadow-green-500/70" />
          {{ ghlStore.connection.locationName }}
        </template>
        <template v-else>
          <span class="bg-muted-foreground size-1.5 rounded-full" />
          <span class="text-muted-foreground">No location</span>
        </template>
      </div>
      <ThemeToggle size="icon-sm" />
    </div>
  </header>
</template>
