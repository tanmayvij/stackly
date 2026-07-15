<script setup lang="ts">
import { ref } from 'vue'
import { RouterLink } from 'vue-router'
import { ArrowLeft, LoaderCircle, MailCheck } from '@lucide/vue'
import AuthLayout from '@/layouts/AuthLayout.vue'
import AppLogo from '@/components/shared/AppLogo.vue'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { useAuthStore } from '@/stores/auth'
import { getAuthErrorCode, getAuthErrorMessage } from '@/lib/auth-errors'

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const authStore = useAuthStore()

const step = ref<'request' | 'sent'>('request')
const email = ref('')
const formError = ref('')
const pending = ref(false)

function isValidEmail(emailStr: string): boolean {
  return EMAIL_REGEX.test(emailStr.trim())
}

async function onSubmit() {
  if (!email.value.trim() || !isValidEmail(email.value)) {
    formError.value = 'Enter a valid email address.'
    return
  }
  formError.value = ''
  pending.value = true
  try {
    await authStore.sendPasswordReset(email.value.trim())
    step.value = 'sent'
  } catch (error) {
    // Treat user-not-found as success so we don't reveal which emails have accounts.
    if (getAuthErrorCode(error) === 'auth/user-not-found') {
      step.value = 'sent'
    } else {
      formError.value = getAuthErrorMessage(error)
    }
  } finally {
    pending.value = false
  }
}
</script>

<template>
  <AuthLayout>
    <!-- Request step -->
    <div
      v-if="step === 'request'"
      class="animate-in fade-in slide-in-from-bottom-2 duration-400"
    >
      <div class="mb-7 flex flex-col items-center">
        <AppLogo class="mb-4" />
        <h1 class="text-2xl font-semibold tracking-tight">Reset your password</h1>
        <p class="text-muted-foreground mt-2 text-center text-sm">
          Enter your email and we'll send you a reset link.
        </p>
      </div>

      <Card class="shadow-card">
        <CardContent>
          <form class="flex flex-col gap-4" novalidate @submit.prevent="onSubmit">
            <Field>
              <FieldLabel for="email">Email</FieldLabel>
              <Input
                id="email"
                v-model="email"
                type="email"
                autocomplete="email"
                placeholder="you@company.com"
              />
            </Field>
            <FieldError v-if="formError" class="text-xs">{{ formError }}</FieldError>
            <Button type="submit" class="w-full" :disabled="pending">
              <LoaderCircle v-if="pending" class="animate-spin" />
              Send reset link
            </Button>
          </form>
        </CardContent>
      </Card>

      <Button as-child variant="ghost" size="sm" class="text-muted-foreground mt-3 w-full">
        <RouterLink :to="{ name: 'auth' }">
          <ArrowLeft />
          Back to sign in
        </RouterLink>
      </Button>
    </div>

    <!-- Sent step -->
    <div v-else class="animate-in fade-in slide-in-from-bottom-2 duration-350">
      <div class="mb-6 flex flex-col items-center">
        <MailCheck class="text-muted-foreground mb-4 size-10" />
        <h1 class="text-2xl font-semibold tracking-tight">Check your email</h1>
        <p class="text-muted-foreground mt-2 text-center text-sm">
          If an account exists for {{ email }}, we've sent a link to reset your password.
        </p>
      </div>

      <Button as-child variant="ghost" size="sm" class="text-muted-foreground w-full">
        <RouterLink :to="{ name: 'auth' }">
          <ArrowLeft />
          Back to sign in
        </RouterLink>
      </Button>
    </div>
  </AuthLayout>
</template>
