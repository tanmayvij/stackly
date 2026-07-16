import './styles.css'

import { createApp, watch } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import { useAuthStore } from './stores/auth'
import { useWalletStore } from './stores/wallet'
import { useGhlStore } from './stores/ghl'

const app = createApp(App)

app.use(createPinia())

const authStore = useAuthStore()
authStore.init()

const walletStore = useWalletStore()
const ghlStore = useGhlStore()
watch(
  () => authStore.isAuthenticated,
  (isAuthenticated) => {
    if (isAuthenticated) {
      walletStore.fetchBalance().catch(() => {})
      ghlStore.fetchConnection().catch(() => {})
    } else {
      walletStore.reset()
      ghlStore.reset()
    }
  },
  { immediate: true },
)

app.use(router)

app.mount('#app')
