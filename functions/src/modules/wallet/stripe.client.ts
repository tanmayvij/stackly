import Stripe from "stripe";
import {STRIPE_SECRET_KEY} from "../../shared/config";

/**
 * Lazily constructs the Stripe client from the runtime secret.
 * @return {Stripe} A configured Stripe client.
 */
export function stripeClient(): Stripe {
  return new Stripe(STRIPE_SECRET_KEY.value());
}
