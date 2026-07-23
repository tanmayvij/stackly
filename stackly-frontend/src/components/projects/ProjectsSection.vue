<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { ChevronLeft, ChevronRight, Plus } from '@lucide/vue'
import EditProjectModal from '@/components/projects/EditProjectModal.vue'
import NewProjectModal from '@/components/projects/NewProjectModal.vue'
import ProjectCard from '@/components/projects/ProjectCard.vue'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useGhlStore } from '@/stores/ghl'
import { useProjectsStore, type Project } from '@/stores/projects'
import { useToastStore } from '@/stores/toast'
import { useUiStore } from '@/stores/ui'
import { useWalletStore } from '@/stores/wallet'

const router = useRouter()
const ghlStore = useGhlStore()
const projectsStore = useProjectsStore()
const toast = useToastStore()
const ui = useUiStore()
const walletStore = useWalletStore()

const newProjectOpen = ref(false)
const editOpen = ref(false)
const deleteOpen = ref(false)
const activeProject = ref<Project | null>(null)
const deleting = ref(false)

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

function onCardSelect(project: Project) {
  gated(() => router.push({ name: 'builder', params: { id: project.id } }))
}

function onEdit(project: Project) {
  activeProject.value = project
  editOpen.value = true
}

function onDelete(project: Project) {
  activeProject.value = project
  deleteOpen.value = true
}

async function confirmDelete() {
  if (!activeProject.value || deleting.value) return
  const name = activeProject.value.name
  deleting.value = true
  try {
    await projectsStore.softDelete(activeProject.value.id)
    deleteOpen.value = false
    toast.success(`“${name}” was deleted.`)
  } catch {
    toast.error(`Could not delete “${name}”. Please try again.`)
  } finally {
    deleting.value = false
  }
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
        @select="onCardSelect(project)"
        @edit="onEdit(project)"
        @delete="onDelete(project)"
      />
    </div>

    <div
      v-if="projectsStore.currentPage > 0 || projectsStore.hasNextPage"
      class="mt-6 flex items-center justify-center gap-4"
    >
      <Button
        variant="outline"
        :disabled="projectsStore.currentPage === 0 || projectsStore.isLoading"
        @click="projectsStore.prevPage()"
      >
        <ChevronLeft />
        Prev
      </Button>
      <span class="text-muted-foreground text-sm">Page {{ projectsStore.currentPage + 1 }}</span>
      <Button
        variant="outline"
        :disabled="!projectsStore.hasNextPage || projectsStore.isLoading"
        @click="projectsStore.nextPage()"
      >
        Next
        <ChevronRight />
      </Button>
    </div>

    <div
      v-if="!projectsStore.projects.length"
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
    <EditProjectModal v-model:open="editOpen" :project="activeProject" />

    <AlertDialog v-model:open="deleteOpen">
      <AlertDialogContent class="bg-card border-border-strong shadow-card rounded-xl">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this project?</AlertDialogTitle>
          <AlertDialogDescription>
            “{{ activeProject?.name }}” will be removed from your dashboard and you won’t be able to open or build on it anymore.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel :disabled="deleting">Cancel</AlertDialogCancel>
          <AlertDialogAction
            class="bg-destructive text-white hover:bg-destructive/90"
            :disabled="deleting"
            @click="confirmDelete"
          >
            {{ deleting ? 'Deleting…' : 'Delete' }}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </section>
</template>
