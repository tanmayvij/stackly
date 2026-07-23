import { ref } from 'vue'
import { defineStore } from 'pinia'
import {
  collection,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  startAfter,
  updateDoc,
  where,
  type QueryDocumentSnapshot,
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
  // The creation prompt; the builder auto-sends it as the first chat turn.
  initialPrompt: string
  lastModified: Date
}

/** Projects shown per page on the dashboard. */
const PAGE_SIZE = 9

export const useProjectsStore = defineStore('projects', () => {
  const projects = ref<Project[]>([])
  const isLoading = ref(false)
  const hasLoaded = ref(false)
  
  const currentPage = ref(0)
  
  const hasNextPage = ref(false)
  let unsubscribe: Unsubscribe | null = null
  // pageCursors[i] is the `startAfter` boundary snapshot for page `i`; page 0
  // has no cursor. Filled in as the user pages forward.
  let pageCursors: (QueryDocumentSnapshot | null)[] = [null]

  function projectsCollection(uid: string) {
    return collection(db, 'users', uid, 'projects')
  }

  /**
   * Subscribes to a single page of the signed-in user's live, non-deleted
   * project list. Fetches PAGE_SIZE + 1 docs: the extra "probe" doc tells us
   * whether a next page exists without a separate count query. The query
   * re-executes server-side on every snapshot, so deleting a doc on the
   * current page auto-refills from the next available doc.
   */
  function subscribeToPage(page: number) {
    const uid = useAuthStore().user?.uid
    if (!uid) return
    unsubscribe?.()
    isLoading.value = true
    currentPage.value = page
    const cursor = pageCursors[page]
    const q = query(
      projectsCollection(uid),
      where('deleted', '==', false),
      orderBy('lastModified', 'desc'),
      ...(cursor ? [startAfter(cursor)] : []),
      limit(PAGE_SIZE + 1),
    )
    unsubscribe = onSnapshot(q, (snapshot) => {
      hasNextPage.value = snapshot.docs.length > PAGE_SIZE
      projects.value = snapshot.docs.slice(0, PAGE_SIZE).map((d) => {
        const data = d.data()
        return {
          id: d.id,
          name: data.name,
          description: data.description,
          modelId: data.modelId,
          initialPrompt: data.initialPrompt ?? '',
          lastModified: data.lastModified?.toDate?.() ?? new Date(),
        }
      })
      // Cursor for the next page is the last doc on this page (the 9th), not
      // the probe doc.
      pageCursors[page + 1] = snapshot.docs[PAGE_SIZE - 1] ?? null
      isLoading.value = false
      hasLoaded.value = true
    })
  }

  /** (Re)starts the listener at the first page. */
  function subscribe() {
    pageCursors = [null]
    currentPage.value = 0
    subscribeToPage(0)
  }

  function nextPage() {
    if (hasNextPage.value) subscribeToPage(currentPage.value + 1)
  }

  function prevPage() {
    if (currentPage.value > 0) subscribeToPage(currentPage.value - 1)
  }

  /**
   * Creates a project server-side and returns its metadata. Callers navigate
   * straight to the builder, so there is no optimistic insert into the local
   * page (which now holds only the current page's docs). On returning to the
   * dashboard, `subscribe()` re-fetches page 0 where the new project — freshly
   * `lastModified` — sorts first.
   */
  async function createProject(prompt: string, modelId: string) {
    const { data } = await createProjectFn({ prompt, modelId })
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
    pageCursors = [null]
    currentPage.value = 0
    hasNextPage.value = false
  }

  return {
    projects,
    isLoading,
    hasLoaded,
    currentPage,
    hasNextPage,
    subscribe,
    nextPage,
    prevPage,
    createProject,
    updateProject,
    softDelete,
    reset,
  }
})
