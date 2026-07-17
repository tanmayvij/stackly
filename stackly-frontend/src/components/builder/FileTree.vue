<script setup lang="ts">
import { FileText, Folder } from '@lucide/vue'
import { useBuilderStore } from '@/stores/builder'

const builder = useBuilderStore()
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div class="flex h-9 shrink-0 items-center border-b px-3">
      <span class="text-muted-foreground text-[10px] font-semibold tracking-wider uppercase">
        Files
      </span>
    </div>
    <div class="min-h-0 flex-1 overflow-y-auto p-1.5">
      <div
        v-for="row in builder.treeRows"
        :key="row.id"
        class="flex items-center gap-1.5 rounded-md py-1 pr-2 text-xs"
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
        <span class="truncate">{{ row.name }}</span>
      </div>
    </div>
  </div>
</template>
