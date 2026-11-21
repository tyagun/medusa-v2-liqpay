import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { getLiqpayLiveStatusWorkflow } from "../../../../../../workflows/get-liqpay-live-status"
import { withBusyAnswer } from "../../../../../busy"

/** GET /admin/liqpay/payments/:id/status → LiqPay's live status for a Medusa payment. */
export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  await withBusyAnswer(res, async () => {
    const { result } = await getLiqpayLiveStatusWorkflow(req.scope).run({
      input: { payment_id: req.params.id },
    })
    res.json({ liqpay_status: result })
  })
}
