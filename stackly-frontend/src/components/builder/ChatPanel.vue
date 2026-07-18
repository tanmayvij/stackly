<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import {
  ArrowUp,
  Check,
  ChevronRight,
  FileText,
  LoaderCircle,
  RefreshCw,
  Sparkles,
  Square,
  TriangleAlert,
} from '@lucide/vue'
import ChatFileDiff from '@/components/builder/ChatFileDiff.vue'
import type { ChatMessageDoc } from '@/lib/chat-repo'
import { useBuilderStore } from '@/stores/builder'

defineProps<{ modelName: string }>()

const builder = useBuilderStore()

const draft = ref('')
const scrollEl = ref<HTMLDivElement | null>(null)
const textareaEl = ref<HTMLTextAreaElement | null>(null)
// Question-card selections: message id → chosen choice per question index.
const selections = ref<Record<string, Record<number, string>>>({})

// Expanded diff rows (`messageId:path`) + per-version diff stats, reported
// back by the mounted diff editors.
const expanded = ref<Set<string>>(new Set())
const diffStats = ref<Record<string, { additions: number; deletions: number }>>({})

const statKey = (m: ChatMessageDoc, path: string) => `${m.versionN}:${path}`

function toggleFile(message: ChatMessageDoc, path: string) {
  // Failed/interrupted turns committed nothing — there is no diff to show.
  if (message.versionN === null) return
  const key = `${message.id}:${path}`
  const next = new Set(expanded.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  expanded.value = next
}

function onDiffStats(m: ChatMessageDoc, path: string, s: { additions: number; deletions: number }) {
  diffStats.value = { ...diffStats.value, [statKey(m, path)]: s }
}

function isPending(message: ChatMessageDoc) {
  return builder.pendingQuestions?.messageId === message.id
}

function select(message: ChatMessageDoc, qi: number, choice: string) {
  if (!isPending(message)) return
  const forMessage = { ...selections.value[message.id] }
  forMessage[qi] = choice
  selections.value = { ...selections.value, [message.id]: forMessage }
}

function allAnswered(message: ChatMessageDoc) {
  const forMessage = selections.value[message.id] ?? {}
  return message.questions.every((_, qi) => !!forMessage[qi])
}

function submitAnswers(message: ChatMessageDoc) {
  if (!isPending(message) || !allAnswered(message)) return
  const forMessage = selections.value[message.id] ?? {}
  builder.answerQuestions(
    message.questions.map((q, qi) => ({ question: q.text, choice: forMessage[qi]! })),
  )
}

watch(
  () => [
    builder.messages.length,
    builder.isTyping,
    builder.isStreaming,
    builder.streamingText.length,
    builder.streamingFiles.size,
    builder.phase,
    builder.localEcho,
    builder.chatError,
  ],
  async () => {
    // Sticky scroll: only follow the stream if the user is already near the
    // bottom, so scrolling back through history doesn't fight the stream.
    const el = scrollEl.value
    const stick = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 80
    await nextTick()
    if (stick && scrollEl.value) scrollEl.value.scrollTop = scrollEl.value.scrollHeight
  },
)

function autoGrow() {
  const el = textareaEl.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
}

function send(text: string) {
  if (builder.isStreaming) return
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
          class="bg-primary animate-in fade-in slide-in-from-bottom-1.5 max-w-[86%] self-end rounded-xl rounded-br-sm px-3 py-2 text-sm whitespace-pre-wrap text-white duration-300"
        >
          {{ message.content }}
        </div>

        <div v-else class="animate-in fade-in slide-in-from-bottom-1.5 flex gap-2.5 duration-300">
          <div
            class="bg-muted flex size-5.5 shrink-0 items-center justify-center rounded-md border"
          >
            <Sparkles class="text-link size-3" />
          </div>
          <div class="flex min-w-0 flex-1 flex-col gap-2">
            <p
              v-if="message.content"
              class="text-foreground/85 text-sm leading-relaxed whitespace-pre-wrap"
            >
              {{ message.content }}
            </p>

            <div v-if="message.files.length" class="bg-card overflow-hidden rounded-lg border">
              <div v-for="file in message.files" :key="file.path" class="border-b last:border-b-0">
                <button
                  type="button"
                  class="flex w-full items-center justify-between px-3 py-2 text-left transition-colors"
                  :class="message.versionN === null ? 'cursor-default' : 'hover:bg-muted/60 cursor-pointer'"
                  @click="toggleFile(message, file.path)"
                >
                  <div class="flex min-w-0 items-center gap-1.5">
                    <ChevronRight
                      v-if="message.versionN !== null"
                      class="text-muted-foreground size-3.5 shrink-0 transition-transform"
                      :class="{ 'rotate-90': expanded.has(`${message.id}:${file.path}`) }"
                    />
                    <FileText class="size-3.5 shrink-0 text-sky-500" />
                    <span
                      class="truncate font-mono text-xs"
                      :class="{ 'line-through opacity-60': file.action === 'delete' }"
                    >
                      {{ file.path }}
                    </span>
                  </div>
                  <div class="flex shrink-0 items-center gap-2 font-mono text-xs">
                    <template v-if="diffStats[statKey(message, file.path)]">
                      <span class="text-green-500">
                        +{{ diffStats[statKey(message, file.path)]!.additions }}
                      </span>
                      <span class="text-red-500">
                        -{{ diffStats[statKey(message, file.path)]!.deletions }}
                      </span>
                    </template>
                    <span v-else-if="file.action === 'delete'" class="text-red-500">deleted</span>
                    <span v-if="message.versionN === null" class="text-muted-foreground">
                      not applied
                    </span>
                  </div>
                </button>
                <ChatFileDiff
                  v-if="message.versionN !== null && expanded.has(`${message.id}:${file.path}`)"
                  :path="file.path"
                  :version-n="message.versionN"
                  @stats="(s) => onDiffStats(message, file.path, s)"
                />
              </div>
            </div>

            <div
              v-if="message.questions.length"
              class="bg-card flex flex-col gap-3 rounded-lg border p-3"
            >
              <div
                v-for="(question, qi) in message.questions"
                :key="qi"
                class="flex flex-col gap-1.5"
              >
                <p class="text-sm font-medium">{{ question.text }}</p>
                <div class="flex flex-wrap gap-1.5">
                  <button
                    v-for="choice in question.choices"
                    :key="choice"
                    type="button"
                    class="rounded-full border px-3 py-1 text-xs transition-colors"
                    :class="
                      selections[message.id]?.[qi] === choice
                        ? 'border-primary text-foreground bg-primary/10'
                        : isPending(message)
                          ? 'text-muted-foreground bg-muted hover:border-border-strong hover:text-foreground cursor-pointer'
                          : 'text-muted-foreground bg-muted cursor-default opacity-60'
                    "
                    @click="select(message, qi, choice)"
                  >
                    {{ choice }}
                  </button>
                </div>
              </div>
              <button
                v-if="isPending(message)"
                type="button"
                :disabled="!allAnswered(message)"
                class="bg-primary self-start cursor-pointer rounded-lg px-3 py-1.5 text-xs font-medium text-white transition-opacity disabled:cursor-default disabled:opacity-50"
                @click="submitAnswers(message)"
              >
                Send answers
              </button>
            </div>

            <div v-if="message.status && message.status !== 'complete'" class="flex items-center gap-2">
              <span
                class="rounded-full border px-2 py-0.5 text-xs"
                :class="
                  message.status === 'interrupted'
                    ? 'text-muted-foreground bg-muted'
                    : 'border-red-500/40 bg-red-500/10 text-red-500'
                "
              >
                {{ message.status === 'interrupted' ? 'Stopped' : 'Failed' }}
              </span>
              <button
                v-if="builder.retryableMessageId === message.id"
                type="button"
                class="text-link flex cursor-pointer items-center gap-1 text-xs hover:underline"
                @click="builder.retryLast()"
              >
                <RefreshCw class="size-3" />
                Retry
              </button>
            </div>
          </div>
        </div>
      </template>

      <div
        v-if="builder.localEcho"
        class="bg-primary animate-in fade-in slide-in-from-bottom-1.5 max-w-[86%] self-end rounded-xl rounded-br-sm px-3 py-2 text-sm whitespace-pre-wrap text-white duration-300"
      >
        {{ builder.localEcho }}
      </div>

      <div v-if="builder.isStreaming" class="flex gap-2.5">
        <div class="bg-muted flex size-5.5 shrink-0 items-center justify-center rounded-md border">
          <Sparkles class="text-link size-3" />
        </div>
        <div class="flex min-w-0 flex-1 flex-col gap-2">
          <p
            v-if="builder.streamingText"
            class="text-foreground/85 text-sm leading-relaxed whitespace-pre-wrap"
          >
            {{ builder.streamingText }}
          </p>
          <div v-if="builder.streamingFiles.size" class="flex flex-wrap gap-1.5">
            <span
              v-for="[path, state] in builder.streamingFiles"
              :key="path"
              class="text-muted-foreground bg-muted flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-xs"
            >
              <LoaderCircle v-if="state === 'writing'" class="size-3 shrink-0 animate-spin" />
              <Check v-else class="size-3 shrink-0 text-green-500" />
              <span class="max-w-48 truncate">{{ path }}</span>
            </span>
          </div>
          <div
            v-if="builder.phase"
            class="text-muted-foreground flex items-center gap-1.5 text-xs"
          >
            <LoaderCircle class="size-3 animate-spin" />
            {{ builder.phase === 'compacting' ? 'Compacting conversation…' : 'Committing version…' }}
          </div>
          <div v-if="builder.isTyping" class="flex items-center gap-1 py-1">
            <span class="animate-typing-dot bg-link size-1.5 rounded-full" />
            <span class="animate-typing-dot bg-link size-1.5 rounded-full [animation-delay:160ms]" />
            <span class="animate-typing-dot bg-link size-1.5 rounded-full [animation-delay:320ms]" />
          </div>
        </div>
      </div>
    </div>

    <div class="shrink-0 border-t p-3">
      <div
        v-if="builder.insufficientBalance"
        class="mb-2 flex items-center justify-between gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400"
      >
        <span class="flex items-center gap-1.5">
          <TriangleAlert class="size-3.5 shrink-0" />
          Balance too low to generate. Top up, then try again.
        </span>
        <button
          type="button"
          class="shrink-0 cursor-pointer font-medium hover:underline"
          @click="builder.retryLast()"
        >
          Try again
        </button>
      </div>

      <div
        v-else-if="builder.chatError"
        class="mb-2 flex items-center justify-between gap-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-500"
      >
        <span class="flex items-center gap-1.5">
          <TriangleAlert class="size-3.5 shrink-0" />
          {{ builder.chatError }}
        </span>
        <button
          type="button"
          class="shrink-0 cursor-pointer font-medium hover:underline"
          @click="builder.chatError = null"
        >
          Dismiss
        </button>
      </div>

      <div v-else-if="builder.hasDanglingUserTurn" class="mb-2">
        <button
          type="button"
          class="text-muted-foreground bg-muted hover:border-border-strong hover:text-foreground flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors"
          @click="builder.retryLast()"
        >
          <RefreshCw class="size-3" />
          Generation was interrupted — Resume
        </button>
      </div>

      <div
        v-if="builder.suggestions.length && !builder.pendingQuestions"
        class="mb-2 flex flex-wrap gap-1.5"
      >
        <button
          v-for="suggestion in builder.suggestions"
          :key="suggestion.label"
          type="button"
          class="text-muted-foreground bg-muted hover:border-border-strong hover:text-foreground cursor-pointer rounded-full border px-3 py-1 text-xs transition-colors"
          @click="send(suggestion.prompt)"
        >
          + {{ suggestion.label }}
        </button>
      </div>
      <div
        class="bg-card focus-within:border-primary flex items-end gap-2 rounded-xl border px-3 py-2 transition-colors"
      >
        <textarea
          ref="textareaEl"
          v-model="draft"
          rows="1"
          :disabled="builder.isStreaming"
          :placeholder="builder.isStreaming ? 'Generating…' : 'Ask Stackly to change the app…'"
          class="placeholder:text-muted-foreground max-h-30 w-full resize-none bg-transparent text-sm outline-none disabled:opacity-60"
          @input="autoGrow"
          @keydown.enter.exact.prevent="send(draft)"
        />
        <button
          v-if="builder.isStreaming"
          type="button"
          class="bg-foreground text-background flex size-7.5 shrink-0 cursor-pointer items-center justify-center rounded-lg transition-opacity"
          @click="builder.cancelGeneration()"
        >
          <Square class="size-3.5 fill-current" />
          <span class="sr-only">Stop</span>
        </button>
        <button
          v-else
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
