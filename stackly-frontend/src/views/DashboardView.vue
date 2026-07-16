<script setup lang="ts">
import AppLayout from '@/layouts/AppLayout.vue'
import GhlConnectionBanner from '@/components/ghl/GhlConnectionBanner.vue'
import ProjectsSection from '@/components/projects/ProjectsSection.vue'
</script>

<template>
  <AppLayout>
    <div class="mx-auto max-w-5xl">
      <GhlConnectionBanner class="mb-7" />
      <ProjectsSection />
    </div>
  </AppLayout>
</template>
