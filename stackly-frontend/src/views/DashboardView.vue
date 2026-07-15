<script setup lang="ts">
import { useRouter } from 'vue-router'
import { LogOut } from '@lucide/vue'
import AppLayout from '@/layouts/AppLayout.vue'
import { Button } from '@/components/ui/button'
import { useAuthStore } from '@/stores/auth'

const router = useRouter()
const authStore = useAuthStore()

async function onSignOut() {
  await authStore.signOut()
  router.push('/')
}
</script>

<template>
  <AppLayout>
    <div class="flex items-center justify-between">
      <h1 class="text-2xl font-semibold tracking-tight">Dashboard</h1>
      <!-- TODO: temporary — sign-out moves into the top bar when the dashboard shell is built -->
      <Button variant="outline" size="sm" @click="onSignOut">
        <LogOut />
        Sign out
      </Button>
    </div>
  </AppLayout>
</template>
