import './styles.css'

import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import { useAuthStore } from './stores/auth'

const app = createApp(App)

app.use(createPinia())

// Start resolving the Firebase auth state before the first navigation.
useAuthStore().init()

app.use(router)

app.mount('#app')
