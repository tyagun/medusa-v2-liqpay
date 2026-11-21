import { WorkflowResponse, createWorkflow } from "@medusajs/framework/workflows-sdk"
import {
  type FetchCartLiqpayOutcomeStepInput,
  fetchCartLiqpayOutcomeStep,
} from "./steps/fetch-cart-liqpay-outcome"

/** LiqPay outcome of a cart's payment attempt; backs the storefront's return page. */
export const getCartLiqpayOutcomeWorkflow = createWorkflow(
  "get-cart-liqpay-outcome",
  function (input: FetchCartLiqpayOutcomeStepInput) {
    const outcome = fetchCartLiqpayOutcomeStep(input)
    return new WorkflowResponse(outcome)
  }
)
