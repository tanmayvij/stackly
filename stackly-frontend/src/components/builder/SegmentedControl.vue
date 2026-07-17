<script setup lang="ts">
import type { Component } from 'vue'

export interface SegmentOption {
  value: string
  label?: string
  icon?: Component
}

defineProps<{ options: SegmentOption[] }>()

const model = defineModel<string>({ required: true })
</script>

<template>
  <div class="bg-card flex items-center gap-0.5 rounded-lg border p-0.75">
    <button
      v-for="option in options"
      :key="option.value"
      type="button"
      :title="option.label"
      class="flex h-6.5 cursor-pointer items-center justify-center rounded-md text-xs font-medium transition-colors"
      :class="[
        option.icon && !option.label ? 'w-7' : 'px-3',
        model === option.value
          ? 'bg-primary text-white'
          : 'text-muted-foreground hover:text-foreground',
      ]"
      @click="model = option.value"
    >
      <component :is="option.icon" v-if="option.icon" class="size-3.5" />
      <template v-else>{{ option.label }}</template>
    </button>
  </div>
</template>
