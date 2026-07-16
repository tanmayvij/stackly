<script setup lang="ts">
import { ArrowUpRight, Link2, TriangleAlert } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useGhlStore } from '@/stores/ghl'

const open = defineModel<boolean>('open', { required: true })

const ghlStore = useGhlStore()

const STEPS = [
  'Sign in to your HighLevel account.',
  'Select a single sub-account to grant access to.',
  'Approve the requested scopes and return here.',
]

function onContinue() {
  ghlStore.startConnect()
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent
      class="bg-card border-border-strong shadow-card gap-5 rounded-xl p-6 duration-200 data-[state=open]:slide-in-from-bottom-1 sm:max-w-[436px]"
    >
      <DialogHeader class="gap-3">
        <div class="flex items-center gap-3">
          <div
            class="border-primary/30 bg-primary/12 text-link flex size-9 items-center justify-center rounded-lg border"
          >
            <Link2 class="size-4" />
          </div>
          <DialogTitle class="text-base font-semibold tracking-tight">
            Connect HighLevel
          </DialogTitle>
        </div>
        <DialogDescription class="text-left">
          You'll be redirected to HighLevel to authorize Stackly. Here's what happens:
        </DialogDescription>
      </DialogHeader>

      <div class="flex flex-col gap-3">
        <div v-for="(step, index) in STEPS" :key="step" class="flex items-start gap-3">
          <div
            class="bg-muted text-muted-foreground flex size-5.5 shrink-0 items-center justify-center rounded-full border text-xs font-semibold"
          >
            {{ index + 1 }}
          </div>
          <p class="pt-px text-sm leading-relaxed">{{ step }}</p>
        </div>
      </div>

      <div
        class="flex items-start gap-2.5 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3.5 py-3"
      >
        <TriangleAlert class="mt-0.5 size-4 shrink-0 text-amber-500" />
        <p class="text-xs leading-relaxed">
          Connect a <span class="font-semibold">sub-account</span>, not an agency. Stackly needs a
          single location — agency-level installs aren't supported and will be rejected.
        </p>
      </div>

      <DialogFooter>
        <Button variant="outline" @click="open = false">Cancel</Button>
        <Button @click="onContinue">
          Continue to HighLevel
          <ArrowUpRight />
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
