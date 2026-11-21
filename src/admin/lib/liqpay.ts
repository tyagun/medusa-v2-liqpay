// Helpers for the order-page LiqPay widget. LiqPay codes come from its API v3 (status,
// paytype); unknown codes are shown raw so nothing is hidden from the admin.

import type { LiqPayLiveStatus } from "../../lib/live-status"
import type { AttemptForReview, LiqPayReviewList, LiqPaySessionData } from "../../lib/types"

// Server types, imported type-only: Vite strips these imports, and both sides stay in sync.
export type { LiqPayLiveStatus, LiqPayReviewList }
export type ReviewAttempt = AttemptForReview
export { LIQPAY_PROVIDER_ID_PREFIX } from "../../lib/constants"

export type BadgeColor = "green" | "red" | "orange" | "blue" | "grey"

const STATUS_COLOR: Record<string, BadgeColor> = {
  created: "grey",
  success: "green",
  sandbox: "green",
  failure: "red",
  error: "red",
  reversed: "orange",
  processing: "blue",
  prepared: "grey",
  hold_wait: "blue",
  wait_accept: "orange",
  wait_secure: "blue",
}

/** Translation key (under `status.`) and badge colour for a LiqPay status. */
export function statusInfo(status: string | null | undefined): {
  key: string
  raw: string | null
  color: BadgeColor
} {
  if (!status) {
    return { key: "status.unknown", raw: null, color: "grey" }
  }
  if (STATUS_COLOR[status]) {
    return { key: `status.${status}`, raw: status, color: STATUS_COLOR[status] }
  }
  if (status.endsWith("_verify")) {
    return { key: "status.verify", raw: status, color: "blue" }
  }
  return { key: `status.${status}`, raw: status, color: "grey" }
}

export function formatMoney(amount: number, currency: string, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(amount)
}

export function formatDateTime(value: number | string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value))
}

/** The payment `data` the LiqPay provider persists, as Admin reads it (any field may be missing). */
export type StoredLiqPayData = Partial<Omit<LiqPaySessionData,
  "checkout_url" | "checkout_data" | "checkout_signature">>
