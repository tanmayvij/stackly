<script setup lang="ts">
import ThemeToggle from '@/components/shared/ThemeToggle.vue'
</script>

<template>
  <div class="bg-background relative isolate flex min-h-svh items-center justify-center p-6">
    <div
      aria-hidden="true"
      class="from-primary/10 pointer-events-none absolute inset-0 -z-10 bg-radial-[60%_50%_at_50%_0%] to-transparent to-70%"
    />
    <ThemeToggle class="absolute top-4 right-4" />
    <div class="w-full max-w-sm">
      <slot />
    </div>
  </div>
</template>
