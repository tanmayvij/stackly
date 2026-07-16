<script setup lang="ts">
import { ref } from 'vue'
import { Check, Link2, LoaderCircle } from '@lucide/vue'
import GhlConnectModal from '@/components/ghl/GhlConnectModal.vue'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { useGhlStore } from '@/stores/ghl'

const ghlStore = useGhlStore()

const connectOpen = ref(false)
const disconnectOpen = ref(false)
const disconnecting = ref(false)

async function onDisconnect() {
  disconnecting.value = true
  try {
    await ghlStore.disconnect()
    disconnectOpen.value = false
  } finally {
    disconnecting.value = false
  }
}
</script>

<template>
  <div class="bg-card flex items-center justify-between gap-4 rounded-xl border p-5">
    <template v-if="ghlStore.connection">
      <div class="flex items-center gap-3">
        <div
          class="flex size-10 shrink-0 items-center justify-center rounded-lg border border-green-500/25 bg-green-500/10 text-green-500"
        >
          <Check class="size-5" />
        </div>
        <div>
          <div class="flex items-center gap-2 text-sm font-semibold">
            <span class="size-1.5 rounded-full bg-green-500 shadow-[0_0_8px] shadow-green-500/70" />
            HighLevel connected
          </div>
          <div class="text-muted-foreground mt-0.5 font-mono text-xs">
            {{ ghlStore.connection.locationName }} ·
            {{ ghlStore.connection.scopesGranted }} scopes granted
          </div>
        </div>
      </div>
      <AlertDialog v-model:open="disconnectOpen">
        <AlertDialogTrigger as-child>
          <Button
            variant="outline"
            class="hover:border-destructive/50 hover:text-destructive hover:bg-transparent"
          >
            Disconnect
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent
          class="bg-card border-border-strong shadow-card rounded-xl"
          @escape-key-down="disconnecting && $event.preventDefault()"
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect HighLevel?</AlertDialogTitle>
            <AlertDialogDescription>
              Your apps will lose access to this HighLevel location and stop working until you
              reconnect.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel :disabled="disconnecting">Cancel</AlertDialogCancel>
            <Button
              class="bg-destructive text-white hover:bg-destructive/90"
              :disabled="disconnecting"
              @click="onDisconnect"
            >
              <LoaderCircle v-if="disconnecting" class="size-4 animate-spin" />
              Disconnect
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </template>

    <template v-else>
      <div class="flex items-center gap-3">
        <div
          class="bg-muted flex size-10 shrink-0 items-center justify-center rounded-lg border"
        >
          <Link2 class="text-muted-foreground size-5" />
        </div>
        <div>
          <div class="text-sm font-semibold">Connect your HighLevel account</div>
          <div class="text-muted-foreground mt-0.5 max-w-md text-xs">
            Link GoHighLevel so Stackly can read and write through the marketplace APIs.
          </div>
        </div>
      </div>
      <Button @click="connectOpen = true">Connect</Button>
    </template>

    <GhlConnectModal v-model:open="connectOpen" />
  </div>
</template>
