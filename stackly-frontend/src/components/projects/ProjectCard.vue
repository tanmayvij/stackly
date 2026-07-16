<script setup lang="ts">
import { Clock } from '@lucide/vue'
import type { Project } from '@/stores/projects'

defineProps<{ project: Project }>()
defineEmits<{ select: [] }>()
</script>

<template>
  <div
    class="bg-card hover:border-border-strong flex cursor-pointer flex-col rounded-xl border p-4 transition-all hover:-translate-y-0.5"
    @click="$emit('select')"
  >
    <div class="text-sm font-semibold">{{ project.name }}</div>
    <p class="text-muted-foreground mt-1 line-clamp-2 text-xs leading-4">
      {{ project.description }}
    </p>
    <div class="text-muted-foreground mt-4 flex items-center gap-1.5 text-xs">
      <Clock class="size-3" />
      {{ project.editedLabel }}
    </div>
  </div>
</template>
