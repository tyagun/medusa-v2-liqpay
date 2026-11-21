// LiqPay's `result_url`, e.g. https://shop.example/ua/checkout/liqpay/return.
// Nothing renders: it completes the cart and redirects to the confirmation, a pending
// page, or back to the payment step. Cart completion asks LiqPay for the live status,
// so the browser is never trusted; completing a cart the callback already completed
// returns the same order, so there is exactly one order either way.

import { sdk } from "@lib/config"
import { getAuthHeaders, getCacheTag, getCartId, removeCartId } from "@lib/data/cookies"
import { revalidateTag } from "next/cache"
import { NextRequest, NextResponse } from "next/server"

type Outcome = {
  outcome: "paid" | "pending" | "failed" | "not_paid" | "none" | "needs_review"
  completed: boolean
}

function publicOrigin(request: NextRequest): string {
  const configured = process.env.NEXT_PUBLIC_BASE_URL
  if (!configured && process.env.NODE_ENV === "production") {
    throw new Error("NEXT_PUBLIC_BASE_URL must be configured in production")
  }
  const url = new URL(configured ?? request.nextUrl.origin)
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new Error("NEXT_PUBLIC_BASE_URL must use HTTPS in production")
  }
  return url.origin
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ countryCode: string }> }
) {
  const { countryCode } = await params
  // Use your configured public URL in production, not the request's Host header.
  const base = `${publicOrigin(request)}/${encodeURIComponent(countryCode)}`
  const to = (path: string) => NextResponse.redirect(`${base}${path}`, 303)

  const cartId = await getCartId()
  if (!cartId) {
    return to("/cart")
  }
  const headers = { ...(await getAuthHeaders()) }

  try {
    const result = await sdk.store.cart.complete(cartId, {}, headers)
    if (result.type === "order") {
      await removeCartId()
      revalidateTag(await getCacheTag("carts"))
      revalidateTag(await getCacheTag("orders"))
      return to(`/order/${result.order.id}/confirmed`)
    }
  } catch {
    // Not authorized yet, declined, or never paid: the outcome below tells which.
  }

  const outcome = await sdk.client
    .fetch<Outcome>(`/store/liqpay/carts/${cartId}/status`, { method: "GET", headers })
    .catch(() => null)

  switch (outcome?.outcome) {
    case "needs_review":
      return to("/checkout?step=payment&payment=needs_review")
    case "failed":
      return to("/checkout?step=payment&payment=failed")
    case "not_paid":
    case "none":
      return to("/checkout?step=payment&payment=abandoned")
    default:
      // paid (the next completion will succeed), pending, or the check itself failed:
      // show a page that retries this route every few seconds.
      return to("/checkout/liqpay/pending")
  }
}

/**
 * LiqPay may return the customer with a form POST. A SameSite=Lax cart cookie is not
 * sent on a cross-site POST, but a 303 to GET is a top-level navigation, which carries it.
 */
export async function POST(request: NextRequest) {
  return NextResponse.redirect(new URL(request.nextUrl.pathname, publicOrigin(request)), 303)
}
