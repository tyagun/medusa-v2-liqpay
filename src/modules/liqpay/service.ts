import { MedusaError } from "@medusajs/framework/utils"
import { LiqPayClient, isSandboxKey } from "../../lib/client"
import { invalidOption, validateInteger, validateKeys } from "../../lib/options"
import { RequestLimit } from "../../lib/request-limit"
import { LiqPaySafetyStore, ledgerDatabase } from "../../lib/safety-store"
import type {
  AttemptForReview,
  LiqPayModuleOptions,
  LiqPayPayload,
  LiqPayRateLimits,
  RefundForReview,
} from "../../lib/types"

const DEFAULT_STATUS_CONCURRENCY = 16
const STATUS_CACHE_MS = 5000
const STATUS_CACHE_SIZE = 1024
const DEFAULT_RECHECK_BATCH = 50
/** Recheck lookups in flight at once; the job runs every 15 minutes, so this stays low. */
const RECHECK_CONCURRENCY = 4
const RATE_WINDOW_MS = 60_000

const DEFAULT_RATE_LIMITS: Required<LiqPayRateLimits> = {
  status_per_cart: 60,
  sessions_per_collection: 10,
  callbacks_per_ip: 300,
}

/** What a middleware limit is keyed by: a cart, a payment collection, or a callback's IP. */
export type LiqPayRequestKind = "status" | "session" | "callback"

/** Error code of a status lookup refused because the per-process limit is reached. */
export const LIQPAY_BUSY = "liqpay_busy"
const BUSY_MESSAGE = "LiqPay status service is busy; retry later"

/** True for the busy refusal, also after a workflow passed the error on. */
export function isLiqPayBusyError(error: unknown): boolean {
  const value = error as { code?: unknown; message?: unknown } | undefined
  return value?.code === LIQPAY_BUSY || value?.message === BUSY_MESSAGE
}

/**
 * Throws on options the module cannot work with. Runs at start-up through the module
 * loader, so a misconfigured plugin fails on boot instead of on the first request.
 */
export function validateModuleOptions(options: Partial<LiqPayModuleOptions> | undefined): void {
  validateKeys(options, "plugin")
  validateInteger(options?.status_concurrency, "status_concurrency", 1, 256)
  validateInteger(options?.recheck_batch_size, "recheck_batch_size", 1, 1000)
  const limits = options?.rate_limits
  if (limits === undefined || limits === false) return
  if (typeof limits !== "object" || limits === null) {
    invalidOption('option "rate_limits" must be an object or false')
  }
  for (const key of Object.keys(DEFAULT_RATE_LIMITS) as (keyof LiqPayRateLimits)[]) {
    validateInteger(limits[key], `rate_limits.${key}`, 1, 100_000)
  }
}

/**
 * LiqPay access for the plugin's API routes, workflows and jobs. A payment provider
 * lives inside the Payment Module's own container, so code elsewhere cannot reach it;
 * this module holds the same merchant keys for status lookups and the safety ledger.
 */
export default class LiqPayModuleService {
  protected readonly client_: LiqPayClient
  protected readonly sandbox_: boolean
  protected readonly ledger_: LiqPaySafetyStore
  private readonly concurrency: number
  private readonly recheckBatch: number
  private readonly limits: Record<LiqPayRequestKind, RequestLimit> | null
  private readonly statuses = new Map<string, { expires: number; result: Promise<LiqPayPayload> }>()
  private active = 0

  constructor(container: Record<string, unknown>, options: LiqPayModuleOptions) {
    validateModuleOptions(options)
    this.client_ = new LiqPayClient(options.public_key, options.private_key)
    this.sandbox_ = isSandboxKey(options.public_key)
    this.concurrency = options.status_concurrency ?? DEFAULT_STATUS_CONCURRENCY
    this.recheckBatch = options.recheck_batch_size ?? DEFAULT_RECHECK_BATCH
    const limits = options.rate_limits === false ? null :
      { ...DEFAULT_RATE_LIMITS, ...options.rate_limits }
    this.limits = limits && {
      status: new RequestLimit(limits.status_per_cart, RATE_WINDOW_MS),
      session: new RequestLimit(limits.sessions_per_collection, RATE_WINDOW_MS),
      callback: new RequestLimit(limits.callbacks_per_ip, RATE_WINDOW_MS),
    }
    this.ledger_ = new LiqPaySafetyStore(ledgerDatabase(container), options.public_key)
  }

  /**
   * Admission check for the plugin's middleware. Always true when `rate_limits: false`.
   * Process-local: put cluster-wide limits on your gateway.
   */
  allowRequest(kind: LiqPayRequestKind, key: string): boolean {
    return this.limits?.[kind].allow(key) ?? true
  }

  /** True for a sandbox merchant (`sandbox_` key): LiqPay's `sandbox` status then counts as paid. */
  isSandbox(): boolean {
    return this.sandbox_
  }

  verifyCallback(body: unknown): boolean {
    if (!body || typeof body !== "object") return false
    const { data, signature } = body as Record<string, unknown>
    return typeof data === "string" && data.length <= 65536 &&
      typeof signature === "string" && signature.length <= 128 &&
      this.client_.verify({ data, signature })
  }

  /**
   * LiqPay's raw `status` answer for an order_id (the Medusa payment session id).
   * Concurrent lookups of one order share a request, answers are cached briefly, and
   * at most `status_concurrency` requests run at once; beyond that it refuses at once
   * (`isLiqPayBusyError`) instead of queueing unbounded work.
   */
  async getStatus(orderId: string): Promise<LiqPayPayload> {
    const now = Date.now()
    const cached = this.statuses.get(orderId)
    if (cached && cached.expires > now) return cached.result
    for (const [key, entry] of this.statuses) {
      if (entry.expires <= now) this.statuses.delete(key)
    }
    if (this.active >= this.concurrency || this.statuses.size >= STATUS_CACHE_SIZE) {
      throw new MedusaError(MedusaError.Types.NOT_ALLOWED, BUSY_MESSAGE, LIQPAY_BUSY)
    }
    this.active++
    const entry = { expires: Number.POSITIVE_INFINITY, result: Promise.resolve({} as LiqPayPayload) }
    entry.result = this.client_.request({ action: "status", order_id: orderId }).finally(() => {
      this.active--
      entry.expires = Date.now() + STATUS_CACHE_MS
    })
    this.statuses.set(orderId, entry)
    return entry.result
  }

  /**
   * Asks LiqPay again about retired attempts that show no payment yet, so a lost
   * callback cannot hide a late payment. Flags the ones where money may have moved.
   * An unanswered or ambiguous lookup is retried on the next run.
   */
  async recheckRetiredAttempts(limit = this.recheckBatch): Promise<{ checked: number; flagged: string[] }> {
    const due = await this.ledger_.dueForRecheck(limit)
    const flagged: string[] = []
    let checked = 0
    const recheck = async (sessionId: string) => {
      let payload: LiqPayPayload
      try {
        payload = await this.client_.request({ action: "status", order_id: sessionId })
      } catch {
        return
      }
      if (payload.result === "error") {
        if (payload.err_code !== "payment_not_found") return
        payload = { status: undefined }
      }
      checked++
      if (await this.ledger_.recordCheck(sessionId, payload)) flagged.push(sessionId)
    }
    const queue = [...due]
    const worker = async () => {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) await recheck(next)
    }
    await Promise.all(Array.from({ length: Math.min(RECHECK_CONCURRENCY, queue.length) }, worker))
    return { checked, flagged }
  }

  /** Attempts that need an operator's review, and refunds whose outcome is unknown. */
  async listForReview(): Promise<{ attempts: AttemptForReview[]; refunds: RefundForReview[] }> {
    return this.ledger_.listForReview()
  }

  async markAttemptReviewed(sessionId: string, actor: string, note: string): Promise<void> {
    await this.ledger_.markReviewed(sessionId, actor, note)
  }

  /**
   * Records an operator's resolution of an uncertain refund. Local evidence only: it never
   * calls LiqPay. Used by the `reconcile-refund` exec script.
   */
  async resolveRefund(sessionId: string, operationId: string, outcome: "succeeded" | "failed",
    actor: string, evidence: string): Promise<void> {
    await this.ledger_.resolveRefund(sessionId, operationId, outcome, actor, evidence)
  }
}
