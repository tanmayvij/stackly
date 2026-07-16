import './styles.css'

import { createApp, watch } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import { useAuthStore } from './stores/auth'
import { useWalletStore } from './stores/wallet'
import { useGhlStore } from './stores/ghl'
import { useProjectsStore } from './stores/projects'

const app = createApp(App)

app.use(createPinia())

const authStore = useAuthStore()
authStore.init()

const walletStore = useWalletStore()
const ghlStore = useGhlStore()
const projectsStore = useProjectsStore()
watch(
  () => authStore.isAuthenticated,
  (isAuthenticated) => {
    if (isAuthenticated) {
      walletStore.fetchBalance().catch(() => {})
      ghlStore.fetchConnection().catch(() => {})
      projectsStore.subscribe()
    } else {
      walletStore.reset()
      ghlStore.reset()
      projectsStore.reset()
    }
  },
  { immediate: true },
)

app.use(router)

app.mount('#app')
