import { ref } from 'vue'
import { defineStore } from 'pinia'

export const useWalletStore = defineStore('wallet', () => {
  // Balance is always integer cents. Mock seed until the wallet backend exists.
  const balance = ref(2450)

  function topUp(amountCents: number) {
    balance.value += Math.round(amountCents)
  }

  return { balance, topUp }
})
