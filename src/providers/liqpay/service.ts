import type {
  AuthorizePaymentInput,
  AuthorizePaymentOutput,
  BigNumberInput,
  CancelPaymentInput,
  CancelPaymentOutput,
  CapturePaymentInput,
  CapturePaymentOutput,
  DeletePaymentInput,
  DeletePaymentOutput,
  GetPaymentStatusInput,
  GetPaymentStatusOutput,
  InitiatePaymentInput,
  InitiatePaymentOutput,
  Logger,
  ProviderWebhookPayload,
  RefundPaymentInput,
  RefundPaymentOutput,
  RetrievePaymentInput,
  RetrievePaymentOutput,
  UpdatePaymentInput,
  UpdatePaymentOutput,
  WebhookActionResult,
} from "@medusajs/framework/types"
import {
  AbstractPaymentProvider,
  BigNumber,
  MedusaError,
  PaymentActions,
  PaymentSessionStatus,
  defaultCurrencies,
} from "@medusajs/framework/utils"
import {
  LIQPAY_CHECKOUT_URL,
  LIQPAY_REFUND_TIMEOUT_MS,
  LiqPayClient,
  decodeData,
  isSandboxKey,
} from "../../lib/client"
import { LIQPAY_IDENTIFIER } from "../../lib/constants"
import { invalidOption, validateKeys } from "../../lib/options"
import { LiqPaySafetyStore, ledgerDatabase } from "../../lib/safety-store"
import { parsePayload } from "../../lib/validation"
import { paidAmountMismatch, toSessionStatus, toWebhookAction } from "../../lib/status"
import type {
  LiqPayPayload,
  LiqPayProviderOptions,
  LiqPaySessionData,
} from "../../lib/types"

type InjectedDependencies = {
  logger: Logger
}

const DEFAULT_DESCRIPTION = "Order payment"
const LANGUAGES = ["uk", "en"]

/**
 * Error shown in Admin when a refund request got no answer. LiqPay's refund takes no
 * idempotency key, so a blind retry can refund twice.
 */
const REFUND_UNKNOWN =
  "LiqPay did not answer the refund request, so it is unknown whether the refund went " +
  "through. Automatic retries are blocked; reconcile the safety ledger against the LiqPay merchant cabinet."

function isAbsoluteUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "https:" || url.protocol === "http:"
  } catch {
    return false
  }
}

/**
 * LiqPay "pay" flow: the customer pays on LiqPay's hosted page and money settles at
 * once. Authorization always asks LiqPay for the live status; the browser is never
 * trusted.
 */
class LiqPayProviderService extends AbstractPaymentProvider<LiqPayProviderOptions> {
  static identifier = LIQPAY_IDENTIFIER

  protected readonly logger_: Logger
  protected readonly options_: LiqPayProviderOptions
  protected readonly client_: LiqPayClient
  protected readonly safety_: LiqPaySafetyStore
  /** A `sandbox_` key is a LiqPay sandbox merchant; its `sandbox` status then counts as paid. */
  protected readonly sandbox_: boolean

  static validateOptions(options: Record<string, unknown>): void {
    validateKeys(options, "provider")
    for (const key of ["result_url", "server_url"]) {
      if (typeof options[key] !== "string" || !isAbsoluteUrl(options[key] as string)) {
        invalidOption(`provider option "${key}" is required and must be an absolute http(s) URL`)
      }
    }
    if (options.language !== undefined && !LANGUAGES.includes(options.language as string)) {
      invalidOption(`provider option "language" must be one of: ${LANGUAGES.join(", ")}`)
    }
  }

  constructor(container: InjectedDependencies, options: LiqPayProviderOptions) {
    super(container, options)
    this.logger_ = container.logger
    this.options_ = {
      description: DEFAULT_DESCRIPTION,
      language: "uk",
      ...options,
    }
    this.sandbox_ = isSandboxKey(options.public_key)
    this.client_ = new LiqPayClient(this.options_.public_key, this.options_.private_key)
    this.safety_ = new LiqPaySafetyStore(ledgerDatabase(container), options.public_key)
  }

  private get sandbox(): boolean {
    return this.sandbox_
  }

  /** Major units rounded to the currency's digits (UAH: 2). Medusa amounts are major units. */
  private toAmount(amount: BigNumberInput, currencyCode: string): number {
    const digits = defaultCurrencies[currencyCode.toUpperCase()]?.decimal_digits ?? 2
    const value = Number(new BigNumber(amount).numeric.toFixed(digits))
    if (!Number.isFinite(value) || value <= 0) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, "LiqPay amount must be finite and positive")
    }
    return value
  }

  private readSession(data: Record<string, unknown> | undefined): LiqPaySessionData {
    const sessionId = data?.session_id
    if (typeof sessionId !== "string" || !sessionId || sessionId.length > 255) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "LiqPay payment data has no session_id"
      )
    }
    return data as LiqPaySessionData
  }

  /** Checkout form fields for one payment attempt. order_id is the Medusa session id. */
  private buildCheckout(
    sessionId: string,
    amount: number,
    currencyCode: string
  ): LiqPaySessionData {
    const { data, signature } = this.client_.envelope({
      action: "pay",
      order_id: sessionId,
      amount,
      currency: currencyCode.toUpperCase(),
      description: this.options_.description,
      result_url: this.options_.result_url,
      server_url: this.options_.server_url,
      language: this.options_.language,
      ...(this.sandbox ? { sandbox: 1 as const } : {}),
    })
    return {
      session_id: sessionId,
      currency_code: currencyCode.toLowerCase(),
      amount,
      checkout_url: LIQPAY_CHECKOUT_URL,
      checkout_data: data,
      checkout_signature: signature,
      status: "created",
      is_sandbox: this.sandbox,
      // Medusa stores `{ ...client data, ...this }`, and the Store API accepts client
      // `data`; naming every payment field here keeps a shopper from planting them.
      liqpay_payment_id: undefined,
      liqpay_order_id: undefined,
      transaction_id: undefined,
      paytype: undefined,
      sender_card_mask2: undefined,
      err_code: undefined,
      err_description: undefined,
      refunded_amount: undefined,
    }
  }

  /** Named fields from a LiqPay payload, merged over the stored session data. */
  private withPayload(session: LiqPaySessionData, payload: LiqPayPayload): LiqPaySessionData {
    return {
      ...session,
      status: payload.status ?? session.status,
      liqpay_payment_id: payload.payment_id ?? session.liqpay_payment_id,
      liqpay_order_id: payload.liqpay_order_id ?? session.liqpay_order_id,
      transaction_id: payload.transaction_id ?? session.transaction_id,
      paytype: payload.paytype ?? session.paytype,
      sender_card_mask2: payload.sender_card_mask2 ?? session.sender_card_mask2,
      err_code: payload.err_code,
      err_description: payload.err_description,
    }
  }

  /** Live status by order_id. "payment_not_found" means the customer has not paid yet. */
  private async fetchStatus(session: LiqPaySessionData): Promise<LiqPayPayload> {
    try {
      const payload = await this.client_.request({
        action: "status",
        order_id: session.session_id,
      })
      if (payload.result === "error" && payload.err_code === "payment_not_found") {
        return { status: undefined }
      }
      return payload
    } catch (error) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        (error as Error)?.message ?? "LiqPay status request failed"
      )
    }
  }

  async initiatePayment(input: InitiatePaymentInput): Promise<InitiatePaymentOutput> {
    const session = this.readSession(input.data)
    const data = this.buildCheckout(
      session.session_id,
      this.toAmount(input.amount, input.currency_code),
      input.currency_code
    )
    await this.safety_.remember(data)
    return { id: data.session_id, data, status: PaymentSessionStatus.PENDING }
  }

  /** An issued form remains usable; changing its amount requires a new attempt. */
  async updatePayment(input: UpdatePaymentInput): Promise<UpdatePaymentOutput> {
    const session = this.readSession(input.data)
    // An issued signed form cannot be revoked. Never reuse its order id for another amount.
    if (session.amount !== this.toAmount(input.amount, input.currency_code) ||
      session.currency_code !== input.currency_code.toLowerCase()) {
      throw new MedusaError(MedusaError.Types.NOT_ALLOWED,
        "Create a new LiqPay payment attempt after changing the cart amount or currency")
    }
    const data = this.buildCheckout(
      session.session_id,
      this.toAmount(input.amount, input.currency_code),
      input.currency_code
    )
    return { data: { ...data, ...session }, status: toSessionStatus(session.status, this.sandbox) }
  }

  /**
   * Called on cart completion (browser return) and by the webhook flow. Asks LiqPay for
   * the live status, so it is idempotent and never trusts the browser.
   */
  async authorizePayment(input: AuthorizePaymentInput): Promise<AuthorizePaymentOutput> {
    const session = this.readSession(input.data)
    const payload = await this.fetchStatus(session)
    if (await this.safety_.observe(session.session_id, payload)) {
      throw new MedusaError(MedusaError.Types.NOT_ALLOWED, "Retired LiqPay attempt needs reconciliation")
    }
    return this.checkedStatus(session, payload)
  }

  /**
   * Session status and data for a live payload. A paid payment whose amount or currency
   * differs from the signed session is an error, so the cart is not completed on it;
   * the log says to refund it.
   */
  private checkedStatus(
    session: LiqPaySessionData,
    payload: LiqPayPayload
  ): { status: PaymentSessionStatus; data: LiqPaySessionData } {
    const status = payload.result === "error" ? PaymentSessionStatus.ERROR :
      toSessionStatus(payload.status, this.sandbox)
    const data = this.withPayload(session, payload)
    const settled =
      status === PaymentSessionStatus.CAPTURED || status === PaymentSessionStatus.AUTHORIZED
    const mismatch = settled ? paidAmountMismatch(session, payload) : null
    if (!mismatch) {
      return { status, data }
    }
    this.logger_.error(
      `LiqPay: session ${session.session_id} ${mismatch}; not accepted. Check the payment in the LiqPay cabinet and refund it there.`
    )
    return {
      status: PaymentSessionStatus.ERROR,
      data: { ...data, err_code: "amount_mismatch", err_description: mismatch },
    }
  }

  /** Verify settlement before recording a local capture; holds are unsupported. */
  async capturePayment(input: CapturePaymentInput): Promise<CapturePaymentOutput> {
    const session = this.readSession(input.data)
    const checked = this.checkedStatus(session, await this.fetchStatus(session))
    if (checked.status !== PaymentSessionStatus.CAPTURED) {
      throw new MedusaError(MedusaError.Types.NOT_ALLOWED, "LiqPay payment is not confirmed settled")
    }
    return { data: checked.data }
  }

  /**
   * Only reached for a payment that is not captured. A paid LiqPay payment cannot be
   * cancelled, only refunded, so this logs it instead of refunding silently.
   */
  async cancelPayment(input: CancelPaymentInput): Promise<CancelPaymentOutput> {
    const status = input.data?.status
    if (status === "success" || status === "sandbox") {
      this.logger_.warn(
        `LiqPay: cancel requested for paid session ${String(input.data?.session_id)}; refund it from Admin`
      )
    }
    return { data: input.data }
  }

  /**
   * Medusa deletes a session when the cart total changes or a new attempt replaces it.
   * This never refuses: Medusa logs a provider error here and keeps the old session,
   * which still carries its old amount and stays payable, so a refusal would let the
   * cart complete against a stale amount (or block completion with the new session).
   * A signed form cannot be revoked, so the attempt is retired in the safety ledger
   * instead: a late payment on it is recorded for review and never completes a cart.
   */
  async deletePayment(input: DeletePaymentInput): Promise<DeletePaymentOutput> {
    const sessionId = input.data?.session_id
    if (typeof sessionId !== "string" || !sessionId) {
      // Medusa's cleanup after a failed session creation passes data without session_id;
      // no form reached the customer then.
      return { data: input.data }
    }
    try {
      await this.safety_.retire(this.readSession(input.data))
    } catch (error) {
      this.logger_.error(
        `LiqPay: could not retire attempt ${sessionId} in the safety ledger: ${(error as Error)?.message}. ` +
        "A late payment on it will not complete an order; check it in the LiqPay cabinet and reconcile it by hand."
      )
    }
    return { data: input.data }
  }

  async refundPayment(input: RefundPaymentInput): Promise<RefundPaymentOutput> {
    const session = this.readSession(input.data)
    if (!session.currency_code) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "LiqPay payment data has no currency_code"
      )
    }
    const amount = this.toAmount(input.amount, session.currency_code)
    const operationId = input.context?.idempotency_key
    if (typeof operationId !== "string" || !operationId || operationId.length > 255) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, "Refund requires an idempotency key")
    }
    const baseline = session.refunded_amount ?? 0
    if (!Number.isFinite(baseline) || baseline < 0) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, "Invalid stored refunded amount")
    }
    const previous = await this.safety_.beginRefund(session.session_id, operationId, amount, baseline)
    if (previous) {
      return { data: { ...this.withPayload(session, previous.response ?? {}),
        refunded_amount: await this.safety_.refundedTotal(session.session_id) } }
    }
    let payload: LiqPayPayload
    try {
      payload = await this.client_.request(
        { action: "refund", order_id: session.session_id, amount },
        LIQPAY_REFUND_TIMEOUT_MS
      )
    } catch (error) {
      await this.safety_.finishRefund(session.session_id, operationId, "unknown")
      this.logger_.error(
        `LiqPay: refund of ${amount} for session ${session.session_id} got no answer: ${(error as Error)?.message}`
      )
      throw new MedusaError(MedusaError.Types.UNEXPECTED_STATE, REFUND_UNKNOWN)
    }
    if (payload.result === "error" && payload.err_code &&
      (!payload.status || ["error", "failure"].includes(payload.status))) {
      await this.safety_.finishRefund(session.session_id, operationId, "failed", payload)
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `LiqPay refund failed: ${payload.err_description ?? payload.err_code ?? "unknown error"}`
      )
    }
    if (payload.result !== "ok" || payload.status !== "reversed" || payload.wait_amount === true) {
      await this.safety_.finishRefund(session.session_id, operationId, "unknown", payload)
      throw new MedusaError(MedusaError.Types.UNEXPECTED_STATE,
        "LiqPay refund is not confirmed. Reconcile this operation; automatic retries are blocked")
    }
    await this.safety_.finishRefund(session.session_id, operationId, "succeeded", payload)
    const data = this.withPayload(session, payload)
    return {
      data: { ...data, refunded_amount: await this.safety_.refundedTotal(session.session_id) },
    }
  }

  async retrievePayment(input: RetrievePaymentInput): Promise<RetrievePaymentOutput> {
    const session = this.readSession(input.data)
    const payload = await this.fetchStatus(session)
    return { data: this.withPayload(session, payload) }
  }

  async getPaymentStatus(input: GetPaymentStatusInput): Promise<GetPaymentStatusOutput> {
    try {
      const session = this.readSession(input.data)
      const payload = await this.fetchStatus(session)
      return this.checkedStatus(session, payload)
    } catch (error) {
      this.logger_.warn(
        `LiqPay: status lookup failed, reporting pending: ${(error as Error)?.message}`
      )
      return { status: PaymentSessionStatus.PENDING }
    }
  }

  /**
   * server_url callback: a form POST of `data` + `signature`. Invalid input is ignored.
   * Ledger failures throw so the event bus retries without losing recovery evidence.
   */
  async getWebhookActionAndData(
    payload: ProviderWebhookPayload["payload"]
  ): Promise<WebhookActionResult> {
    const body = payload.data as Record<string, unknown> | undefined
    const data = body?.data
    const signature = body?.signature
    if (typeof data !== "string" || typeof signature !== "string" ||
      data.length > 65536 || signature.length > 128) {
      return { action: PaymentActions.NOT_SUPPORTED }
    }
    if (!this.client_.verify({ data, signature })) {
      this.logger_.warn("LiqPay: callback with an invalid signature")
      return { action: PaymentActions.FAILED }
    }

    let callback: LiqPayPayload
    try {
      callback = parsePayload(decodeData(data.replace(/ /g, "+")))
    } catch {
      return { action: PaymentActions.NOT_SUPPORTED }
    }
    if (!callback.order_id || typeof callback.amount !== "number" || callback.amount <= 0 ||
      (callback.public_key && callback.public_key !== this.options_.public_key)) {
      return { action: PaymentActions.NOT_SUPPORTED }
    }

    // Throw on ledger failure so the event worker retries instead of losing a late payment.
    if (await this.safety_.observe(callback.order_id, callback)) {
      this.logger_.error(`LiqPay: retired attempt ${callback.order_id} received ${callback.status}; reconcile the safety ledger`)
      return { action: PaymentActions.NOT_SUPPORTED }
    }

    return {
      action: toWebhookAction(callback.status, this.sandbox),
      data: {
        session_id: callback.order_id,
        amount: new BigNumber(callback.amount),
      },
    }
  }
}

export default LiqPayProviderService
