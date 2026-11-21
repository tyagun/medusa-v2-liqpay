import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { LIQPAY_MODULE } from "../lib/constants"
import type LiqPayModuleService from "../modules/liqpay/service"

/**
 * Replaced checkout attempts keep a payable signed form. Callbacks are the main signal
 * of a late payment; this job asks LiqPay directly, so a lost callback cannot hide one.
 */
export default async function recheckLiqpayAttempts(container: MedusaContainer) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const liqpay = container.resolve<LiqPayModuleService>(LIQPAY_MODULE)
  const { flagged } = await liqpay.recheckRetiredAttempts()
  for (const sessionId of flagged) {
    logger.error(
      `LiqPay: replaced attempt ${sessionId} shows a payment; review it in Admin → Settings → LiqPay`
    )
  }
}

export const config = {
  name: "recheck-liqpay-attempts",
  schedule: "*/15 * * * *",
}
