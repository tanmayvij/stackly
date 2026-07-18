<script setup lang="ts">
import { ArrowLeft, Wallet } from '@lucide/vue'
import AppLogo from '@/components/shared/AppLogo.vue'
import ThemeToggle from '@/components/shared/ThemeToggle.vue'
import WalletModal from '@/components/wallet/WalletModal.vue'
import { Button } from '@/components/ui/button'
import { formatUSD } from '@/lib/format'
import { useGhlStore } from '@/stores/ghl'
import { useUiStore } from '@/stores/ui'
import { useWalletStore } from '@/stores/wallet'

defineProps<{ projectName: string; versionN: number }>()

const ghlStore = useGhlStore()
const ui = useUiStore()
const walletStore = useWalletStore()
</script>

<template>
  <header class="bg-card flex h-12 shrink-0 items-center justify-between border-b px-3.5">
    <div class="flex items-center gap-2.5">
      <RouterLink
        :to="{ name: 'dashboard' }"
        title="Back to projects"
        class="text-muted-foreground hover:text-foreground hover:border-border-strong flex size-7 items-center justify-center rounded-md border transition-colors"
      >
        <ArrowLeft class="size-4" />
      </RouterLink>
      <AppLogo size="sm" />
      <span class="text-sm font-semibold">{{ projectName }}</span>
      <span
        class="border-primary/30 bg-primary/15 text-link rounded-md border px-1.5 py-px font-mono text-xs"
      >
        v{{ versionN }}
      </span>
    </div>

    <div class="flex items-center gap-2.5">
      <Button
        variant="secondary"
        title="Wallet"
        class="hover:border-border-strong hover:bg-secondary h-8 rounded-full border px-3.5 font-semibold"
        @click="ui.walletModalOpen = true"
      >
        <Wallet class="text-muted-foreground" />
        <span v-if="walletStore.balance === null" class="text-muted-foreground">—</span>
        <span v-else :class="{ 'text-destructive': walletStore.isLowBalance }">
          {{ formatUSD(walletStore.balance) }}
        </span>
      </Button>

      <div class="bg-card flex h-7 items-center gap-2 rounded-full border px-3 text-xs">
        <template v-if="ghlStore.connection">
          <span class="size-1.5 rounded-full bg-green-500 shadow-[0_0_8px] shadow-green-500/70" />
          {{ ghlStore.connection.locationName }}
        </template>
        <template v-else>
          <span class="bg-muted-foreground size-1.5 rounded-full" />
          <span class="text-muted-foreground">No location</span>
        </template>
      </div>
      <ThemeToggle size="icon-sm" />
    </div>

    <WalletModal v-model:open="ui.walletModalOpen" />
  </header>
</template>
