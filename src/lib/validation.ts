import { MedusaError } from "@medusajs/framework/utils"
import type { LiqPayPayload } from "./types"

/** Reject malformed known fields; drop unknown fields instead of persisting them. */
export function parsePayload(value: unknown): LiqPayPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MedusaError(MedusaError.Types.UNEXPECTED_STATE, "Invalid LiqPay payload")
  }
  const input = value as Record<string, unknown>
  const result: Record<string, unknown> = {}
  if (input.wait_amount !== undefined) {
    if (![true, false, "true", "false"].includes(input.wait_amount as boolean | string)) {
      throw new MedusaError(MedusaError.Types.UNEXPECTED_STATE, "Invalid LiqPay wait_amount")
    }
    result.wait_amount = input.wait_amount === true || input.wait_amount === "true"
  }
  for (const field of ["result", "status", "err_code", "err_description", "public_key",
    "order_id", "liqpay_order_id", "paytype", "sender_card_mask2", "currency"]) {
    if (input[field] === undefined) continue
    if (typeof input[field] !== "string" || !(input[field] as string).length ||
      (input[field] as string).length > (field === "err_description" ? 2048 : 255)) {
      throw new MedusaError(MedusaError.Types.UNEXPECTED_STATE, `Invalid LiqPay ${field}`)
    }
    result[field] = input[field]
  }
  for (const field of ["amount", "payment_id", "transaction_id", "create_date", "end_date"]) {
    if (input[field] === undefined) continue
    const raw = input[field]
    // LiqPay's documented examples sometimes encode numeric fields as decimal strings.
    const number = typeof raw === "string" && /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw
    if (typeof number !== "number" || !Number.isFinite(number) || number < 0 ||
      (field !== "amount" && !Number.isSafeInteger(number))) throw new MedusaError(MedusaError.Types.UNEXPECTED_STATE, `Invalid LiqPay ${field}`)
    result[field] = number
  }
  if (result.result !== undefined && result.result !== "ok" && result.result !== "error") {
    throw new MedusaError(MedusaError.Types.UNEXPECTED_STATE, "Invalid LiqPay result")
  }
  if (result.currency !== undefined && !/^[a-zA-Z]{3}$/.test(result.currency as string)) {
    throw new MedusaError(MedusaError.Types.UNEXPECTED_STATE, "Invalid LiqPay currency")
  }
  return result as LiqPayPayload
}
