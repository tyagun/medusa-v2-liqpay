import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { getCartLiqpayOutcomeWorkflow } from "../../../../../../workflows/get-cart-liqpay-outcome"
import { withBusyAnswer } from "../../../../../busy"

/**
 * GET /store/liqpay/carts/:id/status → `{ outcome, completed }` for the cart's newest
 * LiqPay session. The storefront's return page calls it when cart completion fails, to
 * tell "declined" from "still processing" from "never paid". 503 when busy.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  await withBusyAnswer(res, async () => {
    const { result } = await getCartLiqpayOutcomeWorkflow(req.scope).run({
      input: { cart_id: req.params.id },
    })
    res.json(result)
  })
}
