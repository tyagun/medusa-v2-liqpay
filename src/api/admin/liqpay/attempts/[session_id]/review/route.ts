import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { markLiqpayAttemptReviewedWorkflow } from "../../../../../../workflows/mark-liqpay-attempt-reviewed"

export type MarkReviewedBody = { note: string }

/**
 * POST /admin/liqpay/attempts/:session_id/review `{ note }` → clears the attempt's review
 * flag and records the admin user and the note. A later payment on it flags it again.
 */
export async function POST(req: AuthenticatedMedusaRequest<MarkReviewedBody>, res: MedusaResponse) {
  await markLiqpayAttemptReviewedWorkflow(req.scope).run({
    input: {
      session_id: req.params.session_id,
      actor: req.auth_context.actor_id,
      note: req.validatedBody.note,
    },
  })
  res.json({ session_id: req.params.session_id, reviewed: true })
}
