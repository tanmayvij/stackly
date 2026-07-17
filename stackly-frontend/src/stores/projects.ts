import { ref } from 'vue'
import { defineStore } from 'pinia'
import {
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
  type Unsubscribe,
} from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { createProject as createProjectFn } from '@/lib/callables'
import { useAuthStore } from '@/stores/auth'

export interface Project {
  id: string
  name: string
  description: string
  modelId: string
  lastModified: Date
}

export const useProjectsStore = defineStore('projects', () => {
  const projects = ref<Project[]>([])
  const isLoading = ref(false)
  const hasLoaded = ref(false)
  let unsubscribe: Unsubscribe | null = null

  function projectsCollection(uid: string) {
    return collection(db, 'users', uid, 'projects')
  }

  /** Subscribes to the signed-in user's live, non-deleted project list. */
  function subscribe() {
    const uid = useAuthStore().user?.uid
    if (!uid) return
    unsubscribe?.()
    isLoading.value = true
    const q = query(
      projectsCollection(uid),
      where('deleted', '==', false),
      orderBy('lastModified', 'desc'),
    )
    unsubscribe = onSnapshot(q, (snapshot) => {
      projects.value = snapshot.docs.map((d) => {
        const data = d.data()
        return {
          id: d.id,
          name: data.name,
          description: data.description,
          modelId: data.modelId,
          lastModified: data.lastModified?.toDate?.() ?? new Date(),
        }
      })
      isLoading.value = false
      hasLoaded.value = true
    })
  }

  /**
   * Creates a project server-side and optimistically inserts it locally so a
   * caller can navigate straight to it without waiting on the listener to
   * catch up. The next snapshot replaces this array wholesale, so the
   * optimistic entry is superseded rather than duplicated.
   */
  async function createProject(prompt: string, modelId: string) {
    const { data } = await createProjectFn({ prompt, modelId })
    projects.value = [{ ...data, lastModified: new Date() }, ...projects.value]
    return data
  }

  async function updateProject(
    id: string,
    patch: Partial<Pick<Project, 'name' | 'description'>>,
  ) {
    const uid = useAuthStore().user?.uid
    if (!uid) return
    await updateDoc(doc(db, 'users', uid, 'projects', id), {
      ...patch,
      lastModified: serverTimestamp(),
    })
  }

  async function softDelete(id: string) {
    const uid = useAuthStore().user?.uid
    if (!uid) return
    await updateDoc(doc(db, 'users', uid, 'projects', id), {
      deleted: true,
      lastModified: serverTimestamp(),
    })
  }

  function reset() {
    unsubscribe?.()
    unsubscribe = null
    projects.value = []
    isLoading.value = false
    hasLoaded.value = false
  }

  return {
    projects,
    isLoading,
    hasLoaded,
    subscribe,
    createProject,
    updateProject,
    softDelete,
    reset,
  }
})
