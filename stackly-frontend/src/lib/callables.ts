import { httpsCallable, type HttpsCallableResult } from 'firebase/functions'
import { signOut } from 'firebase/auth'
import { auth, functions } from '@/lib/firebase'

/** Stripe PaymentIntent statuses we care about on the client. */
export type PaymentIntentStatus =
  | 'succeeded'
  | 'processing'
  | 'requires_payment_method'
  | 'requires_confirmation'
  | 'requires_action'
  | 'canceled'

/**
 * Wraps a callable so that an `unauthenticated` response signs the user out.
 * The auth-state change then trips the router guard, redirecting them to the
 * auth screen instead of stranding them on a page whose data can't load.
 */
function callable<Req, Res>(name: string) {
  const fn = httpsCallable<Req, Res>(functions, name)
  return async (data?: Req): Promise<HttpsCallableResult<Res>> => {
    try {
      return await fn(data as Req)
    } catch (err) {
      if ((err as { code?: string }).code === 'functions/unauthenticated') {
        await signOut(auth)
      }
      throw err
    }
  }
}

/** Returns the caller's current balance in cents, computed server-side. */
export const getCurrentBalance = callable<void, { balanceCents: number }>('getCurrentBalance')

/** Creates a Stripe PaymentIntent for a top-up of `amountCents`. */
export const createTopUpIntent = callable<
  { amountCents: number },
  { clientSecret: string; paymentIntentId: string }
>('createTopUpIntent')

/**
 * Verifies a PaymentIntent server-side and, if succeeded, idempotently credits
 * the wallet. Returns the PaymentIntent status and the refreshed balance.
 */
export const confirmTopUp = callable<
  { paymentIntentId: string },
  { status: PaymentIntentStatus; balanceCents: number }
>('confirmTopUp')
