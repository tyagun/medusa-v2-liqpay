import type { LiqPayPayload } from "./types"

/**
 * What the Admin LiqPay widget shows after "Check status": named fields from a
 * LiqPay `status` response, never the raw payload (it carries the public key and
 * commission details an admin does not need).
 */
export type LiqPayLiveStatus = {
  /** False when LiqPay has no payment for this order_id (the customer never paid). */
  found: boolean
  status: string | null
  err_code: string | null
  err_description: string | null
  payment_id: number | null
  transaction_id: number | null
  liqpay_order_id: string | null
  paytype: string | null
  sender_card_mask2: string | null
  amount: number | null
  currency: string | null
  /** Milliseconds since epoch, as LiqPay sends them. */
  create_date: number | null
  end_date: number | null
  checked_at: string
}

export function toLiveStatus(payload: LiqPayPayload, checkedAt: Date): LiqPayLiveStatus {
  const notFound = payload.result === "error" && payload.err_code === "payment_not_found"
  return {
    found: !notFound,
    status: notFound ? null : payload.status ?? null,
    err_code: payload.err_code ?? null,
    err_description: payload.err_description ?? null,
    payment_id: payload.payment_id ?? null,
    transaction_id: payload.transaction_id ?? null,
    liqpay_order_id: payload.liqpay_order_id ?? null,
    paytype: payload.paytype ?? null,
    sender_card_mask2: payload.sender_card_mask2 ?? null,
    amount: payload.amount ?? null,
    currency: payload.currency ?? null,
    create_date: payload.create_date ?? null,
    end_date: payload.end_date ?? null,
    checked_at: checkedAt.toISOString(),
  }
}
