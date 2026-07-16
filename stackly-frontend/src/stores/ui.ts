import { ref } from 'vue'
import { defineStore } from 'pinia'

// Modal state that is opened from multiple features (top bar, GHL banner,
// projects gating) — kept out of the server-backed domain stores.
export const useUiStore = defineStore('ui', () => {
  const walletModalOpen = ref(false)
  const ghlConnectModalOpen = ref(false)

  return { walletModalOpen, ghlConnectModalOpen }
})
