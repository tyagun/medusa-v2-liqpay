import type { MedusaResponse } from "@medusajs/framework/http"
import { isLiqPayBusyError } from "../modules/liqpay/service"

/** Runs a status handler; answers 503 with Retry-After when the lookup limit is reached. */
export async function withBusyAnswer(res: MedusaResponse, handler: () => Promise<void>) {
  try {
    await handler()
  } catch (error) {
    if (!isLiqPayBusyError(error)) throw error
    res.setHeader("Retry-After", "1")
    res.status(503).json({ message: "LiqPay status service is busy; retry shortly" })
  }
}
