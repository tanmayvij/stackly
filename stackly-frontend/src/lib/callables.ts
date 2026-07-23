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

/** The caller's HighLevel connection status, or null if not connected. */
export type GhlConnectionStatus = { locationName: string; scopesGranted: number }

/**
 * Exchanges a HighLevel OAuth authorization code for tokens (stored
 * server-side) and returns the connected location's name and scope count.
 */
export const exchangeGhlCode = callable<
  { code: string },
  GhlConnectionStatus
>('exchangeGhlCode')

/** Returns the caller's HighLevel connection status, or null if not connected. */
export const getGhlConnection = callable<void, GhlConnectionStatus | null>('getGhlConnection')

/** Removes the caller's stored HighLevel connection. */
export const disconnectGhl = callable<void, { ok: true }>('disconnectGhl')

/**
 * Generates a name and description for the prompt via the LLM and stores a new
 * project under the caller's account. Returns the created project.
 */
export const createProject = callable<
  { prompt: string; modelId: string },
  { id: string; name: string; description: string; modelId: string }
>('createProject')

/**
 * Mints a short-lived token the preview iframe uses to call the GHL proxy.
 * Fails with `failed-precondition` when HighLevel is not connected.
 */
export const mintPreviewToken = callable<
  void,
  { token: string; expiresAtMs: number; locationId: string }
>('mintPreviewToken')
