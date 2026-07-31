<script setup lang="ts">
import { ref } from 'vue'
import { FilePlus, FileText, Folder, MoreHorizontal, Pencil, Trash2 } from '@lucide/vue'
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
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { useBuilderStore, type TreeRow } from '@/stores/builder'
import { useToastStore } from '@/stores/toast'

const builder = useBuilderStore()
const toast = useToastStore()

const formOpen = ref(false)
const formMode = ref<'create' | 'rename'>('create')
const formParent = ref<string | null>(null)
const formTarget = ref<TreeRow | null>(null)
const nameInput = ref('')
const processing = ref(false)
const formError = ref<string | null>(null)

const deleteOpen = ref(false)
const deleteTarget = ref<TreeRow | null>(null)
const deleting = ref(false)

function openCreate(parentPath: string | null) {
  formMode.value = 'create'
  formParent.value = parentPath
  nameInput.value = ''
  formError.value = null
  formOpen.value = true
}

function openRename(row: TreeRow) {
  formMode.value = 'rename'
  formTarget.value = row
  nameInput.value = row.name
  formError.value = null
  formOpen.value = true
}

async function submitForm() {
  const name = nameInput.value.trim()
  if (!name || processing.value) return
  processing.value = true
  formError.value = null
  try {
    if (formMode.value === 'create') {
      await builder.createFile(formParent.value, name)
    } else if (formTarget.value) {
      await builder.renameFile(formTarget.value.path, name)
    }
    formOpen.value = false
  } catch (err) {
    formError.value = err instanceof Error && err.message ? err.message : 'Something went wrong.'
  } finally {
    processing.value = false
  }
}

function openDelete(row: TreeRow) {
  deleteTarget.value = row
  deleteOpen.value = true
}

async function confirmDelete() {
  if (!deleteTarget.value || deleting.value) return
  const name = deleteTarget.value.name
  deleting.value = true
  try {
    await builder.deleteFile(deleteTarget.value.path)
    deleteOpen.value = false
    toast.success(`Deleted “${name}”.`)
  } catch {
    toast.error(`Could not delete “${name}”. Please try again.`)
  } finally {
    deleting.value = false
  }
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div class="flex h-9 shrink-0 items-center justify-between border-b px-3">
      <span class="text-muted-foreground text-[10px] font-semibold tracking-wider uppercase">
        Files
      </span>
      <button
        type="button"
        :disabled="builder.filesLocked"
        :title="builder.filesLocked ? 'Choose an option first' : 'New file'"
        class="text-muted-foreground hover:text-foreground -mr-1 cursor-pointer rounded-md p-1 transition-colors disabled:cursor-default disabled:opacity-40"
        aria-label="New file"
        @click="openCreate(null)"
      >
        <FilePlus class="size-3.5" />
      </button>
    </div>
    <div class="min-h-0 flex-1 overflow-y-auto p-1.5">
      <div
        v-for="row in builder.treeRows"
        :key="row.id"
        class="group flex items-center gap-1.5 rounded-md py-1 pr-1 text-xs"
        :style="{ paddingLeft: `${8 + row.depth * 15}px` }"
        :class="
          row.kind === 'folder'
            ? 'text-muted-foreground cursor-default'
            : row.id === builder.activeFileId
              ? 'bg-primary/15 text-foreground cursor-pointer'
              : 'text-muted-foreground hover:text-foreground hover:bg-muted cursor-pointer'
        "
        @click="row.kind === 'file' && builder.selectFile(row.id)"
      >
        <Folder v-if="row.kind === 'folder'" class="size-3.5 shrink-0" />
        <FileText v-else class="size-3.5 shrink-0 text-sky-500" />
        <span class="flex-1 truncate">{{ row.name }}</span>

        <DropdownMenu v-if="!builder.filesLocked">
          <DropdownMenuTrigger as-child @click.stop>
            <button
              type="button"
              class="text-muted-foreground hover:text-foreground shrink-0 cursor-pointer rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100 data-[state=open]:opacity-100"
              :aria-label="`${row.name} actions`"
            >
              <MoreHorizontal class="size-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            class="bg-card border-border-strong shadow-card w-40 rounded-xl p-1.5"
          >
            <DropdownMenuItem
              v-if="row.kind === 'folder'"
              class="cursor-pointer rounded-lg"
              @click.stop
              @select="openCreate(row.path)"
            >
              <FilePlus class="size-3.5" />
              New file
            </DropdownMenuItem>
            <DropdownMenuItem
              class="cursor-pointer rounded-lg"
              @click.stop
              @select="openRename(row)"
            >
              <Pencil class="size-3.5" />
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem
              class="text-destructive focus:text-destructive cursor-pointer rounded-lg"
              @click.stop
              @select="openDelete(row)"
            >
              <Trash2 class="size-3.5" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>

    <Dialog v-model:open="formOpen">
      <DialogContent
        class="bg-card border-border-strong shadow-card gap-5 rounded-xl p-6 sm:max-w-[420px]"
      >
        <DialogHeader>
          <DialogTitle class="text-base font-semibold tracking-tight">
            {{ formMode === 'create' ? 'New file' : 'Rename' }}
          </DialogTitle>
          <DialogDescription class="text-left">
            {{
              formMode === 'create'
                ? formParent
                  ? `Create a file inside ${formParent}. Use a slash to nest further.`
                  : 'Create a file at the project root. Use a slash to nest into folders.'
                : 'Enter a new name. Renaming a folder moves everything inside it.'
            }}
          </DialogDescription>
        </DialogHeader>

        <Input
          v-model="nameInput"
          :disabled="processing"
          class="bg-muted"
          placeholder="filename.ext"
          autofocus
          @keydown.enter.prevent="submitForm"
        />

        <p v-if="formError" role="alert" class="text-destructive text-sm">{{ formError }}</p>

        <div class="flex items-center justify-end gap-2">
          <Button variant="outline" :disabled="processing" @click="formOpen = false">Cancel</Button>
          <Button :disabled="!nameInput.trim() || processing" @click="submitForm">
            {{ formMode === 'create' ? 'Create' : 'Rename' }}
          </Button>
        </div>
      </DialogContent>
    </Dialog>

    <AlertDialog v-model:open="deleteOpen">
      <AlertDialogContent class="bg-card border-border-strong shadow-card rounded-xl">
        <AlertDialogHeader>
          <AlertDialogTitle>
            Delete {{ deleteTarget?.kind === 'folder' ? 'folder' : 'file' }}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            “{{ deleteTarget?.path }}”
            {{
              deleteTarget?.kind === 'folder'
                ? 'and everything inside it will be removed in a new version. Earlier versions keep the files, so you can restore them.'
                : 'will be removed in a new version. Earlier versions keep the file, so you can restore it.'
            }}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel :disabled="deleting">Cancel</AlertDialogCancel>
          <AlertDialogAction
            class="bg-destructive text-white hover:bg-destructive/90"
            :disabled="deleting"
            @click="confirmDelete"
          >
            {{ deleting ? 'Deleting…' : 'Delete' }}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>
