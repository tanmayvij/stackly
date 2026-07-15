<script setup lang="ts">
import TopBar from '@/components/shared/TopBar.vue'
</script>

<template>
  <div class="bg-background min-h-svh">
    <TopBar />
    <main class="p-6">
      <slot />
    </main>
  </div>
</template>
