import { StepResponse, createStep } from "@medusajs/framework/workflows-sdk"
import { LIQPAY_MODULE } from "../../lib/constants"
import type LiqPayModuleService from "../../modules/liqpay/service"

export type MarkLiqpayAttemptReviewedStepInput = {
  session_id: string
  actor: string
  note: string
}

/**
 * Clears a retired attempt's review flag. No compensation: the review is evidence of
 * an operator's decision and is kept even if a later step fails.
 */
export const markLiqpayAttemptReviewedStep = createStep(
  "mark-liqpay-attempt-reviewed",
  async (input: MarkLiqpayAttemptReviewedStepInput, { container }) => {
    const liqpay = container.resolve<LiqPayModuleService>(LIQPAY_MODULE)
    await liqpay.markAttemptReviewed(input.session_id, input.actor, input.note)
    return new StepResponse({ session_id: input.session_id })
  }
)
