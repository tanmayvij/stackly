<script setup lang="ts">
import { useTimeAgo } from '@vueuse/core'
import { Clock, MoreHorizontal, Pencil, Trash2 } from '@lucide/vue'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { Project } from '@/stores/projects'

const props = defineProps<{ project: Project }>()
defineEmits<{ select: []; edit: []; delete: [] }>()

const editedAgo = useTimeAgo(() => props.project.lastModified)
</script>

<template>
  <div
    class="bg-card hover:border-border-strong group relative flex cursor-pointer flex-col rounded-xl border p-4 transition-all hover:-translate-y-0.5"
    @click="$emit('select')"
  >
    <div class="flex items-start justify-between gap-2">
      <div class="text-sm font-semibold">{{ project.name }}</div>
      <DropdownMenu>
        <DropdownMenuTrigger as-child @click.stop>
          <button
            type="button"
            class="text-muted-foreground hover:text-foreground -mt-1 -mr-1 shrink-0 cursor-pointer rounded-md p-1 opacity-0 transition-opacity group-hover:opacity-100 data-[state=open]:opacity-100"
            aria-label="Project actions"
          >
            <MoreHorizontal class="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          class="bg-card border-border-strong shadow-card w-40 rounded-xl p-1.5"
        >
          <DropdownMenuItem class="cursor-pointer rounded-lg" @click.stop @select="$emit('edit')">
            <Pencil class="size-3.5" />
            Edit
          </DropdownMenuItem>
          <DropdownMenuItem
            class="text-destructive focus:text-destructive cursor-pointer rounded-lg"
            @click.stop
            @select="$emit('delete')"
          >
            <Trash2 class="size-3.5" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
    <p class="text-muted-foreground mt-1 line-clamp-2 text-xs leading-4">
      {{ project.description }}
    </p>
    <div class="text-muted-foreground mt-4 flex items-center gap-1.5 text-xs">
      <Clock class="size-3" />
      Edited {{ editedAgo }}
    </div>
  </div>
</template>
