<script setup lang="ts">
import { ref } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { ArrowLeft, LoaderCircle, Mail } from '@lucide/vue'
import AuthLayout from '@/layouts/AuthLayout.vue'
import AppLogo from '@/components/shared/AppLogo.vue'
import GoogleButton from '@/components/auth/GoogleButton.vue'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Field, FieldError, FieldGroup, FieldLabel, FieldSeparator } from '@/components/ui/field'
import { Input, PasswordInput } from '@/components/ui/input'
import { useAuthStore } from '@/stores/auth'
import { getAuthErrorCode, getAuthErrorMessage, isPopupCancelled } from '@/lib/auth-errors'

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const route = useRoute()
const router = useRouter()
const authStore = useAuthStore()

const step = ref<'credentials' | 'name'>('credentials')
const email = ref('')
const password = ref('')
const firstName = ref('')
const lastName = ref('')
const formError = ref('')
const pending = ref<'google' | 'submit' | 'create' | null>(null)

function isValidEmail(emailStr: string): boolean {
  return EMAIL_REGEX.test(emailStr.trim())
}

function goToApp() {
  const redirect = route.query.redirect
  router.push(typeof redirect === 'string' ? redirect : '/dashboard')
}

async function onGoogle() {
  formError.value = ''
  pending.value = 'google'
  try {
    await authStore.signInWithGoogle()
    goToApp()
  } catch (error) {
    if (!isPopupCancelled(error)) formError.value = getAuthErrorMessage(error)
  } finally {
    pending.value = null
  }
}

async function onCredentialsSubmit() {
  if (!email.value.trim() || !password.value.trim()) {
    formError.value = 'Enter an email and password to continue.'
    return
  }
  if (!isValidEmail(email.value)) {
    formError.value = 'Enter a valid email address.'
    return
  }
  formError.value = ''
  pending.value = 'submit'
  try {
    await authStore.signInWithEmail(email.value.trim(), password.value)
    goToApp()
  } catch (error) {
    if (getAuthErrorCode(error) === 'auth/user-not-found') {
      step.value = 'name'
    } else {
      formError.value = getAuthErrorMessage(error)
    }
  } finally {
    pending.value = null
  }
}

async function onCreate() {
  if (!firstName.value.trim()) {
    formError.value = 'Enter your first name to continue.'
    return
  }
  formError.value = ''
  pending.value = 'create'
  try {
    const displayName = [firstName.value.trim(), lastName.value.trim()].filter(Boolean).join(' ')
    await authStore.register(email.value.trim(), password.value, displayName)
    goToApp()
  } catch (error) {
    formError.value = getAuthErrorMessage(error)
  } finally {
    pending.value = null
  }
}

function goBack() {
  formError.value = ''
  step.value = 'credentials'
}
</script>

<template>
  <AuthLayout>
    <!-- Credentials step -->
    <div
      v-if="step === 'credentials'"
      class="animate-in fade-in slide-in-from-bottom-2 duration-400"
    >
      <div class="mb-7 flex flex-col items-center">
        <AppLogo wordmark class="mb-4" />
        <h1 class="text-2xl font-semibold tracking-tight">Welcome to Stackly</h1>
        <p class="text-muted-foreground mt-2 text-center text-sm">
          Build apps for the GoHighLevel Marketplace
        </p>
      </div>

      <Card class="shadow-card">
        <CardContent>
          <FieldGroup class="gap-5">
            <GoogleButton :loading="pending === 'google'" @click="onGoogle" />
            <FieldSeparator class="[&>span]:bg-card">or</FieldSeparator>
            <form class="flex flex-col gap-4" novalidate @submit.prevent="onCredentialsSubmit">
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
              <Field>
                <div class="flex items-center justify-between">
                  <FieldLabel for="password">Password</FieldLabel>
                  <RouterLink
                    :to="{ name: 'forgot-password' }"
                    class="text-muted-foreground hover:text-foreground text-xs underline-offset-4 hover:underline"
                  >
                    Forgot password?
                  </RouterLink>
                </div>
                <PasswordInput
                  id="password"
                  v-model="password"
                  autocomplete="current-password"
                  placeholder="Enter your password"
                />
              </Field>
              <FieldError v-if="formError" class="text-xs">{{ formError }}</FieldError>
              <Button type="submit" class="w-full" :disabled="pending === 'submit'">
                <LoaderCircle v-if="pending === 'submit'" class="animate-spin" />
                Continue
              </Button>
            </form>
          </FieldGroup>
        </CardContent>
      </Card>

      <p class="text-muted-foreground mt-4 text-center text-xs">
        New here? Just continue — we'll create your account.
      </p>
    </div>

    <!-- Name step -->
    <div v-else class="animate-in fade-in slide-in-from-bottom-2 duration-350">
      <div class="mb-6 flex flex-col items-center">
        <AppLogo class="mb-4" />
        <h1 class="text-2xl font-semibold tracking-tight">Create your account</h1>
        <p class="text-muted-foreground mt-2 text-center text-sm">
          Just your name to finish setting up.
        </p>
      </div>

      <Card class="shadow-card">
        <CardContent>
          <form class="flex flex-col gap-4" novalidate @submit.prevent="onCreate">
            <div class="grid grid-cols-2 gap-3">
              <Field>
                <FieldLabel for="first-name">First name</FieldLabel>
                <Input
                  id="first-name"
                  v-model="firstName"
                  autocomplete="given-name"
                  placeholder="Jane"
                />
              </Field>
              <Field>
                <FieldLabel for="last-name">Last name</FieldLabel>
                <Input
                  id="last-name"
                  v-model="lastName"
                  autocomplete="family-name"
                  placeholder="Doe"
                />
              </Field>
            </div>
            <div class="bg-muted flex items-center gap-2 rounded-md border px-3 py-2.5">
              <Mail class="text-muted-foreground size-4 shrink-0" />
              <span class="text-muted-foreground truncate text-sm">{{ email }}</span>
            </div>
            <FieldError v-if="formError" class="text-xs">{{ formError }}</FieldError>
            <Button type="submit" class="w-full" :disabled="pending === 'create'">
              <LoaderCircle v-if="pending === 'create'" class="animate-spin" />
              Create account
            </Button>
          </form>
        </CardContent>
      </Card>

      <Button variant="ghost" size="sm" class="text-muted-foreground mt-3 w-full" @click="goBack">
        <ArrowLeft />
        Back
      </Button>
    </div>
  </AuthLayout>
</template>
