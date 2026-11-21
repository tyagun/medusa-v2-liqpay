/** Registration name of the plugin's `liqpay` module in the Medusa container. */
export const LIQPAY_MODULE = "liqpay"

/** The provider's `static identifier`. */
export const LIQPAY_IDENTIFIER = "liqpay"

/**
 * Medusa registers a payment provider as `pp_<identifier>_<id>`, where `id` is the one
 * given in medusa-config. Every LiqPay provider id starts with this prefix.
 */
export const LIQPAY_PROVIDER_ID_PREFIX = `pp_${LIQPAY_IDENTIFIER}_`

export function isLiqPayProviderId(providerId: unknown): boolean {
  return typeof providerId === "string" && providerId.startsWith(LIQPAY_PROVIDER_ID_PREFIX)
}
