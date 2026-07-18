import { signOut } from 'firebase/auth'
import { auth } from '@/lib/firebase'

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

export type ChatPhase = 'starting' | 'compacting' | 'generating' | 'committing'

export type ChatStreamEvent =
  | { type: 'user-message'; id: string; seq: number }
  | { type: 'status'; phase: ChatPhase }
  | { type: 'reply-delta'; text: string }
  | { type: 'file-start'; path: string }
  | { type: 'file-delta'; path: string; text: string }
  | { type: 'file-end'; path: string }
  | { type: 'file-delete'; path: string }
  | { type: 'question'; text: string; choices: string[] }
  | { type: 'suggestion'; label: string; prompt: string }
  | { type: 'version'; n: number; title: string }
  | { type: 'message'; id: string; status: string }
  | { type: 'done'; ok: true }
  | { type: 'error'; code: string; message: string }

/**
 * Direct URL of an onRequest function. Streaming responses must hit the
 * function URL — a Hosting rewrite would buffer the stream to death.
 */
export function functionUrl(name: string): string {
  const project = import.meta.env.VITE_FIREBASE_PROJECT_ID
  return import.meta.env.VITE_USE_EMULATORS === 'true'
    ? `http://127.0.0.1:5001/${project}/us-central1/${name}`
    : `https://us-central1-${project}.cloudfunctions.net/${name}`
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

  const res = await fetch(chatEndpoint(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
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
