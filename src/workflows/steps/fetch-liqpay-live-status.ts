import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils"
import { StepResponse, createStep } from "@medusajs/framework/workflows-sdk"
import { LIQPAY_MODULE, isLiqPayProviderId } from "../../lib/constants"
import { toLiveStatus } from "../../lib/live-status"
import type LiqPayModuleService from "../../modules/liqpay/service"

export type FetchLiqpayLiveStatusStepInput = {
  payment_id: string
}

/**
 * Asks LiqPay for the live status of one Medusa payment. Read-only: the stored payment
 * data is not changed, so Admin can compare what was saved with what LiqPay says now.
 */
export const fetchLiqpayLiveStatusStep = createStep(
  "fetch-liqpay-live-status",
  async (input: FetchLiqpayLiveStatusStepInput, { container }) => {
    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const {
      data: [payment],
    } = await query.graph({
      entity: "payment",
      fields: ["id", "provider_id", "data"],
      filters: { id: input.payment_id },
    })

    if (!payment) {
      throw new MedusaError(MedusaError.Types.NOT_FOUND, `Payment ${input.payment_id} was not found`)
    }
    if (!isLiqPayProviderId(payment.provider_id)) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Payment ${input.payment_id} was not made through LiqPay`
      )
    }
    const orderId = (payment.data as Record<string, unknown> | null)?.session_id
    if (typeof orderId !== "string" || !orderId) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Payment ${input.payment_id} has no LiqPay order id`
      )
    }

    const liqpay = container.resolve<LiqPayModuleService>(LIQPAY_MODULE)
    const payload = await liqpay.getStatus(orderId)
    return new StepResponse(toLiveStatus(payload, new Date()))
  }
)
