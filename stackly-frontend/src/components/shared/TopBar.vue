<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { LogOut, Wallet } from '@lucide/vue'
import AppLogo from '@/components/shared/AppLogo.vue'
import ThemeToggle from '@/components/shared/ThemeToggle.vue'
import WalletModal from '@/components/wallet/WalletModal.vue'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { formatUSD } from '@/lib/format'
import { useAuthStore } from '@/stores/auth'
import { useWalletStore } from '@/stores/wallet'

const router = useRouter()
const authStore = useAuthStore()
const walletStore = useWalletStore()

const walletOpen = ref(false)

const displayName = computed(() => authStore.user?.displayName || 'Your account')
const email = computed(() => authStore.user?.email ?? '')
const initial = computed(() =>
  (authStore.user?.displayName || authStore.user?.email || '?').trim().charAt(0).toUpperCase(),
)

async function onSignOut() {
  await authStore.signOut()
  router.push('/')
}
</script>

<template>
  <header
    class="bg-background/80 sticky top-0 z-10 flex h-14 items-center justify-between border-b px-6 backdrop-blur-sm"
  >
    <AppLogo wordmark size="sm" />

    <div class="flex items-center gap-2.5">
      <Button
        variant="secondary"
        title="Wallet"
        class="hover:border-border-strong hover:bg-secondary h-8 rounded-full border px-3.5 font-semibold"
        @click="walletOpen = true"
      >
        <Wallet class="text-muted-foreground" />
        <span v-if="walletStore.balance === null" class="text-muted-foreground">—</span>
        <span v-else :class="{ 'text-destructive': walletStore.isLowBalance }">
          {{ formatUSD(walletStore.balance) }}
        </span>
      </Button>

      <ThemeToggle size="icon-sm" />

      <Separator orientation="vertical" class="data-[orientation=vertical]:h-6" />

      <div class="text-right leading-tight">
        <p class="text-sm font-medium">{{ displayName }}</p>
        <p class="text-muted-foreground text-xs">{{ email }}</p>
      </div>
      <div
        class="bg-muted flex size-8 items-center justify-center rounded-full border text-sm font-semibold"
      >
        {{ initial }}
      </div>

      <Button variant="outline" size="icon-sm" title="Sign out" @click="onSignOut">
        <LogOut />
        <span class="sr-only">Sign out</span>
      </Button>
    </div>

    <WalletModal v-model:open="walletOpen" />
  </header>
</template>
