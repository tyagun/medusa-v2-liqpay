import { PaymentActions, PaymentSessionStatus } from "@medusajs/framework/utils"

const FAILED = new Set(["failure", "error"])

/** Customer action outstanding at LiqPay (3-D Secure, OTP and the other *_verify steps). */
function isVerifyStep(status: string): boolean {
  return status.endsWith("_verify")
}

/**
 * "sandbox" is LiqPay's success status for sandbox merchants. It counts as paid only when
 * the provider runs in sandbox mode, so a production store never accepts a test payment.
 */
function isPaid(status: string, sandbox: boolean): boolean {
  return status === "success" || (sandbox && status === "sandbox")
}

/** Session status for authorizePayment / getPaymentStatus. Action "pay" settles at once. */
export function toSessionStatus(
  status: string | undefined,
  sandbox: boolean
): PaymentSessionStatus {
  if (!status) {
    return PaymentSessionStatus.PENDING
  }
  if (isPaid(status, sandbox)) {
    return PaymentSessionStatus.CAPTURED
  }
  if (status === "sandbox" || FAILED.has(status)) {
    return PaymentSessionStatus.ERROR
  }
  if (status === "hold_wait") {
    return PaymentSessionStatus.ERROR
  }
  if (status === "reversed") {
    return PaymentSessionStatus.CANCELED
  }
  if (isVerifyStep(status)) {
    return PaymentSessionStatus.REQUIRES_MORE
  }
  return PaymentSessionStatus.PENDING
}

/**
 * Webhook action for a callback status. One action per transition: success settles,
 * failure fails. "reversed" (a refund we started from Admin) changes nothing in Medusa.
 */
export function toWebhookAction(
  status: string | undefined,
  sandbox: boolean
): PaymentActions {
  if (!status) {
    return PaymentActions.NOT_SUPPORTED
  }
  if (isPaid(status, sandbox)) {
    return PaymentActions.SUCCESSFUL
  }
  if (status === "sandbox" || FAILED.has(status)) {
    return PaymentActions.FAILED
  }
  if (status === "hold_wait") {
    return PaymentActions.NOT_SUPPORTED
  }
  if (status === "reversed") {
    return PaymentActions.NOT_SUPPORTED
  }
  if (isVerifyStep(status)) {
    return PaymentActions.REQUIRES_MORE
  }
  return PaymentActions.PENDING
}

/**
 * Why a paid LiqPay payment does not match the session we signed, or `null` when it
 * does (defence in depth). A paid payload without `amount` or `currency` counts as a
 * mismatch: LiqPay always sends both.
 */
export function paidAmountMismatch(
  session: { amount?: number; currency_code?: string },
  payload: { amount?: number; currency?: string }
): string | null {
  const expected = `${session.amount} ${session.currency_code?.toUpperCase()}`
  const got = `${payload.amount} ${payload.currency?.toUpperCase()}`
  const sameCurrency =
    !!payload.currency &&
    !!session.currency_code &&
    payload.currency.toLowerCase() === session.currency_code.toLowerCase()
  // Both sides are major units rounded to kopiyky; half a kopiyka absorbs float noise.
  const sameAmount =
    typeof payload.amount === "number" &&
    typeof session.amount === "number" &&
    Math.abs(payload.amount - session.amount) < 0.005
  return sameCurrency && sameAmount ? null : `paid ${got}, expected ${expected}`
}
