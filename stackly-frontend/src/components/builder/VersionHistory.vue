<script setup lang="ts">
import { ref } from 'vue'
import { History } from '@lucide/vue'
import { formatTimeAgo } from '@vueuse/core'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useBuilderStore } from '@/stores/builder'

const builder = useBuilderStore()

const confirmOpen = ref(false)
const targetN = ref<number | null>(null)
const restoring = ref(false)
const errorMessage = ref<string | null>(null)

function askRestore(n: number) {
  targetN.value = n
  errorMessage.value = null
  confirmOpen.value = true
}

async function confirmRestore() {
  if (targetN.value === null || restoring.value) return
  restoring.value = true
  errorMessage.value = null
  try {
    await builder.restoreVersion(targetN.value)
    confirmOpen.value = false
  } catch (err) {
    errorMessage.value =
      err instanceof Error && err.message ? err.message : 'Could not restore this version.'
  } finally {
    restoring.value = false
  }
}

const timeAgoMessages = {
  justNow: 'just now',
  past: '{0} ago',
  future: 'in {0}',
  invalid: '',
  second: (n: number) => `${n}s`,
  minute: (n: number) => `${n}m`,
  hour: (n: number) => `${n}h`,
  day: (n: number) => `${n}d`,
  week: (n: number) => `${n}w`,
  month: (n: number) => `${n}mo`,
  year: (n: number) => `${n}y`,
}

function formatAgo(date: Date | null): string {
  return date ? formatTimeAgo(date, { messages: timeAgoMessages, showSecond: false }) : ''
}
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
        :class="version.n === builder.headVersion && 'bg-muted/60 border'"
      >
        <span
          class="size-1.5 shrink-0 rounded-full"
          :class="
            version.n === builder.headVersion
              ? 'bg-green-500 shadow-[0_0_8px] shadow-green-500/70'
              : 'bg-muted-foreground/40'
          "
        />
        <div class="min-w-0 flex-1">
          <div class="flex items-baseline gap-1.5">
            <span class="text-muted-foreground font-mono text-[10px]">v{{ version.n }}</span>
            <span class="truncate text-xs">{{ version.title }}</span>
          </div>
          <div class="text-muted-foreground text-[10px]">{{ formatAgo(version.createdAt) }}</div>
        </div>
        <span
          v-if="version.n === builder.headVersion"
          class="shrink-0 rounded-full border border-green-500/25 bg-green-500/10 px-2 py-px text-[10px] font-medium text-green-500"
        >
          Current
        </span>
        <button
          v-else
          type="button"
          :disabled="builder.filesLocked"
          :title="builder.filesLocked ? 'Choose an option first' : undefined"
          class="text-muted-foreground hover:border-border-strong hover:text-foreground shrink-0 cursor-pointer rounded-md border px-2 py-0.5 text-[10px] transition-colors disabled:cursor-default disabled:opacity-40"
          @click="askRestore(version.n)"
        >
          Restore
        </button>
      </div>
    </div>

    <AlertDialog v-model:open="confirmOpen">
      <AlertDialogContent class="bg-card border-border-strong shadow-card rounded-xl">
        <AlertDialogHeader>
          <AlertDialogTitle>Restore version {{ targetN }}?</AlertDialogTitle>
          <AlertDialogDescription>
            This won't overwrite your history — it creates a <strong>new version</strong> at the top,
            copied from v{{ targetN }}. Your current version stays in the timeline, and any unsaved
            edits in the editor will be discarded.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <p v-if="errorMessage" role="alert" class="text-destructive text-sm">{{ errorMessage }}</p>
        <AlertDialogFooter>
          <AlertDialogCancel :disabled="restoring">Cancel</AlertDialogCancel>
          <AlertDialogAction :disabled="restoring" @click="confirmRestore">
            {{ restoring ? 'Restoring…' : `Restore v${targetN}` }}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>
