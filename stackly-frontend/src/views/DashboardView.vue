<script setup lang="ts">
import AppLayout from '@/layouts/AppLayout.vue'
import GhlConnectionBanner from '@/components/ghl/GhlConnectionBanner.vue'
</script>

<template>
  <AppLayout>
    <div class="mx-auto max-w-5xl">
      <GhlConnectionBanner class="mb-7" />
      <h1 class="text-2xl font-semibold tracking-tight">Dashboard</h1>
    </div>
  </AppLayout>
</template>
