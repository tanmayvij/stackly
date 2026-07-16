import { ref } from 'vue'
import { defineStore } from 'pinia'
import { getCurrentBalance } from '@/lib/callables'

export const useWalletStore = defineStore('wallet', () => {
  // Balance is always integer cents and is NEVER computed on the client —
  // it is fetched from the server (sum of the user's ledger). `null` means
  // "not yet loaded".
  const balance = ref<number | null>(null)
  const isLoading = ref(false)

  /**
   * Fetches the authoritative balance from the server. This is the only way
   * `balance` is ever set — including after a successful recharge.
   */
  async function fetchBalance() {
    isLoading.value = true
    try {
      const { data } = await getCurrentBalance()
      balance.value = data.balanceCents
    } finally {
      isLoading.value = false
    }
  }

  function reset() {
    balance.value = null
    isLoading.value = false
  }

  return { balance, isLoading, fetchBalance, reset }
})
