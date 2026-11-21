import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils"
import type { AttemptForReview, LiqPayPayload, LiqPaySessionData, RefundForReview } from "./types"

type RefundState = "pending" | "unknown" | "succeeded" | "failed"
type Operation = { amount: string; state: RefundState; response: LiqPayPayload | null }
type Row = Record<string, unknown>
type Client = { query(sql: string, params?: unknown[]): Promise<{ rows: Row[]; rowCount: number | null }> }
type KnexTransaction = { raw(sql: string, bindings: unknown[]): PromiseLike<unknown> }

/** The part of knex the ledger uses. Medusa registers its knex instance as `__pg_connection__`. */
export type KnexLike = {
  transaction<T>(work: (trx: KnexTransaction) => Promise<T>): Promise<T>
}

/** Where the ledger's connection comes from, resolved on first use. */
export type SafetyDatabase = () => KnexLike | undefined

/** Medusa's own database connection from a module or provider container. */
export function ledgerDatabase(container: unknown): SafetyDatabase {
  return () => {
    try {
      return (container as Record<string, unknown>)?.[ContainerRegistrationKeys.PG_CONNECTION] as KnexLike | undefined
    } catch {
      return undefined
    }
  }
}

/**
 * knex.raw binds `?` placeholders. The ledger's SQL uses PostgreSQL's `$n`, some of them
 * more than once, so each `$n` becomes a `?` with its value. Objects are sent as JSON for
 * the jsonb columns; undefined becomes NULL (knex refuses undefined bindings).
 */
export function toKnexBindings(sql: string, params: unknown[]): [string, unknown[]] {
  const bindings: unknown[] = []
  const text = sql.replace(/\$(\d+)/g, (_, index: string) => {
    const value = params[Number(index) - 1]
    bindings.push(value === undefined ? null :
      value !== null && typeof value === "object" && !(value instanceof Date) ? JSON.stringify(value) : value)
    return "?"
  })
  return [text, bindings]
}

/**
 * LiqPay statuses after which no money moved and none can move on that attempt. An
 * absent status means LiqPay has no payment (`payment_not_found`).
 */
const CLEAR_STATUSES = new Set(["failure", "error"])

/** True when a retired attempt's status shows that money may have moved. */
export function mayHaveMoved(status: string | undefined | null): boolean {
  return !!status && !CLEAR_STATUSES.has(status)
}

/** Stop rechecking a retired attempt that shows no payment after this many days. */
export const RECHECK_DAYS = 30

export type { AttemptForReview, RefundForReview }

/**
 * Durable evidence of LiqPay attempts and refunds. Every operation commits in its own
 * transaction on its own connection, independent of Medusa's: a rollback or crash of
 * the surrounding request never erases evidence that money may have moved.
 */
export class LiqPaySafetyStore {
  constructor(private readonly database: SafetyDatabase, private readonly merchant: string) {}

  /**
   * Runs `work` in its own transaction on its own pooled connection. `knex.transaction`
   * checks out a fresh connection, so the ledger never joins the Medusa transaction
   * around it, and commits or rolls back and releases the connection itself.
   */
  private async transaction<T>(work: (db: Client) => Promise<T>): Promise<T> {
    const knex = this.database()
    if (typeof knex?.transaction !== "function") {
      throw new MedusaError(MedusaError.Types.UNEXPECTED_STATE,
        "LiqPay safety ledger: Medusa's database connection is not available")
    }
    try {
      return await knex.transaction(async (trx) => {
        const db: Client = {
          query: async (sql, params = []) =>
            (await trx.raw(...toKnexBindings(sql, params))) as Awaited<ReturnType<Client["query"]>>,
        }
        // Transaction-scoped, so the pooled connection keeps its own settings afterwards.
        await db.query("SET LOCAL statement_timeout = '5s'")
        await db.query("SET LOCAL lock_timeout = '3s'")
        return work(db)
      })
    } catch (error) {
      if ((error as { code?: string })?.code === "42P01") {
        throw new MedusaError(MedusaError.Types.UNEXPECTED_STATE,
          "LiqPay safety ledger tables are missing: run `npx medusa db:migrate`")
      }
      throw error
    }
  }

  async remember(session: LiqPaySessionData): Promise<void> {
    await this.transaction((db) => this.insertAttempt(db, session))
  }

  private async insertAttempt(db: Client, session: LiqPaySessionData): Promise<void> {
    // No checkout signatures, credentials or card metadata in the recovery ledger.
    const snapshot = { session_id: session.session_id, amount: session.amount,
      currency_code: session.currency_code }
    await db.query(`INSERT INTO liqpay_attempt (merchant, session_id, snapshot)
      VALUES ($1,$2,$3) ON CONFLICT (merchant,session_id) DO NOTHING`,
    [this.merchant, session.session_id, snapshot])
  }

  /**
   * Marks an attempt replaced. Its signed form stays payable, so it keeps being watched:
   * a late callback or the recheck job flags it once LiqPay shows money may have moved.
   * A status already observed (paid before the cart changed) flags it right away.
   */
  async retire(session: LiqPaySessionData): Promise<void> {
    await this.transaction(async (db) => {
      await this.insertAttempt(db, session)
      await db.query(`UPDATE liqpay_attempt SET retired=true,
        retired_at=COALESCE(retired_at, now()), updated_at=now(),
        needs_review = needs_review OR
          COALESCE(last_status->>'status', '') NOT IN ('', ${[...CLEAR_STATUSES].map((s) => `'${s}'`).join(", ")})
        WHERE merchant=$1 AND session_id=$2`, [this.merchant, session.session_id])
    })
  }

  /** Records a status from LiqPay. Returns true when the attempt is retired. */
  async observe(sessionId: string, payload: LiqPayPayload): Promise<boolean> {
    return this.transaction(async (db) => {
      const result = await db.query(`UPDATE liqpay_attempt SET last_status=$3, updated_at=now(),
        needs_review = needs_review OR (retired AND $4)
        WHERE merchant=$1 AND session_id=$2 RETURNING retired`,
      [this.merchant, sessionId, statusSnapshot(payload), mayHaveMoved(payload.status)])
      return result.rows[0]?.retired === true
    })
  }

  /**
   * Retired attempts due for another LiqPay status check. The wait between checks doubles
   * with the attempt's age (1 h, 2 h, 4 h, …), capped at 7 days, so an attempt costs about
   * 13 checks over RECHECK_DAYS instead of one per hour or day. Callbacks remain the main
   * signal of a late payment; this catches lost ones.
   */
  async dueForRecheck(limit: number): Promise<string[]> {
    return this.transaction(async (db) => {
      const result = await db.query(`SELECT session_id FROM liqpay_attempt
        WHERE merchant=$1 AND retired AND NOT needs_review AND NOT closed
        AND (checked_at IS NULL OR checked_at < now() - LEAST(interval '7 days',
          GREATEST(interval '1 hour', checked_at - COALESCE(retired_at, created_at))))
        ORDER BY checked_at NULLS FIRST, retired_at LIMIT $2`, [this.merchant, limit])
      return result.rows.map((row) => String(row.session_id))
    })
  }

  /** Stores a recheck result. Returns true when the attempt now needs review. */
  async recordCheck(sessionId: string, payload: LiqPayPayload): Promise<boolean> {
    const moved = mayHaveMoved(payload.status)
    return this.transaction(async (db) => {
      const result = await db.query(`UPDATE liqpay_attempt SET last_status=$3, checked_at=now(),
        updated_at=now(), needs_review = needs_review OR $4,
        closed = NOT (needs_review OR $4)
          AND COALESCE(retired_at, updated_at) < now() - make_interval(days => $5)
        WHERE merchant=$1 AND session_id=$2 AND retired RETURNING needs_review`,
      [this.merchant, sessionId, statusSnapshot(payload), moved, RECHECK_DAYS])
      return result.rows[0]?.needs_review === true
    })
  }

  async listForReview(limit = 200): Promise<{ attempts: AttemptForReview[]; refunds: RefundForReview[] }> {
    return this.transaction(async (db) => {
      const attempts = await db.query(`SELECT session_id, snapshot, last_status, retired,
        retired_at, created_at, updated_at FROM liqpay_attempt
        WHERE merchant=$1 AND needs_review ORDER BY updated_at DESC LIMIT $2`, [this.merchant, limit])
      const refunds = await db.query(`SELECT session_id, operation_id, amount, state,
        created_at, updated_at FROM liqpay_refund_operation
        WHERE merchant=$1 AND state IN ('pending','unknown') ORDER BY created_at LIMIT $2`,
      [this.merchant, limit])
      return {
        attempts: attempts.rows.map((row) => {
          const snapshot = (row.snapshot ?? {}) as { amount?: number; currency_code?: string }
          return {
            session_id: String(row.session_id),
            amount: typeof snapshot.amount === "number" ? snapshot.amount : null,
            currency_code: snapshot.currency_code ?? null,
            last_status: (row.last_status ?? null) as AttemptForReview["last_status"],
            retired: row.retired === true,
            retired_at: iso(row.retired_at),
            created_at: iso(row.created_at)!,
            updated_at: iso(row.updated_at)!,
          }
        }),
        refunds: refunds.rows.map((row) => ({
          session_id: String(row.session_id),
          operation_id: String(row.operation_id),
          amount: Number(row.amount),
          state: row.state as RefundForReview["state"],
          created_at: iso(row.created_at)!,
          updated_at: iso(row.updated_at)!,
        })),
      }
    })
  }

  /** Clears an attempt's review flag, keeping who cleared it and why. */
  async markReviewed(sessionId: string, actor: string, note: string): Promise<void> {
    if (!actor.trim() || !note.trim()) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, "A review requires an actor and a note")
    }
    const result = await this.transaction((db) => db.query(`UPDATE liqpay_attempt
      SET needs_review=false, reviewed=$3, updated_at=now()
      WHERE merchant=$1 AND session_id=$2 AND needs_review RETURNING session_id`,
    [this.merchant, sessionId, { actor, note, at: new Date().toISOString() }]))
    if (!result.rowCount) {
      throw new MedusaError(MedusaError.Types.NOT_FOUND, `No LiqPay attempt ${sessionId} awaits review`)
    }
  }

  /**
   * Starts a refund operation, or returns the saved one when this key already succeeded.
   * A key whose refund LiqPay confirmed failed may be retried: no money moved.
   */
  async beginRefund(sessionId: string, operationId: string, amount: number, refundedBeforeLedger = 0): Promise<Operation | null> {
    try {
      return await this.transaction(async (db) => {
        await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [JSON.stringify([this.merchant, sessionId])])
        const existing = await db.query(`SELECT amount,state,response FROM liqpay_refund_operation
          WHERE merchant=$1 AND session_id=$2 AND operation_id=$3`,
        [this.merchant, sessionId, operationId])
        const operation = existing.rows[0] as Operation | undefined
        if (operation) {
          if (Number(operation.amount) !== amount) throw new MedusaError(MedusaError.Types.UNEXPECTED_STATE, "Refund key already used for a different amount")
          if (operation.state === "succeeded") return operation
          if (operation.state !== "failed") {
            throw new MedusaError(MedusaError.Types.UNEXPECTED_STATE, "Refund already attempted; reconcile it before proceeding. Automatic retries are blocked")
          }
        }
        const unresolved = await db.query(`SELECT 1 FROM liqpay_refund_operation
          WHERE merchant=$1 AND session_id=$2 AND state IN ('pending','unknown')`,
        [this.merchant, sessionId])
        if (unresolved.rows.length) throw new MedusaError(MedusaError.Types.UNEXPECTED_STATE, "Payment has an unresolved refund; reconcile it before proceeding")
        if (operation) {
          await db.query(`UPDATE liqpay_refund_operation SET state='pending', response=NULL,
            updated_at=now() WHERE merchant=$1 AND session_id=$2 AND operation_id=$3`,
          [this.merchant, sessionId, operationId])
          return null
        }
        const baseline = await db.query(`SELECT baseline_amount FROM liqpay_refund_operation
          WHERE merchant=$1 AND session_id=$2 ORDER BY created_at LIMIT 1`, [this.merchant, sessionId])
        await db.query(`INSERT INTO liqpay_refund_operation
          (merchant,session_id,operation_id,amount,state,baseline_amount) VALUES ($1,$2,$3,$4,'pending',$5)`,
        [this.merchant, sessionId, operationId, amount, baseline.rows[0]?.baseline_amount ?? refundedBeforeLedger])
        return null
      })
    } catch (error) {
      throw new MedusaError(MedusaError.Types.NOT_ALLOWED, (error as Error).message)
    }
  }

  async finishRefund(sessionId: string, operationId: string, state: Exclude<RefundState, "pending">,
    payload?: LiqPayPayload): Promise<void> {
    const result = await this.transaction((db) => db.query(`UPDATE liqpay_refund_operation
      SET state=$4,response=$5,updated_at=now()
      WHERE merchant=$1 AND session_id=$2 AND operation_id=$3 AND state='pending'`,
    [this.merchant, sessionId, operationId, state, payload ?? null]))
    if (!result.rowCount) throw new MedusaError(MedusaError.Types.UNEXPECTED_STATE, "Refund operation state changed; reconcile before proceeding")
  }

  async refundedTotal(sessionId: string): Promise<number> {
    const result = await this.transaction((db) => db.query(`SELECT
      COALESCE(sum(amount) FILTER (WHERE state='succeeded'),0) + COALESCE(max(baseline_amount),0) AS total
      FROM liqpay_refund_operation WHERE merchant=$1 AND session_id=$2`,
    [this.merchant, sessionId]))
    return Number(result.rows[0].total)
  }

  /** Offline operator action: stop payment workers first, verify the merchant cabinet,
   * and retain the evidence. This never moves money or guesses from payment status. */
  async resolveRefund(sessionId: string, operationId: string, outcome: "succeeded" | "failed",
    actor: string, evidence: string): Promise<void> {
    if (!["succeeded", "failed"].includes(outcome) || !actor.trim() || !evidence.trim()) {
      throw new MedusaError(MedusaError.Types.UNEXPECTED_STATE, "Resolution requires a valid outcome, actor and evidence")
    }
    const result = await this.transaction((db) => db.query(`UPDATE liqpay_refund_operation SET state=$4,
      response=CASE WHEN $4='succeeded' THEN '{"result":"ok","status":"reversed"}'::jsonb ELSE response END,
      resolution=$5,updated_at=now() WHERE merchant=$1 AND session_id=$2 AND operation_id=$3
      AND state IN ('pending','unknown') RETURNING operation_id`,
    [this.merchant, sessionId, operationId, outcome, { actor, evidence, at: new Date().toISOString() }]))
    if (!result.rowCount) throw new MedusaError(MedusaError.Types.UNEXPECTED_STATE, "No unresolved refund matched; nothing was changed")
  }
}

function statusSnapshot(payload: LiqPayPayload) {
  return { status: payload.status, amount: payload.amount, currency: payload.currency,
    payment_id: payload.payment_id }
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null
  return new Date(value as string | Date).toISOString()
}
