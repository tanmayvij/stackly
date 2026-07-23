import { ref } from 'vue'
import { defineStore } from 'pinia'

export type ToastKind = 'success' | 'error' | 'info'

export interface Toast {
  id: number
  kind: ToastKind
  message: string
}

// App-wide, ephemeral notifications for async outcomes that have no owning
// inline error surface (e.g. a failed delete fired from a dialog). Rendered
// once by <Toaster/> in App.vue.
export const useToastStore = defineStore('toast', () => {
  const toasts = ref<Toast[]>([])
  const timers = new Map<number, ReturnType<typeof setTimeout>>()
  let nextId = 0

  const DEFAULT_TTL_MS = 5000

  function dismiss(id: number) {
    const timer = timers.get(id)
    if (timer) {
      clearTimeout(timer)
      timers.delete(id)
    }
    toasts.value = toasts.value.filter((t) => t.id !== id)
  }

  function show(kind: ToastKind, message: string, ttlMs = DEFAULT_TTL_MS) {
    const id = nextId++
    toasts.value.push({ id, kind, message })
    timers.set(
      id,
      setTimeout(() => dismiss(id), ttlMs),
    )
    return id
  }

  const success = (message: string) => show('success', message)
  const error = (message: string) => show('error', message)
  const info = (message: string) => show('info', message)

  return { toasts, success, error, info, dismiss }
})
