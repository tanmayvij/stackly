import { ref, computed, triggerRef } from 'vue'
import { defineStore } from 'pinia'
import {
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  onAuthStateChanged,
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
    // updateProfile mutates the same User instance already held in the ref,
    // so a plain assignment wouldn't notify watchers.
    triggerRef(user)
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
    init,
    awaitReady,
    signInWithGoogle,
    signInWithEmail,
    register,
    signOut,
    sendPasswordReset,
  }
})
