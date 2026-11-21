import type { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils"
import { LIQPAY_MODULE } from "../lib/constants"
import type LiqPayModuleService from "../modules/liqpay/service"

const USAGE =
  "Usage: npx medusa exec ./node_modules/medusa-plugin-liqpay/.medusa/server/src/scripts/reconcile-refund.js " +
  "SESSION_ID OPERATION_ID succeeded|failed ACTOR EVIDENCE workers-stopped"

/**
 * Offline reconciliation of an uncertain LiqPay refund. Records the operator's verified
 * outcome in the safety ledger and NEVER sends anything to LiqPay. The last argument,
 * `workers-stopped`, confirms that no process that could still resume the refund is running.
 * Runs inside the host app (`medusa exec`), so it uses the same database and merchant
 * keys as the plugin entry.
 */
export default async function reconcileRefund({ container, args }: ExecArgs) {
  const [sessionId, operationId, outcome, actor, evidence, acknowledgement] = args ?? []
  if (!sessionId || !operationId || (outcome !== "succeeded" && outcome !== "failed") ||
    !actor || !evidence || acknowledgement !== "workers-stopped") {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, USAGE)
  }
  const liqpay = container.resolve<LiqPayModuleService>(LIQPAY_MODULE)
  await liqpay.resolveRefund(sessionId, operationId, outcome, actor, evidence)
  container.resolve(ContainerRegistrationKeys.LOGGER)
    .info("LiqPay: refund resolution recorded. No request was sent to LiqPay.")
}
