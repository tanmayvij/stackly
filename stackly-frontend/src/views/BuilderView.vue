<script setup lang="ts">
import { computed, watch, watchEffect } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useEventListener } from '@vueuse/core'
import { LoaderCircle } from '@lucide/vue'
import BuilderTopBar from '@/components/builder/BuilderTopBar.vue'
import ChatPanel from '@/components/builder/ChatPanel.vue'
import CodePanel from '@/components/builder/CodePanel.vue'
import FileTree from '@/components/builder/FileTree.vue'
import PreviewPanel from '@/components/builder/PreviewPanel.vue'
import SegmentedControl from '@/components/builder/SegmentedControl.vue'
import VersionHistory from '@/components/builder/VersionHistory.vue'
import { MODELS } from '@/lib/models'
import { useBuilderStore } from '@/stores/builder'
import { useProjectsStore } from '@/stores/projects'

const route = useRoute()
const router = useRouter()
const builder = useBuilderStore()
const projectsStore = useProjectsStore()

const TAB_OPTIONS = [
  { value: 'chat', label: 'Chat' },
  { value: 'code', label: 'Code' },
]

const projectId = computed(() => route.params.id as string)
const project = computed(
  () => projectsStore.projects.find((p) => p.id === projectId.value) ?? null,
)
const modelName = computed(
  () =>
    MODELS.find((m) => m.id === project.value?.modelId)?.name ?? project.value?.modelId ?? '',
)

watch(projectId, (id) => builder.initForProject(id), { immediate: true })

watchEffect(() => {
  if (projectsStore.hasLoaded && !project.value) {
    router.replace({ name: 'dashboard' })
  }
})

useEventListener(window, 'keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault()
    if (builder.activeTab === 'code') builder.saveActiveFile()
  }
})
</script>

<template>
  <div class="bg-background flex h-svh flex-col overflow-hidden">
    <template v-if="project">
      <BuilderTopBar :project-name="project.name" :version-n="builder.activeVersionN" />

      <div class="flex min-h-0 flex-1">
        <aside class="bg-card flex w-61 shrink-0 flex-col border-r">
          <FileTree />
          <VersionHistory />
        </aside>

        <section class="bg-card flex min-w-0 flex-1 flex-col border-r">
          <div class="flex h-11 shrink-0 items-center border-b px-3">
            <SegmentedControl v-model="builder.activeTab" :options="TAB_OPTIONS" />
          </div>
          <ChatPanel v-show="builder.activeTab === 'chat'" :model-name="modelName" />
          <CodePanel v-show="builder.activeTab === 'code'" />
        </section>

        <aside class="w-2/5 shrink-0">
          <PreviewPanel />
        </aside>
      </div>
    </template>

    <div v-else class="flex flex-1 items-center justify-center">
      <LoaderCircle class="text-muted-foreground size-6 animate-spin" />
    </div>
  </div>
</template>
