import { WorkflowResponse, createWorkflow } from "@medusajs/framework/workflows-sdk"
import {
  type FetchLiqpayLiveStatusStepInput,
  fetchLiqpayLiveStatusStep,
} from "./steps/fetch-liqpay-live-status"

/** Live LiqPay status for a payment; backs the Admin widget's "Check status". */
export const getLiqpayLiveStatusWorkflow = createWorkflow(
  "get-liqpay-live-status",
  function (input: FetchLiqpayLiveStatusStepInput) {
    const liveStatus = fetchLiqpayLiveStatusStep(input)
    return new WorkflowResponse(liveStatus)
  }
)
