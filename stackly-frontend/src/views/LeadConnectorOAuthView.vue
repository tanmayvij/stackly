<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { CircleCheck, LoaderCircle, TriangleAlert } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { useGhlStore } from '@/stores/ghl'

const route = useRoute()
const router = useRouter()
const ghlStore = useGhlStore()

const status = ref<'working' | 'success' | 'error'>('working')
const message = ref('')

function fail(text: string) {
  status.value = 'error'
  message.value = text
}

onMounted(async () => {
  const { code, error, error_description: errorDescription } = route.query

  if (typeof error === 'string') {
    fail(
      typeof errorDescription === 'string' ?
        errorDescription :
        'HighLevel denied the authorization request.',
    )
    return
  }
  if (typeof code !== 'string' || !code) {
    fail('No authorization code was returned by HighLevel.')
    return
  }

  try {
    await ghlStore.finalizeConnect(code)
    status.value = 'success'
    router.replace({ name: 'dashboard' })
  } catch (err) {
    fail((err as { message?: string }).message ?? 'Failed to connect HighLevel.')
  }
})
</script>

<template>
  <div class="bg-background flex min-h-svh flex-col items-center justify-center gap-4 px-6 text-center">
    <template v-if="status === 'working'">
      <LoaderCircle class="text-muted-foreground size-8 animate-spin" />
      <p class="text-muted-foreground text-sm">Finishing your HighLevel connection…</p>
    </template>

    <template v-else-if="status === 'success'">
      <CircleCheck class="size-8 text-green-500" />
      <p class="text-sm font-medium">HighLevel connected. Redirecting…</p>
    </template>

    <template v-else>
      <TriangleAlert class="text-destructive size-8" />
      <h1 class="text-lg font-semibold tracking-tight">Couldn't connect HighLevel</h1>
      <p class="text-muted-foreground max-w-sm text-sm">{{ message }}</p>
      <Button variant="outline" @click="router.replace({ name: 'dashboard' })">
        Back to dashboard
      </Button>
    </template>
  </div>
</template>
