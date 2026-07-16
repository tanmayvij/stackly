<script setup lang="ts">
import { ref } from 'vue'
import { Plus } from '@lucide/vue'
import NewProjectModal from '@/components/projects/NewProjectModal.vue'
import ProjectCard from '@/components/projects/ProjectCard.vue'
import { Button } from '@/components/ui/button'
import { useGhlStore } from '@/stores/ghl'
import { useProjectsStore } from '@/stores/projects'
import { useUiStore } from '@/stores/ui'
import { useWalletStore } from '@/stores/wallet'

const ghlStore = useGhlStore()
const projectsStore = useProjectsStore()
const ui = useUiStore()
const walletStore = useWalletStore()

const newProjectOpen = ref(false)

// Gate order: low balance → recharge; not connected → GHL connect; else act.
function gated(action: () => void) {
  if (walletStore.isLowBalance) {
    ui.walletModalOpen = true
    return
  }
  if (!ghlStore.isConnected) {
    ui.ghlConnectModalOpen = true
    return
  }
  action()
}

function onNewProject() {
  gated(() => (newProjectOpen.value = true))
}

function onCardSelect() {
  gated(() => null)
}
</script>

<template>
  <section>
    <div class="mb-5 flex items-end justify-between">
      <div>
        <h1 class="text-2xl font-semibold tracking-tight">Projects</h1>
        <p class="text-muted-foreground mt-1 text-sm">Your GHL marketplace apps</p>
      </div>
      <Button @click="onNewProject">
        <Plus />
        New project
      </Button>
    </div>

    <div v-if="projectsStore.projects.length" class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <ProjectCard
        v-for="project in projectsStore.projects"
        :key="project.id"
        :project="project"
        @select="onCardSelect"
      />
    </div>

    <div
      v-else
      class="border-border-strong flex flex-col items-center gap-3 rounded-xl border border-dashed py-14 text-center"
    >
      <div class="bg-muted flex size-11 items-center justify-center rounded-lg border">
        <Plus class="text-muted-foreground size-5" />
      </div>
      <div>
        <div class="text-sm font-semibold">No projects yet</div>
        <p class="text-muted-foreground mt-1 text-xs">
          Describe an app in plain language and Stackly will scaffold it.
        </p>
      </div>
      <Button class="mt-1" @click="onNewProject">Create your first project</Button>
    </div>

    <NewProjectModal v-model:open="newProjectOpen" />
  </section>
</template>
