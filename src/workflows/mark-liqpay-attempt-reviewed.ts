import { WorkflowResponse, createWorkflow } from "@medusajs/framework/workflows-sdk"
import {
  type MarkLiqpayAttemptReviewedStepInput,
  markLiqpayAttemptReviewedStep,
} from "./steps/mark-liqpay-attempt-reviewed"

/** Records an admin's review of a replaced LiqPay attempt; backs Settings → LiqPay. */
export const markLiqpayAttemptReviewedWorkflow = createWorkflow(
  "mark-liqpay-attempt-reviewed",
  function (input: MarkLiqpayAttemptReviewedStepInput) {
    const result = markLiqpayAttemptReviewedStep(input)
    return new WorkflowResponse(result)
  }
)
