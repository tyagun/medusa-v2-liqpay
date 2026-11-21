import { paidAmountMismatch } from "./status"
import type { LiqPayPayload, LiqPaySessionData } from "./types"

/**
 * What the storefront's return route needs after a LiqPay attempt that did not complete
 * the cart:
 * - `paid`: LiqPay settled it; completing the cart again will succeed (or the callback has).
 * - `pending`: LiqPay is still processing or waits on the customer (3-D Secure, OTP).
 * - `failed`: a terminal payment failure or reversal.
 * - `needs_review`: a paid mismatch or unsupported hold; do not ask the customer to pay again.
 * - `not_paid`: LiqPay has no payment for this session (the customer left before paying).
 */
export type LiqPayCheckoutOutcome = "paid" | "pending" | "failed" | "not_paid" | "needs_review"

const FAILED = new Set(["failure", "error", "reversed"])

export function toCheckoutOutcome(
  payload: LiqPayPayload,
  sandbox: boolean,
  session: Pick<LiqPaySessionData, "amount" | "currency_code">
): LiqPayCheckoutOutcome {
  if (payload.result === "error" && payload.err_code === "payment_not_found") {
    return "not_paid"
  }
  const status = payload.status
  if (!status) {
    return "pending"
  }
  if (payload.result === "error") return "pending"
  if (status === "success" || (sandbox && status === "sandbox")) {
    return paidAmountMismatch(session, payload) ? "needs_review" : "paid"
  }
  if (status === "hold_wait") return "needs_review"
  if (status === "sandbox" || FAILED.has(status)) {
    return "failed"
  }
  return "pending"
}
