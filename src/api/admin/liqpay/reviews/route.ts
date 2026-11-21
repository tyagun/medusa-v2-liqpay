import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { LIQPAY_MODULE } from "../../../../lib/constants"
import type LiqPayModuleService from "../../../../modules/liqpay/service"

/**
 * GET /admin/liqpay/reviews → `{ attempts, refunds }`: replaced checkout attempts where
 * LiqPay shows money may have moved, and refunds whose outcome is unknown.
 */
export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const liqpay = req.scope.resolve<LiqPayModuleService>(LIQPAY_MODULE)
  res.json(await liqpay.listForReview())
}
