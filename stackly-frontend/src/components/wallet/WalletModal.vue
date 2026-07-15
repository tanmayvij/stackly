<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { CreditCard, Lock, Wallet } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { formatUSD } from '@/lib/format'
import { useWalletStore } from '@/stores/wallet'

const open = defineModel<boolean>('open', { required: true })

const walletStore = useWalletStore()

// Chip values and the custom input are in whole dollars; the store works in cents.
const AMOUNTS = [10, 25, 50, 100]
const MAX_AMOUNT_CENTS = 100_000

const rechargeAmount = ref(25)
const customAmount = ref('')

watch(customAmount, (value) => {
  const digits = value.replace(/\D/g, '')
  if (digits !== value) customAmount.value = digits
})

const effectiveCents = computed(
  () => (customAmount.value ? Number(customAmount.value) : rechargeAmount.value) * 100,
)

const exceedsMax = computed(() => effectiveCents.value > MAX_AMOUNT_CENTS)

function isSelected(amount: number) {
  return !customAmount.value && rechargeAmount.value === amount
}

function selectChip(amount: number) {
  rechargeAmount.value = amount
  customAmount.value = ''
}

function onPay() {
  walletStore.topUp(effectiveCents.value)
  open.value = false
  rechargeAmount.value = 25
  customAmount.value = ''
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent
      class="bg-card border-border-strong shadow-card gap-5 rounded-xl p-6 duration-200 data-[state=open]:slide-in-from-bottom-1 sm:max-w-[420px]"
      @interact-outside.prevent
      @escape-key-down.prevent
    >
      <DialogHeader class="flex-row items-center gap-3 space-y-0">
        <div
          class="border-primary/30 bg-primary/12 text-link flex size-9 items-center justify-center rounded-lg border"
        >
          <Wallet class="size-4" />
        </div>
        <DialogTitle class="text-base font-semibold tracking-tight">Wallet</DialogTitle>
        <DialogDescription class="sr-only">
          View your balance and add funds to your wallet.
        </DialogDescription>
      </DialogHeader>

      <div class="bg-muted rounded-lg border p-4">
        <div class="text-muted-foreground text-xs font-medium tracking-wider uppercase">
          Current balance
        </div>
        <div class="mt-1 text-3xl font-bold tracking-tight">
          {{ formatUSD(walletStore.balance) }}
        </div>
      </div>

      <div class="flex flex-col gap-2.5">
        <div class="text-sm font-semibold">Add funds</div>
        <div role="radiogroup" aria-label="Amount" class="grid grid-cols-4 gap-2">
          <button
            v-for="amount in AMOUNTS"
            :key="amount"
            type="button"
            role="radio"
            :aria-checked="isSelected(amount)"
            class="cursor-pointer rounded-lg border py-2.5 text-sm font-semibold transition-colors"
            :class="
              isSelected(amount)
                ? 'border-primary bg-primary/14 text-link'
                : 'bg-muted hover:border-border-strong'
            "
            @click="selectChip(amount)"
          >
            ${{ amount }}
          </button>
        </div>
        <InputGroup class="bg-muted h-10">
          <InputGroupAddon>
            <span class="text-muted-foreground text-sm">$</span>
          </InputGroupAddon>
          <InputGroupInput
            v-model="customAmount"
            inputmode="numeric"
            placeholder="Custom amount"
            :aria-invalid="exceedsMax"
          />
        </InputGroup>
        <p v-if="exceedsMax" role="alert" class="text-destructive text-xs">
          Maximum top-up is {{ formatUSD(MAX_AMOUNT_CENTS) }} at a time.
        </p>
      </div>

      <div class="flex flex-col gap-2.5">
        <div class="text-sm font-semibold">Card details</div>
        <!-- Placeholder until Stripe integration -->
        <div class="overflow-hidden rounded-lg border">
          <div class="flex h-11 items-center gap-2 border-b px-3">
            <CreditCard class="text-muted-foreground size-4 shrink-0" />
            <input
              placeholder="Card number"
              class="placeholder:text-muted-foreground w-0 flex-1 bg-transparent text-sm outline-none"
            />
            <span class="text-muted-foreground font-mono text-xs tracking-wider">VISA</span>
          </div>
          <div class="flex h-11">
            <input
              placeholder="MM / YY"
              class="placeholder:text-muted-foreground w-0 flex-1 border-r bg-transparent px-3 text-sm outline-none"
            />
            <input
              placeholder="CVC"
              class="placeholder:text-muted-foreground w-0 flex-1 border-r bg-transparent px-3 text-sm outline-none"
            />
            <input
              placeholder="ZIP"
              class="placeholder:text-muted-foreground w-22 bg-transparent px-3 text-sm outline-none"
            />
          </div>
        </div>
      </div>

      <div class="flex flex-col gap-3">
        <Button size="lg" class="w-full" :disabled="effectiveCents <= 0 || exceedsMax" @click="onPay">
          Pay {{ formatUSD(effectiveCents) }}
        </Button>
        <div class="text-muted-foreground flex items-center justify-center gap-1.5 text-xs">
          <Lock class="size-3" />
          Secured by Stripe · one-time payment
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>
