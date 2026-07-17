<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { ArrowUp, ChevronRight, FilePlus2, FileText, Sparkles } from '@lucide/vue'
import { SUGGESTIONS } from '@/lib/builder-fixtures'
import { useBuilderStore } from '@/stores/builder'

defineProps<{ modelName: string }>()

const builder = useBuilderStore()

const draft = ref('')
const scrollEl = ref<HTMLDivElement | null>(null)
const textareaEl = ref<HTMLTextAreaElement | null>(null)
const expanded = ref<Set<string>>(new Set())

function toggleFile(key: string) {
  const next = new Set(expanded.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  expanded.value = next
}

watch(
  () => [builder.messages.length, builder.isTyping],
  async () => {
    await nextTick()
    if (scrollEl.value) scrollEl.value.scrollTop = scrollEl.value.scrollHeight
  },
)

function autoGrow() {
  const el = textareaEl.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
}

function send(text: string) {
  builder.sendMessage(text)
  draft.value = ''
  nextTick(autoGrow)
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div class="flex h-11 shrink-0 items-center justify-between border-b px-4">
      <div class="flex items-center gap-2">
        <div class="bg-primary flex size-5.5 items-center justify-center rounded-md">
          <Sparkles class="size-3 text-white" />
        </div>
        <span class="text-sm font-semibold">Assistant</span>
      </div>
      <span class="text-muted-foreground bg-muted rounded-md border px-2 py-0.5 font-mono text-xs">
        {{ modelName }}
      </span>
    </div>

    <div ref="scrollEl" class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
      <template v-for="message in builder.messages" :key="message.id">
        <div
          v-if="message.role === 'user'"
          class="bg-primary animate-in fade-in slide-in-from-bottom-1.5 max-w-[86%] self-end rounded-xl rounded-br-sm px-3 py-2 text-sm text-white duration-300"
        >
          {{ message.text }}
        </div>

        <div
          v-else-if="message.role === 'assistant'"
          class="animate-in fade-in slide-in-from-bottom-1.5 flex gap-2.5 duration-300"
        >
          <div
            class="bg-muted flex size-5.5 shrink-0 items-center justify-center rounded-md border"
          >
            <Sparkles class="text-link size-3" />
          </div>
          <p class="text-foreground/85 text-sm leading-relaxed">{{ message.text }}</p>
        </div>

        <div
          v-else-if="message.role === 'diff'"
          class="animate-in fade-in slide-in-from-bottom-1.5 bg-card ml-8 overflow-hidden rounded-lg border duration-300"
        >
          <div class="text-muted-foreground flex items-center gap-1.5 border-b px-3 py-2 text-xs">
            <FilePlus2 class="size-3.5" />
            {{ message.summary }}
          </div>
          <div v-for="file in message.files" :key="file.path" class="border-b last:border-b-0">
            <button
              type="button"
              class="hover:bg-muted/60 flex w-full items-center justify-between px-3 py-2 text-left transition-colors"
              @click="toggleFile(`${message.id}:${file.path}`)"
            >
              <div class="flex min-w-0 items-center gap-1.5">
                <ChevronRight
                  class="text-muted-foreground size-3.5 shrink-0 transition-transform"
                  :class="{ 'rotate-90': expanded.has(`${message.id}:${file.path}`) }"
                />
                <FileText class="size-3.5 shrink-0 text-sky-500" />
                <span class="truncate font-mono text-xs">{{ file.path }}</span>
              </div>
              <div class="flex shrink-0 gap-2 font-mono text-xs">
                <span class="text-green-500">+{{ file.additions }}</span>
                <span class="text-red-500">-{{ file.deletions }}</span>
              </div>
            </button>
            <div
              v-if="expanded.has(`${message.id}:${file.path}`)"
              class="bg-muted/40 overflow-x-auto border-t font-mono text-xs leading-relaxed"
            >
              <div
                v-for="(line, i) in file.lines"
                :key="i"
                class="flex whitespace-pre px-3"
                :class="{
                  'bg-green-500/10 text-green-500': line.type === 'add',
                  'bg-red-500/10 text-red-500': line.type === 'del',
                  'text-muted-foreground': line.type === 'context',
                }"
              >
                <span class="mr-2 shrink-0 select-none opacity-60">{{
                  line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '
                }}</span>
                <span>{{ line.text || ' ' }}</span>
              </div>
            </div>
          </div>
        </div>
      </template>

      <div v-if="builder.isTyping" class="flex items-center gap-2.5">
        <div class="bg-muted flex size-5.5 shrink-0 items-center justify-center rounded-md border">
          <Sparkles class="text-link size-3" />
        </div>
        <div class="flex items-center gap-1">
          <span class="animate-typing-dot bg-link size-1.5 rounded-full" />
          <span class="animate-typing-dot bg-link size-1.5 rounded-full [animation-delay:160ms]" />
          <span class="animate-typing-dot bg-link size-1.5 rounded-full [animation-delay:320ms]" />
        </div>
      </div>
    </div>

    <div class="shrink-0 border-t p-3">
      <div class="mb-2 flex flex-wrap gap-1.5">
        <button
          v-for="suggestion in SUGGESTIONS"
          :key="suggestion.label"
          type="button"
          class="text-muted-foreground bg-muted hover:border-border-strong hover:text-foreground cursor-pointer rounded-full border px-3 py-1 text-xs transition-colors"
          @click="send(suggestion.prompt)"
        >
          {{ suggestion.label }}
        </button>
      </div>
      <div
        class="bg-card focus-within:border-primary flex items-end gap-2 rounded-xl border px-3 py-2 transition-colors"
      >
        <textarea
          ref="textareaEl"
          v-model="draft"
          rows="1"
          placeholder="Ask Stackly to change the app…"
          class="placeholder:text-muted-foreground max-h-30 w-full resize-none bg-transparent text-sm outline-none"
          @input="autoGrow"
          @keydown.enter.exact.prevent="send(draft)"
        />
        <button
          type="button"
          :disabled="!draft.trim()"
          class="bg-primary flex size-7.5 shrink-0 cursor-pointer items-center justify-center rounded-lg text-white transition-opacity disabled:opacity-50"
          @click="send(draft)"
        >
          <ArrowUp class="size-4" />
          <span class="sr-only">Send</span>
        </button>
      </div>
    </div>
  </div>
</template>
