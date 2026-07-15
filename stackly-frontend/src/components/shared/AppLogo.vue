<script setup lang="ts">
withDefaults(defineProps<{ wordmark?: boolean }>(), { wordmark: false })
</script>

<template>
  <div class="flex items-center gap-2.5">
    <div
      class="bg-primary shadow-primary/40 flex size-7 items-center justify-center rounded-md shadow-md"
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
        <path d="M3 7l9-4 9 4-9 4-9-4z" fill="#fff" />
        <path
          d="M3 12l9 4 9-4M3 17l9 4 9-4"
          stroke="#fff"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
          opacity=".75"
        />
      </svg>
    </div>
    <span v-if="wordmark" class="text-xl font-semibold tracking-tight">Stackly</span>
  </div>
</template>
