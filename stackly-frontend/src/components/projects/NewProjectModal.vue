<script setup lang="ts">
import { ref, watch } from 'vue'
import { Sparkles } from '@lucide/vue'
import ModelSelect from '@/components/projects/ModelSelect.vue'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { DEFAULT_MODEL_ID } from '@/lib/models'
import { useProjectsStore } from '@/stores/projects'

const open = defineModel<boolean>('open', { required: true })

const projectsStore = useProjectsStore()

const EXAMPLES = [
  {
    label: 'Contact tagging bot',
    prompt:
      'A bot that auto-tags new contacts based on which form they submitted, using the GHL Contacts API.',
  },
  {
    label: 'Appointment reminder app',
    prompt:
      'An app that texts appointment reminders 24h before, reading calendar events from the GHL Calendars API.',
  },
]

const prompt = ref('')
const modelId = ref(DEFAULT_MODEL_ID)

watch(open, (isOpen) => {
  if (!isOpen) prompt.value = ''
})

function onCreate() {
  if (!prompt.value.trim()) return
  projectsStore.createProject(prompt.value.trim(), modelId.value)
  open.value = false
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent
      class="bg-card border-border-strong shadow-card gap-5 rounded-xl p-6 duration-200 data-[state=open]:slide-in-from-bottom-1 sm:max-w-[520px]"
    >
      <DialogHeader>
        <DialogTitle class="text-base font-semibold tracking-tight">Create a new app</DialogTitle>
        <DialogDescription class="text-left">
          Describe what you want to build. Stackly will scaffold it against the GHL APIs.
        </DialogDescription>
      </DialogHeader>

      <div class="flex flex-col gap-3">
        <Textarea
          v-model="prompt"
          :rows="4"
          class="bg-muted min-h-24 resize-none"
          placeholder="e.g. A dashboard that shows opportunity value by pipeline stage, pulling from the GHL Opportunities API…"
        />
        <div class="flex flex-wrap gap-2">
          <button
            v-for="example in EXAMPLES"
            :key="example.label"
            type="button"
            class="text-muted-foreground bg-muted hover:border-border-strong hover:text-foreground cursor-pointer rounded-full border px-3 py-1 text-xs transition-colors"
            @click="prompt = example.prompt"
          >
            {{ example.label }}
          </button>
        </div>
      </div>

      <div class="flex items-center justify-between gap-3">
        <ModelSelect v-model="modelId" />
        <div class="flex items-center gap-2">
          <Button variant="outline" @click="open = false">Cancel</Button>
          <Button :disabled="!prompt.trim()" @click="onCreate">
            <Sparkles />
            Create app
          </Button>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>
