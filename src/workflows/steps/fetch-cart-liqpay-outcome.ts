import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils"
import { StepResponse, createStep } from "@medusajs/framework/workflows-sdk"
import { LIQPAY_MODULE, isLiqPayProviderId } from "../../lib/constants"
import { type LiqPayCheckoutOutcome, toCheckoutOutcome } from "../../lib/outcome"
import type { LiqPaySessionData } from "../../lib/types"
import type LiqPayModuleService from "../../modules/liqpay/service"

export type FetchCartLiqpayOutcomeStepInput = {
  cart_id: string
}

export type CartLiqpayOutcome = {
  /** `none` when the cart has no LiqPay session (nothing was started). */
  outcome: LiqPayCheckoutOutcome | "none"
  completed: boolean
}

type Session = {
  id: string
  provider_id: string
  created_at: string | Date
  data: Record<string, unknown> | null
}

/**
 * Live LiqPay outcome of a cart's newest LiqPay session. Read-only, and it returns only
 * the coarse outcome: the route is public and keyed by a cart id, so no payment details
 * leave the server.
 */
export const fetchCartLiqpayOutcomeStep = createStep(
  "fetch-cart-liqpay-outcome",
  async (input: FetchCartLiqpayOutcomeStepInput, { container }) => {
    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const {
      data: [cart],
    } = await query.graph({
      entity: "cart",
      fields: [
        "id",
        "completed_at",
        "payment_collection.payment_sessions.id",
        "payment_collection.payment_sessions.provider_id",
        "payment_collection.payment_sessions.created_at",
        "payment_collection.payment_sessions.data",
      ],
      filters: { id: input.cart_id },
    })

    if (!cart) {
      throw new MedusaError(MedusaError.Types.NOT_FOUND, `Cart ${input.cart_id} was not found`)
    }

    const completed = Boolean(cart.completed_at)
    const sessions = ((cart.payment_collection?.payment_sessions ?? []) as Session[])
      .filter((s) => isLiqPayProviderId(s?.provider_id))
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    const newest = sessions[0]
    const orderId = newest?.data?.session_id

    if (typeof orderId !== "string" || !orderId) {
      return new StepResponse<CartLiqpayOutcome>({ outcome: "none", completed })
    }

    const liqpay = container.resolve<LiqPayModuleService>(LIQPAY_MODULE)
    const payload = await liqpay.getStatus(orderId)
    return new StepResponse<CartLiqpayOutcome>({
      outcome: toCheckoutOutcome(
        payload,
        liqpay.isSandbox(),
        newest.data as unknown as LiqPaySessionData
      ),
      completed,
    })
  }
)
