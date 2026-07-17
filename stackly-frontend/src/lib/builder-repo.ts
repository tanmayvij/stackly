import {
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  type Unsubscribe,
} from 'firebase/firestore'
import { getBytes, getMetadata, ref as storageRef, uploadString } from 'firebase/storage'
import { db, storage } from '@/lib/firebase'

export type VersionSource = 'manual' | 'ai' | 'restore'

/** Flat file tree: full path → blob sha256. `null` marks an (empty) folder. */
export type Manifest = Record<string, string | null>

export interface Version {
  n: number
  title: string
  source: VersionSource
  tree: Manifest
  createdAt: Date | null
}

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function blobRef(uid: string, projectId: string, hash: string) {
  return storageRef(storage, `${uid}/${projectId}/${hash}`)
}

// Blobs are immutable (name = content hash), so text is cached for the session.
const blobCache = new Map<string, string>()

export async function uploadBlobIfAbsent(
  uid: string,
  projectId: string,
  hash: string,
  content: string,
) {
  const ref = blobRef(uid, projectId, hash)
  try {
    await getMetadata(ref)
    blobCache.set(hash, content)
    return
  } catch (err) {
    if ((err as { code?: string }).code !== 'storage/object-not-found') throw err
  }
  await uploadString(ref, content)
  blobCache.set(hash, content)
}

export async function fetchBlob(uid: string, projectId: string, hash: string): Promise<string> {
  const cached = blobCache.get(hash)
  if (cached !== undefined) return cached
  const text = new TextDecoder().decode(await getBytes(blobRef(uid, projectId, hash)))
  blobCache.set(hash, text)
  return text
}

function versionsCollection(uid: string, projectId: string) {
  return collection(db, 'users', uid, 'projects', projectId, 'versions')
}

export function subscribeVersions(
  uid: string,
  projectId: string,
  onData: (versions: Version[]) => void,
): Unsubscribe {
  const q = query(versionsCollection(uid, projectId), orderBy('n', 'desc'))
  return onSnapshot(q, (snap) => {
    onData(
      snap.docs.map((d) => {
        const data = d.data()
        return {
          n: data.n,
          title: data.title,
          source: (data.source ?? 'manual') as VersionSource,
          tree: (data.tree ?? {}) as Manifest,
          createdAt: data.createdAt?.toDate?.() ?? null,
        }
      }),
    )
  })
}

/**
 * Appends a new immutable version at `headN + 1` and advances the project's
 * headVersion. If a concurrent commit already took that slot the create is
 * denied by rules (versions are create-only), so we retry at the next number.
 * Returns the version number written.
 */
export async function commitVersion(
  uid: string,
  projectId: string,
  version: { tree: Manifest; title: string; source: VersionSource },
  headN: number,
): Promise<number> {
  let n = headN + 1
  let committed = false
  for (let attempt = 0; attempt < 5 && !committed; attempt++) {
    try {
      await setDoc(doc(versionsCollection(uid, projectId), String(n)), {
        n,
        title: version.title,
        source: version.source,
        tree: version.tree,
        createdAt: serverTimestamp(),
      })
      committed = true
    } catch (err) {
      if ((err as { code?: string }).code === 'permission-denied') {
        n += 1
        continue
      }
      throw err
    }
  }
  if (!committed) throw new Error('Could not append a new version (too many concurrent writes).')

  await updateDoc(doc(db, 'users', uid, 'projects', projectId), {
    headVersion: n,
    lastModified: serverTimestamp(),
  })
  return n
}
