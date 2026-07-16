import { ref } from 'vue'
import { defineStore } from 'pinia'

export interface Project {
  id: string
  name: string
  description: string
  editedLabel: string
  modelId?: string
}

// Dummy data until the projects backend exists.
const SEED: Project[] = [
  {
    id: 'lead-router',
    name: 'Lead Router',
    description: 'Routes inbound leads to the right sub-account pipeline via the GHL Contacts API.',
    editedLabel: 'Edited 2h ago',
  },
  {
    id: 'review-requester',
    name: 'Review Requester',
    description: 'Sends a review request text after an opportunity is marked won.',
    editedLabel: 'Edited yesterday',
  },
  {
    id: 'invoice-sync',
    name: 'Invoice Sync',
    description: 'Two-way sync between GHL invoices and your external ledger.',
    editedLabel: 'Edited 3d ago',
  },
]

function deriveTitle(prompt: string) {
  const words = prompt.trim().split(/\s+/).slice(0, 3).filter(Boolean)
  if (!words.length) return 'Untitled App'
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
}

export const useProjectsStore = defineStore('projects', () => {
  const projects = ref<Project[]>([...SEED])

  function createProject(prompt: string, modelId: string) {
    projects.value.unshift({
      id: crypto.randomUUID(),
      name: deriveTitle(prompt),
      description: prompt,
      editedLabel: 'Edited just now',
      modelId,
    })
  }

  return { projects, createProject }
})
