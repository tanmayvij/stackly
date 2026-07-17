<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { LoaderCircle, LogOut, MailCheck } from '@lucide/vue'
import AuthLayout from '@/layouts/AuthLayout.vue'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Field, FieldError } from '@/components/ui/field'
import { useAuthStore } from '@/stores/auth'
import { getAuthErrorMessage } from '@/lib/auth-errors'

const router = useRouter()
const authStore = useAuthStore()

const formError = ref('')
const resent = ref(false)
const pending = ref<'continue' | 'resend' | 'signout' | null>(null)

async function onContinue() {
  formError.value = ''
  resent.value = false
  pending.value = 'continue'
  try {
    await authStore.reloadUser()
    if (authStore.isEmailVerified) {
      router.push('/dashboard')
    } else {
      formError.value = "Not verified yet — check your inbox and click the link."
    }
  } catch (error) {
    formError.value = getAuthErrorMessage(error)
  } finally {
    pending.value = null
  }
}

async function onResend() {
  formError.value = ''
  resent.value = false
  pending.value = 'resend'
  try {
    await authStore.resendVerification()
    resent.value = true
  } catch (error) {
    formError.value = getAuthErrorMessage(error)
  } finally {
    pending.value = null
  }
}

async function onSignOut() {
  pending.value = 'signout'
  try {
    await authStore.signOut()
    router.push({ name: 'auth' })
  } finally {
    pending.value = null
  }
}
</script>

<template>
  <AuthLayout>
    <div class="animate-in fade-in slide-in-from-bottom-2 duration-400">
      <div class="mb-6 flex flex-col items-center">
        <MailCheck class="text-muted-foreground mb-4 size-10" />
        <h1 class="text-2xl font-semibold tracking-tight">Verify your email</h1>
        <p class="text-muted-foreground mt-2 text-center text-sm">
          We've sent a verification link to
          <span class="text-foreground font-medium">{{ authStore.user?.email }}</span
          >. Click it to activate your account, then continue.
        </p>
      </div>

      <Card class="shadow-card">
        <CardContent>
          <div class="flex flex-col gap-4">
            <Button class="w-full" :disabled="pending !== null" @click="onContinue">
              <LoaderCircle v-if="pending === 'continue'" class="animate-spin" />
              I've verified — continue
            </Button>
            <Button
              variant="outline"
              class="w-full"
              :disabled="pending !== null"
              @click="onResend"
            >
              <LoaderCircle v-if="pending === 'resend'" class="animate-spin" />
              Resend verification email
            </Button>
            <Field v-if="resent || formError">
              <p v-if="resent" class="text-muted-foreground text-xs">
                Verification email sent. It may take a minute to arrive.
              </p>
              <FieldError v-if="formError" class="text-xs">{{ formError }}</FieldError>
            </Field>
          </div>
        </CardContent>
      </Card>

      <Button
        variant="ghost"
        size="sm"
        class="text-muted-foreground mt-3 w-full"
        :disabled="pending !== null"
        @click="onSignOut"
      >
        <LogOut />
        Sign out
      </Button>
    </div>
  </AuthLayout>
</template>
