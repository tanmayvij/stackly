<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  Check,
  ChevronRight,
  FileText,
  LoaderCircle,
  Sparkles,
  Star,
  TriangleAlert,
} from '@lucide/vue'
import VariantDiff from '@/components/builder/VariantDiff.vue'
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
import { useBuilderStore, type PendingVariant } from '@/stores/builder'

// The chooser for a finished-but-uncommitted turn. Nothing is written until the
// user applies one option; discarding drops the changes entirely.
const builder = useBuilderStore()

const expanded = ref<Set<string>>(new Set())
const diffStats = ref<Record<string, { additions: number; deletions: number }>>({})
const confirmDiscardOpen = ref(false)

const turn = computed(() => builder.pendingTurn)
const selected = computed(() => builder.previewVariant)

const OPTION_LETTERS = 'ABCDEFGH'
const optionLabel = (v: PendingVariant) => `Option ${OPTION_LETTERS[v.rank - 1] ?? v.rank}`

interface Row {
  path: string
  action: 'write' | 'delete'
  content: string | null
}

const rows = computed<Row[]>(() => {
  const variant = selected.value
  if (!variant) return []
  return [
    ...[...variant.contents].map(
      ([path, content]): Row => ({ path, action: 'write', content }),
    ),
    ...variant.deletes.map((path): Row => ({ path, action: 'delete', content: null })),
  ]
})

const statKey = (path: string) => `${selected.value?.index}:${path}`

function toggleRow(path: string) {
  const key = statKey(path)
  const next = new Set(expanded.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  expanded.value = next
}

function onDiffStats(path: string, s: { additions: number; deletions: number }) {
  diffStats.value = { ...diffStats.value, [statKey(path)]: s }
}

function select(index: number) {
  if (builder.isApplying) return
  builder.previewVariantIndex = index
}

async function confirmDiscard() {
  await builder.discardTurn()
  confirmDiscardOpen.value = false
}
</script>

<template>
  <div v-if="turn" class="animate-in fade-in slide-in-from-bottom-1.5 flex gap-2.5 duration-300">
    <div class="bg-muted flex size-5.5 shrink-0 items-center justify-center rounded-md border">
      <Sparkles class="text-link size-3" />
    </div>
    <div class="flex min-w-0 flex-1 flex-col gap-2">
      <p v-if="turn.reply" class="text-foreground/85 text-sm leading-relaxed whitespace-pre-wrap">
        {{ turn.reply }}
      </p>

      <div class="bg-card flex flex-col gap-3 rounded-lg border p-3">
        <div class="flex flex-col gap-1">
          <p class="text-muted-foreground text-xs">
            {{
              turn.variants.length > 1
                ? 'Two ways to do this — preview each, then keep one.'
                : 'Preview the change, then keep or discard it.'
            }}
          </p>
          <div class="flex flex-wrap gap-1.5 pt-0.5">
            <button
              v-for="variant in turn.variants"
              :key="variant.index"
              type="button"
              :disabled="builder.isApplying"
              class="flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors disabled:cursor-default"
              :class="
                builder.previewVariantIndex === variant.index
                  ? 'border-primary text-foreground bg-primary/10'
                  : 'text-muted-foreground bg-muted hover:border-border-strong hover:text-foreground cursor-pointer'
              "
              @click="select(variant.index)"
            >
              <Star v-if="variant.rank === 1" class="size-3 shrink-0 fill-current text-amber-500" />
              {{ optionLabel(variant) }}
              <span v-if="variant.rank === 1" class="text-muted-foreground">· Recommended</span>
            </button>
          </div>
        </div>

        <template v-if="selected">
          <p v-if="selected.summary" class="text-sm font-medium">{{ selected.summary }}</p>

          <div class="overflow-hidden rounded-lg border">
            <div v-for="row in rows" :key="row.path" class="border-b last:border-b-0">
              <button
                type="button"
                class="hover:bg-muted/60 flex w-full cursor-pointer items-center justify-between px-3 py-2 text-left transition-colors"
                @click="toggleRow(row.path)"
              >
                <div class="flex min-w-0 items-center gap-1.5">
                  <ChevronRight
                    class="text-muted-foreground size-3.5 shrink-0 transition-transform"
                    :class="{ 'rotate-90': expanded.has(statKey(row.path)) }"
                  />
                  <FileText class="size-3.5 shrink-0 text-sky-500" />
                  <span
                    class="truncate font-mono text-xs"
                    :class="{ 'line-through opacity-60': row.action === 'delete' }"
                  >
                    {{ row.path }}
                  </span>
                </div>
                <div class="flex shrink-0 items-center gap-2 font-mono text-xs">
                  <template v-if="diffStats[statKey(row.path)]">
                    <span class="text-green-500">
                      +{{ diffStats[statKey(row.path)]!.additions }}
                    </span>
                    <span class="text-red-500">
                      -{{ diffStats[statKey(row.path)]!.deletions }}
                    </span>
                  </template>
                  <span v-else-if="row.action === 'delete'" class="text-red-500">deleted</span>
                </div>
              </button>
              <VariantDiff
                v-if="expanded.has(statKey(row.path))"
                :path="row.path"
                :content="row.content"
                @stats="(s) => onDiffStats(row.path, s)"
              />
            </div>
          </div>

          <div
            v-if="builder.variantConflict"
            class="flex items-start gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400"
          >
            <TriangleAlert class="mt-px size-3.5 shrink-0" />
            <span>{{ builder.variantConflict }}</span>
          </div>

          <div class="flex items-center gap-2">
            <button
              v-if="!builder.variantConflict"
              type="button"
              :disabled="builder.isApplying"
              class="bg-primary flex cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-white transition-opacity disabled:cursor-default disabled:opacity-50"
              @click="builder.applyVariant(selected.index)"
            >
              <LoaderCircle v-if="builder.isApplying" class="size-3 animate-spin" />
              <Check v-else class="size-3" />
              {{ builder.isApplying ? 'Applying…' : `Keep ${optionLabel(selected)}` }}
            </button>
            <button
              type="button"
              :disabled="builder.isApplying"
              class="text-muted-foreground hover:border-border-strong hover:text-foreground cursor-pointer rounded-lg border px-3 py-1.5 text-xs transition-colors disabled:cursor-default disabled:opacity-50"
              @click="confirmDiscardOpen = true"
            >
              Discard
            </button>
          </div>
        </template>
      </div>
    </div>

    <AlertDialog v-model:open="confirmDiscardOpen">
      <AlertDialogContent class="bg-card border-border-strong shadow-card rounded-xl">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {{ turn.variants.length > 1 ? 'Discard both options?' : 'Discard this option?' }}
          </AlertDialogTitle>
          <AlertDialogDescription>
            These changes are <strong>not saved anywhere</strong> — discarding loses them for good,
            and this generation has already been charged to your balance. Your message stays in the
            chat so you can run it again.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel :disabled="builder.isApplying">Keep choosing</AlertDialogCancel>
          <AlertDialogAction :disabled="builder.isApplying" @click="confirmDiscard">
            {{ builder.isApplying ? 'Discarding…' : 'Discard' }}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>
