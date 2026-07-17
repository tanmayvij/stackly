import { ref, computed, triggerRef } from 'vue'
import { defineStore } from 'pinia'
import {
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  onAuthStateChanged,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut as firebaseSignOut,
  updateProfile,
  type User,
} from 'firebase/auth'
import { auth } from '@/lib/firebase'

export const useAuthStore = defineStore('auth', () => {
  const user = ref<User | null>(null)
  const isReady = ref(false)

  const isAuthenticated = computed(() => user.value !== null)
  const isEmailVerified = computed(() => user.value?.emailVerified ?? false)

  let readyPromise: Promise<void> | null = null

  function init() {
    if (readyPromise) return
    readyPromise = new Promise((resolve) => {
      onAuthStateChanged(auth, (firebaseUser) => {
        user.value = firebaseUser
        isReady.value = true
        resolve()
      })
    })
  }

  function awaitReady(): Promise<void> {
    init()
    return readyPromise!
  }

  async function signInWithGoogle() {
    await signInWithPopup(auth, new GoogleAuthProvider())
  }

  async function signInWithEmail(email: string, password: string) {
    await signInWithEmailAndPassword(auth, email, password)
  }

  async function register(email: string, password: string, displayName: string) {
    const { user: newUser } = await createUserWithEmailAndPassword(auth, email, password)
    await updateProfile(newUser, { displayName })
    await sendEmailVerification(newUser, { url: window.location.origin })
    // updateProfile mutates the same User instance already held in the ref,
    // so a plain assignment wouldn't notify watchers.
    triggerRef(user)
  }

  async function resendVerification() {
    if (auth.currentUser) {
      await sendEmailVerification(auth.currentUser, { url: window.location.origin })
    }
  }

  async function reloadUser() {
    if (auth.currentUser) {
      await auth.currentUser.reload()
      // reload() mutates the current User in place; force watchers to re-read emailVerified.
      triggerRef(user)
    }
  }

  async function signOut() {
    await firebaseSignOut(auth)
  }

  async function sendPasswordReset(email: string) {
    await sendPasswordResetEmail(auth, email, {
      url: window.location.origin,
    })
  }

  return {
    user,
    isReady,
    isAuthenticated,
    isEmailVerified,
    init,
    awaitReady,
    signInWithGoogle,
    signInWithEmail,
    register,
    resendVerification,
    reloadUser,
    signOut,
    sendPasswordReset,
  }
})
