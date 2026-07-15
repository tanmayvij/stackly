<script setup lang="ts">
withDefaults(defineProps<{ wordmark?: boolean; size?: 'default' | 'sm' }>(), {
  wordmark: false,
  size: 'default',
})
</script>

<template>
  <div class="flex items-center" :class="size === 'sm' ? 'gap-2' : 'gap-2.5'">
    <div
      class="bg-primary shadow-primary/40 flex items-center justify-center rounded-md shadow-md"
      :class="size === 'sm' ? 'size-6' : 'size-7'"
    >
      <svg :width="size === 'sm' ? 13 : 15" :height="size === 'sm' ? 13 : 15" viewBox="0 0 24 24" fill="none">
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
    <span
      v-if="wordmark"
      class="font-semibold tracking-tight"
      :class="size === 'sm' ? 'text-base' : 'text-xl'"
    >
      Stackly
    </span>
  </div>
</template>
