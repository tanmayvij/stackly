import { getToken } from 'firebase/app-check'
import { signOut } from 'firebase/auth'
import { appCheck, auth } from '@/lib/firebase'

/**
 * Thrown on HTTP 409 — another run holds this project's generation lock.
 * Not a failure: that run's result will arrive via the messages listener.
 */
export class GenerationInProgressError extends Error {
  constructor() {
    super('A generation is already running for this project.')
    this.name = 'GenerationInProgressError'
  }
}

/** Thrown on HTTP 402 — the wallet balance is below the generation gate. */
export class InsufficientBalanceError extends Error {
  balanceCents: number

  constructor(balanceCents: number) {
    super('Balance is too low to generate.')
    this.name = 'InsufficientBalanceError'
    this.balanceCents = balanceCents
  }
}

export interface ChatAnswer {
  question: string
  choice: string
}

export interface ChatRequestBody {
  projectId: string
  message?: string
  answers?: ChatAnswer[]
}

export type ChatPhase = 'starting' | 'compacting' | 'generating'

/**
 * One alternative implementation the model produced, as announced when the
 * stream is done. `writes` carries the server's sha256 for each file so the
 * client can verify the contents it assembled from the `file-delta` frames
 * (the SSE reader skips malformed frames silently) and name the blobs it
 * uploads when the user applies this variant.
 */
export interface ChatVariantSummary {
  index: number
  rank: number
  summary: string
  writes: { path: string; hash: string }[]
  deletes: string[]
}

// File events carry the variant they belong to, and their paths are already
// normalized server-side so they match the paths in ChatVariantSummary.
export type ChatStreamEvent =
  | { type: 'user-message'; id: string; seq: number }
  | { type: 'status'; phase: ChatPhase }
  | { type: 'reply-delta'; text: string }
  | { type: 'variant-start'; variant: number; rank: number | null }
  | { type: 'variant-summary'; variant: number; text: string }
  | { type: 'variant-end'; variant: number }
  | { type: 'file-start'; variant: number; path: string }
  | { type: 'file-delta'; variant: number; path: string; text: string }
  | { type: 'file-end'; variant: number; path: string }
  | { type: 'file-delete'; variant: number; path: string }
  | { type: 'question'; text: string; choices: string[] }
  | { type: 'suggestion'; label: string; prompt: string }
  | {
      type: 'variants'
      requestId: string
      // Head at generation time, and the version title for the user turn this
      // generation answers. Both are pinned server-side because another tab can
      // advance head and append a newer user turn while the options wait.
      baseVersion: number
      title: string
      // Platform-owned files (src/lib/ghl.js) the head tree doesn't have yet.
      // Preview-only: the commit injects them server-side regardless. Without
      // them a first generation can't resolve its own `./lib/ghl` import.
      platformFiles: { path: string; hash: string }[]
      variants: ChatVariantSummary[]
    }
  | { type: 'message'; id: string; status: string }
  | { type: 'done'; ok: true }
  | { type: 'error'; code: string; message: string }

/**
 * Direct URL of an onRequest function. Streaming responses must hit the
 * function URL — a Hosting rewrite would buffer the stream to death.
 */
export function functionUrl(name: string): string {
  const project = import.meta.env.VITE_FIREBASE_PROJECT_ID
  const region = import.meta.env.VITE_FUNCTIONS_REGION
  return import.meta.env.VITE_USE_EMULATORS === 'true'
    ? `http://127.0.0.1:5001/${project}/${region}/${name}`
    : `https://${region}-${project}.cloudfunctions.net/${name}`
}

function chatEndpoint(): string {
  return import.meta.env.VITE_CHAT_FN_URL || functionUrl('chat')
}

/**
 * POSTs one chat turn and parses the SSE response, invoking `onEvent` per
 * frame. fetch-based because EventSource can neither POST nor send the
 * Authorization header. Rejects with AbortError when `signal` fires.
 */
export async function streamChat(
  body: ChatRequestBody,
  onEvent: (event: ChatStreamEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const user = auth.currentUser
  if (!user) throw new Error('Sign in to use the assistant.')
  const token = await user.getIdToken()
  const appCheckToken = await getToken(appCheck)

  const res = await fetch(chatEndpoint(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Firebase-AppCheck': appCheckToken.token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  })

  if (res.status === 402) {
    const payload = (await res.json().catch(() => ({}))) as { balanceCents?: number }
    throw new InsufficientBalanceError(payload.balanceCents ?? 0)
  }
  if (res.status === 401 || res.status === 403) {
    // Mirrors the callables convention: a dead session signs the user out.
    await signOut(auth)
    throw new Error('Your session expired. Sign in again.')
  }
  if (res.status === 409) {
    throw new GenerationInProgressError()
  }
  if (!res.ok || !res.body) {
    throw new Error(`The assistant is unavailable right now (${res.status}).`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let eventName = ''
  let dataLines: string[] = []

  const dispatch = () => {
    const name = eventName
    const data = dataLines.join('\n')
    eventName = ''
    dataLines = []
    if (!name || !data) return
    try {
      onEvent({ ...(JSON.parse(data) as object), type: name } as ChatStreamEvent)
    } catch {
      // Malformed frame — skip it rather than killing the stream.
    }
  }

  const handleLine = (raw: string) => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line === '') {
      dispatch()
      return
    }
    if (line.startsWith(':')) return // heartbeat / comment
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') eventName = value
    else if (field === 'data') dataLines.push(value)
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let nl = buffer.indexOf('\n')
    while (nl !== -1) {
      handleLine(buffer.slice(0, nl))
      buffer = buffer.slice(nl + 1)
      nl = buffer.indexOf('\n')
    }
  }
  buffer += decoder.decode()
  if (buffer) handleLine(buffer)
  dispatch()
}
