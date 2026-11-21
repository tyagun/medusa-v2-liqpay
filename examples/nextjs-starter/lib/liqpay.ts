"use server"

// Server action for the Medusa Next.js Starter: starts a LiqPay payment for the
// current cart and returns the form the browser posts to LiqPay's hosted page.

import { sdk } from "@lib/config"
import { getAuthHeaders, getCartId } from "@lib/data/cookies"
import { HttpTypes } from "@medusajs/types"

const LIQPAY_PROVIDER_ID = "pp_liqpay_liqpay"

export type LiqPayForm = { url: string; data: string; signature: string }

/**
 * True when the session's signed form charges exactly what the cart now costs. A form
 * is signed for one amount and cannot be changed, so after the cart total or currency
 * changes the customer needs a new form; reusing the old one would pay the old amount.
 */
function matchesCart(session: HttpTypes.StorePaymentSession, cart: HttpTypes.StoreCart): boolean {
  const stored = (session.data ?? {}) as Record<string, unknown>
  return (
    typeof stored.amount === "number" &&
    typeof cart.total === "number" &&
    Math.abs(stored.amount - cart.total) < 0.005 &&
    typeof stored.currency_code === "string" &&
    stored.currency_code.toLowerCase() === cart.currency_code?.toLowerCase()
  )
}

/**
 * Reuses an outstanding session while it still matches the cart; creates a new session
 * for a new attempt or a changed cart. The plugin uses the unique Medusa payment session
 * id as LiqPay order_id.
 */
export async function startLiqPayPayment(): Promise<{ form: LiqPayForm } | { error: string }> {
  const cartId = await getCartId()
  if (!cartId) {
    return { error: "No cart" }
  }
  const headers = { ...(await getAuthHeaders()) }

  const { cart } = await sdk.client.fetch<HttpTypes.StoreCartResponse>(`/store/carts/${cartId}`, {
    headers,
    cache: "no-store",
  })

  // Reuse an outstanding attempt while it matches the cart, so repeated clicks do not
  // replace a checkout that is still open in another tab. Terminal failures and a changed
  // cart start a fresh attempt; the plugin retires the old one for late-payment review.
  const existing = cart.payment_collection?.payment_sessions?.find(
    (s) => s.provider_id === LIQPAY_PROVIDER_ID
  )
  if (existing && !["error", "canceled"].includes(existing.status) && matchesCart(existing, cart)) {
    const stored = existing.data as Record<string, unknown>
    if (typeof stored.checkout_data === "string" && typeof stored.checkout_signature === "string") {
      return { form: { url: "https://www.liqpay.ua/api/3/checkout",
        data: stored.checkout_data, signature: stored.checkout_signature } }
    }
    return { error: "An existing payment needs review before starting another attempt" }
  }

  const { payment_collection } = await sdk.store.payment.initiatePaymentSession(
    cart,
    { provider_id: LIQPAY_PROVIDER_ID },
    {},
    headers
  )

  const session = payment_collection.payment_sessions?.find(
    (s) => s.provider_id === LIQPAY_PROVIDER_ID
  )
  const data = session?.data as
    | { checkout_url?: string; checkout_data?: string; checkout_signature?: string }
    | undefined

  if (!data?.checkout_url || !data.checkout_data || !data.checkout_signature) {
    return { error: "LiqPay session has no checkout form" }
  }
  return { form: { url: "https://www.liqpay.ua/api/3/checkout",
    data: data.checkout_data, signature: data.checkout_signature } }
}
