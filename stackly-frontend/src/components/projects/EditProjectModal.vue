<script setup lang="ts">
import { ref, watch } from 'vue'
import { LoaderCircle } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useProjectsStore } from '@/stores/projects'
import type { Project } from '@/stores/projects'

const props = defineProps<{ project: Project | null }>()
const open = defineModel<boolean>('open', { required: true })

const projectsStore = useProjectsStore()

const name = ref('')
const description = ref('')
const processing = ref(false)
const errorMessage = ref<string | null>(null)

watch(open, (isOpen) => {
  if (isOpen && props.project) {
    name.value = props.project.name
    description.value = props.project.description
    errorMessage.value = null
  }
})

async function onSave() {
  if (!props.project || !name.value.trim() || processing.value) return
  errorMessage.value = null
  processing.value = true
  try {
    await projectsStore.updateProject(props.project.id, {
      name: name.value.trim(),
      description: description.value.trim(),
    })
    open.value = false
  } catch (err) {
    errorMessage.value =
      err instanceof Error && err.message ? err.message : 'Could not save changes. Please try again.'
  } finally {
    processing.value = false
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent
      class="bg-card border-border-strong shadow-card gap-5 rounded-xl p-6 duration-200 data-[state=open]:slide-in-from-bottom-1 sm:max-w-[520px]"
    >
      <DialogHeader>
        <DialogTitle class="text-base font-semibold tracking-tight">Edit project</DialogTitle>
        <DialogDescription class="text-left">
          Update the name and description for this project.
        </DialogDescription>
      </DialogHeader>

      <div class="flex flex-col gap-3">
        <Input v-model="name" :disabled="processing" class="bg-muted" placeholder="Project name" />
        <Textarea
          v-model="description"
          :rows="3"
          :disabled="processing"
          class="bg-muted min-h-20 resize-none"
          placeholder="Short description"
        />
      </div>

      <p v-if="errorMessage" role="alert" class="text-destructive text-sm">{{ errorMessage }}</p>

      <div class="flex items-center justify-end gap-2">
        <Button variant="outline" :disabled="processing" @click="open = false">Cancel</Button>
        <Button :disabled="!name.trim() || processing" @click="onSave">
          <LoaderCircle v-if="processing" class="size-4 animate-spin" />
          {{ processing ? 'Saving…' : 'Save changes' }}
        </Button>
      </div>
    </DialogContent>
  </Dialog>
</template>
