import { computed, ref, watchEffect } from 'vue'

type Theme = 'light' | 'dark'

const STORAGE_KEY = 'stackly-theme'

// Module-level singleton so every consumer shares one state.
// Absence of the stored key means "follow system" (same contract as the
// no-flash inline script in index.html).
const stored = ref<Theme | null>(readStored())

const media = window.matchMedia('(prefers-color-scheme: dark)')
const systemDark = ref(media.matches)
media.addEventListener('change', (e) => {
  systemDark.value = e.matches
})

const resolvedTheme = computed<Theme>(() => stored.value ?? (systemDark.value ? 'dark' : 'light'))

watchEffect(() => {
  document.documentElement.classList.toggle('dark', resolvedTheme.value === 'dark')
})

function readStored(): Theme | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    return value === 'light' || value === 'dark' ? value : null
  } catch {
    return null
  }
}

function setTheme(theme: Theme | 'system') {
  stored.value = theme === 'system' ? null : theme
  try {
    if (stored.value === null) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, stored.value)
  } catch {
    // localStorage unavailable — theme still applies for this session
  }
}

function toggleTheme() {
  setTheme(resolvedTheme.value === 'dark' ? 'light' : 'dark')
}

export function useTheme() {
  return {
    theme: computed(() => stored.value ?? 'system'),
    resolvedTheme,
    setTheme,
    toggleTheme,
  }
}
