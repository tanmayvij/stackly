<script setup lang="ts">
import { History } from '@lucide/vue'
import { useBuilderStore } from '@/stores/builder'

const builder = useBuilderStore()
</script>

<template>
  <div class="flex h-64 shrink-0 flex-col border-t">
    <div class="flex h-9 shrink-0 items-center gap-1.5 px-3">
      <History class="text-muted-foreground size-3.5" />
      <span class="text-muted-foreground text-[10px] font-semibold tracking-wider uppercase">
        Version history
      </span>
    </div>
    <div class="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5">
      <div
        v-for="version in builder.versions"
        :key="version.n"
        class="flex items-center gap-2 rounded-md px-2 py-1.5"
        :class="version.n === builder.activeVersionN && 'bg-muted/60 border'"
      >
        <span
          class="size-1.5 shrink-0 rounded-full"
          :class="
            version.n === builder.activeVersionN
              ? 'bg-green-500 shadow-[0_0_8px] shadow-green-500/70'
              : 'bg-muted-foreground/40'
          "
        />
        <div class="min-w-0 flex-1">
          <div class="flex items-baseline gap-1.5">
            <span class="text-muted-foreground font-mono text-[10px]">v{{ version.n }}</span>
            <span class="truncate text-xs">{{ version.message }}</span>
          </div>
          <div class="text-muted-foreground text-[10px]">{{ version.timeAgo }}</div>
        </div>
        <span
          v-if="version.n === builder.activeVersionN"
          class="shrink-0 rounded-full border border-green-500/25 bg-green-500/10 px-2 py-px text-[10px] font-medium text-green-500"
        >
          Current
        </span>
        <button
          v-else
          type="button"
          class="text-muted-foreground hover:border-border-strong hover:text-foreground shrink-0 cursor-pointer rounded-md border px-2 py-0.5 text-[10px] transition-colors"
          @click="builder.restoreVersion(version.n)"
        >
          Restore
        </button>
      </div>
    </div>
  </div>
</template>
