<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { CircleCheck, LoaderCircle, Lock, Wallet } from '@lucide/vue'
import {
  loadStripe,
  type Stripe,
  type StripeElements,
  type StripePaymentElement,
} from '@stripe/stripe-js'
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
import { confirmTopUp, createTopUpIntent } from '@/lib/callables'
import { useTheme } from '@/composables/useTheme'

const open = defineModel<boolean>('open', { required: true })

const walletStore = useWalletStore()
const { resolvedTheme } = useTheme()

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

const lowBalance = computed(
  () => walletStore.balance !== null && walletStore.balance < 100,
)

function isSelected(amount: number) {
  return !customAmount.value && rechargeAmount.value === amount
}

function selectChip(amount: number) {
  rechargeAmount.value = amount
  customAmount.value = ''
}

// --- Payment flow ---
type Step = 'amount' | 'payment' | 'success'
const step = ref<Step>('amount')
const processing = ref(false)
const errorMessage = ref<string | null>(null)

const paymentElRef = ref<HTMLDivElement | null>(null)
let stripe: Stripe | null = null
let elements: StripeElements | null = null
let paymentElement: StripePaymentElement | null = null
let paymentIntentId: string | null = null

const publishableKey = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY as string | undefined

const POLL_ATTEMPTS = 10
const POLL_DELAY_MS = 1500

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function errorText(err: unknown, fallback: string) {
  return err instanceof Error && err.message ? err.message : fallback
}

// Step 1 → create the PaymentIntent and mount Stripe's hosted PaymentElement.
async function onContinue() {
  if (effectiveCents.value <= 0 || exceedsMax.value || processing.value) return
  errorMessage.value = null
  processing.value = true
  try {
    if (!publishableKey) throw new Error('Payments are not configured yet.')
    stripe = await loadStripe(publishableKey)
    if (!stripe) throw new Error('Could not load the payment form. Please retry.')

    const { data } = await createTopUpIntent({ amountCents: effectiveCents.value })
    paymentIntentId = data.paymentIntentId

    elements = stripe.elements({
      clientSecret: data.clientSecret,
      appearance: { theme: resolvedTheme.value === 'dark' ? 'night' : 'stripe' },
    })
    paymentElement = elements.create('payment')

    step.value = 'payment'
    await nextTick()
    if (paymentElRef.value) paymentElement.mount(paymentElRef.value)
  } catch (err) {
    errorMessage.value = errorText(err, 'Something went wrong. Please try again.')
    teardownPayment()
    step.value = 'amount'
  } finally {
    processing.value = false
  }
}

// Step 2 → confirm the card, then poll the server until the credit lands.
async function onPay() {
  if (!stripe || !elements || processing.value) return
  errorMessage.value = null
  processing.value = true
  try {
    const result = await stripe.confirmPayment({ elements, redirect: 'if_required' })
    if (result.error) {
      // Declined card, validation, or network error — surface and stay put.
      errorMessage.value = result.error.message ?? 'Payment failed. Please try another card.'
      return
    }
    await pollConfirm()
  } catch (err) {
    errorMessage.value = errorText(err, 'Payment could not be completed. Please try again.')
  } finally {
    processing.value = false
  }
}

async function pollConfirm() {
  const pid = paymentIntentId
  if (!pid) return
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    const { data } = await confirmTopUp({ paymentIntentId: pid })
    if (data.status === 'succeeded') {
      await walletStore.fetchBalance()
      step.value = 'success'
      await delay(1200)
      open.value = false
      return
    }
    if (data.status === 'requires_payment_method' || data.status === 'canceled') {
      errorMessage.value = 'Payment failed. Please try another card.'
      return
    }
    // 'processing' / 'requires_action' — wait for Stripe to settle, then retry.
    await delay(POLL_DELAY_MS)
  }
  // Timed out while still processing. The server credit is idempotent, so the
  // balance will reconcile once Stripe settles; refresh and close cleanly.
  await walletStore.fetchBalance()
  open.value = false
}

function backToAmount() {
  if (processing.value) return
  teardownPayment()
  errorMessage.value = null
  step.value = 'amount'
}

function teardownPayment() {
  paymentElement?.unmount()
  paymentElement = null
  elements = null
  paymentIntentId = null
}

function reset() {
  teardownPayment()
  step.value = 'amount'
  processing.value = false
  errorMessage.value = null
  rechargeAmount.value = 25
  customAmount.value = ''
}

watch(open, (isOpen) => {
  if (!isOpen) reset()
})

onBeforeUnmount(() => paymentElement?.unmount())
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent
      class="bg-card border-border-strong shadow-card flex h-[560px] max-h-[85vh] flex-col gap-0 overflow-hidden rounded-xl p-0 duration-200 data-[state=open]:slide-in-from-bottom-1 sm:max-w-[420px]"
      @interact-outside.prevent
      @escape-key-down.prevent
    >
      <DialogHeader class="flex-row shrink-0 items-center gap-3 space-y-0 p-6 pb-4">
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

      <!-- Scrollable body: content between the pinned header and footer. -->
      <div class="flex flex-1 flex-col gap-5 overflow-y-auto px-6">
        <p v-if="lowBalance" class="text-destructive text-sm">
          Please add funds to your wallet to keep using the app.
        </p>

        <div class="bg-muted rounded-lg border p-4">
          <div class="text-muted-foreground text-xs font-medium tracking-wider uppercase">
            Current balance
          </div>
          <div class="mt-1 text-3xl font-bold tracking-tight">
            {{ formatUSD(walletStore.balance ?? 0) }}
          </div>
        </div>

        <p v-if="errorMessage" role="alert" class="text-destructive text-sm">{{ errorMessage }}</p>

        <!-- Step 1: choose amount -->
        <div v-if="step === 'amount'" class="flex flex-col gap-2.5">
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

        <!-- Step 2: card details (Stripe-hosted) -->
        <div v-else-if="step === 'payment'" class="flex flex-col gap-2.5">
          <div class="text-sm font-semibold">Paying {{ formatUSD(effectiveCents) }}</div>
          <!-- Stripe PaymentElement mounts here; no card data touches our code. -->
          <div ref="paymentElRef" class="min-h-[44px]"></div>
        </div>

        <!-- Step 3: success -->
        <div v-else class="flex flex-1 flex-col items-center justify-center gap-2 py-4 text-center">
          <CircleCheck class="text-link size-10" />
          <div class="text-sm font-semibold">Payment successful</div>
          <div class="text-muted-foreground text-xs">Your balance has been updated.</div>
        </div>
      </div>

      <!-- Pinned footer: primary action stays visible while the body scrolls. -->
      <div v-if="step !== 'success'" class="shrink-0 flex flex-col gap-3 p-6 pt-4">
        <Button
          v-if="step === 'amount'"
          size="lg"
          class="w-full"
          :disabled="effectiveCents <= 0 || exceedsMax || processing"
          @click="onContinue"
        >
          <LoaderCircle v-if="processing" class="size-4 animate-spin" />
          {{ processing ? 'Preparing…' : `Continue · ${formatUSD(effectiveCents)}` }}
        </Button>

        <template v-else>
          <Button size="lg" class="w-full" :disabled="processing" @click="onPay">
            <LoaderCircle v-if="processing" class="size-4 animate-spin" />
            {{ processing ? 'Processing…' : `Pay ${formatUSD(effectiveCents)}` }}
          </Button>
          <button
            type="button"
            class="text-muted-foreground hover:text-foreground text-xs transition-colors disabled:opacity-50"
            :disabled="processing"
            @click="backToAmount"
          >
            ← Change amount
          </button>
        </template>

        <div class="text-muted-foreground flex items-center justify-center gap-1.5 text-xs">
          <Lock class="size-3" />
          Secured by Stripe · one-time payment
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>
