import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

declare module 'vue-router' {
  interface RouteMeta {
    requiresAuth?: boolean
    guestOnly?: boolean
  }
}

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      name: 'auth',
      component: () => import('@/views/AuthView.vue'),
      meta: { guestOnly: true },
    },
    {
      path: '/forgot-password',
      name: 'forgot-password',
      component: () => import('@/views/ForgotPasswordView.vue'),
      meta: { guestOnly: true },
    },
    {
      path: '/verify-email',
      name: 'verify-email',
      component: () => import('@/views/VerifyEmailView.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/dashboard',
      name: 'dashboard',
      component: () => import('@/views/DashboardView.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/leadconnector/oauth',
      name: 'leadconnector-oauth',
      component: () => import('@/views/LeadConnectorOAuthView.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/projects/:id',
      name: 'builder',
      component: () => import('@/views/BuilderView.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/preview/:id',
      name: 'preview',
      component: () => import('@/views/PreviewView.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/:pathMatch(.*)*',
      name: 'not-found',
      component: () => import('@/views/NotFoundView.vue'),
    },
  ],
})

router.beforeEach(async (to) => {
  const authStore = useAuthStore()
  // Block navigation until the first onAuthStateChanged fires, so a hard
  // refresh on a protected route doesn't flicker through a wrong redirect.
  await authStore.awaitReady()

  if (to.meta.requiresAuth && !authStore.isAuthenticated) {
    return { name: 'auth', query: { redirect: to.fullPath } }
  }
  if (to.meta.guestOnly && authStore.isAuthenticated) {
    return { name: 'dashboard' }
  }
  // Gate authenticated-but-unverified users behind the verification screen.
  // Google sign-in accounts arrive with emailVerified === true, so they pass through.
  if (authStore.isAuthenticated && !authStore.isEmailVerified && to.name !== 'verify-email') {
    return { name: 'verify-email' }
  }
  if (authStore.isEmailVerified && to.name === 'verify-email') {
    return { name: 'dashboard' }
  }
})

export default router
