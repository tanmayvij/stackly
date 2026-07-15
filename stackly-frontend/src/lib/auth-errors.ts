import { FirebaseError } from 'firebase/app'

export function getAuthErrorCode(error: unknown): string | null {
  return error instanceof FirebaseError ? error.code : null
}

export function isPopupCancelled(error: unknown): boolean {
  const code = getAuthErrorCode(error)
  return code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request'
}

const MESSAGES: Record<string, string> = {
  'auth/invalid-email': 'That email address looks invalid.',
  'auth/invalid-credential': 'Incorrect email or password.',
  'auth/wrong-password': 'Incorrect email or password.',
  'auth/weak-password': 'Password should be at least 6 characters.',
  'auth/email-already-in-use': 'An account with this email already exists. Check your password.',
  'auth/too-many-requests': 'Too many attempts. Please wait a moment and try again.',
  'auth/network-request-failed': 'Network error. Check your connection and try again.',
  'auth/popup-blocked': 'Your browser blocked the sign-in popup. Allow popups and try again.',
  'auth/user-disabled': 'This account has been disabled.',
}

export function getAuthErrorMessage(error: unknown): string {
  const code = getAuthErrorCode(error)
  return (code && MESSAGES[code]) || 'Something went wrong. Please try again.'
}
