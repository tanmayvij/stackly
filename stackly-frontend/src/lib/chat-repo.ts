import {
  collection,
  limitToLast,
  onSnapshot,
  orderBy,
  query,
  type Unsubscribe,
} from 'firebase/firestore'
import { db } from '@/lib/firebase'

export type MessageStatus = 'complete' | 'interrupted' | 'error'

export interface ChatQuestion {
  text: string
  choices: string[]
}

export interface ChatSuggestion {
  label: string
  prompt: string
}

export interface ChatFileChange {
  path: string
  action: 'write' | 'delete'
}

/** One chat turn as persisted by the backend (clients are read-only). */
export interface ChatMessageDoc {
  id: string
  role: 'user' | 'assistant'
  seq: number
  content: string
  createdAt: Date | null
  files: ChatFileChange[]
  questions: ChatQuestion[]
  suggestions: ChatSuggestion[]
  versionN: number | null
  status: MessageStatus | null
}

/**
 * Live transcript for a project, ordered by seq. Compaction summary docs
 * (kind "summary") share the collection and are filtered out here.
 */
export function subscribeMessages(
  uid: string,
  projectId: string,
  onData: (messages: ChatMessageDoc[]) => void,
): Unsubscribe {
  const q = query(
    collection(db, 'users', uid, 'projects', projectId, 'messages'),
    orderBy('seq', 'asc'),
    limitToLast(200),
  )
  return onSnapshot(q, (snap) => {
    const docs: ChatMessageDoc[] = []
    for (const d of snap.docs) {
      const data = d.data()
      if ((data.kind ?? 'chat') !== 'chat') continue
      if (data.role !== 'user' && data.role !== 'assistant') continue
      docs.push({
        id: d.id,
        role: data.role,
        seq: data.seq ?? 0,
        content: data.content ?? '',
        createdAt: data.createdAt?.toDate?.() ?? null,
        files: data.files ?? [],
        questions: data.questions ?? [],
        suggestions: data.suggestions ?? [],
        versionN: data.versionN ?? null,
        status: data.status ?? null,
      })
    }
    onData(docs)
  })
}
