import { randomUUID } from "node:crypto"
import { PaymentActions } from "@medusajs/framework/utils"
import { encodeData, signData } from "../lib/client"
import { LEDGER_SCHEMA } from "../lib/ledger-schema"
import { type KnexLike, LiqPaySafetyStore } from "../lib/safety-store"
import LiqPayProviderService from "../providers/liqpay/service"
import type { Logger } from "@medusajs/framework/types"
import type { LiqPaySessionData } from "../lib/types"

const database = process.env.LIQPAY_TEST_DATABASE_URL
const integration = database ? describe : describe.skip

integration("PostgreSQL payment safety", () => {
  const merchant = `sandbox_${randomUUID()}`
  const session = { session_id: "payses_test", currency_code: "uah", amount: 100,
    status: "sandbox" } as LiqPaySessionData
  type Knex = KnexLike & {
    raw(sql: string, bindings?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
    destroy(): Promise<void>
    client: { pool: { numUsed(): number } }
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const connect = (options: Record<string, unknown> = {}): Knex => require("knex")({
    client: "pg", connection: database, pool: { min: 0, max: 4 }, ...options })
  let knex: Knex
  let store: LiqPaySafetyStore
  const db = { query: (sql: string, bindings: unknown[] = []) => knex.raw(sql, bindings) }
  const newStore = () => new LiqPaySafetyStore(() => knex, merchant)
  const provider = () => new LiqPayProviderService({ logger: {
    warn: jest.fn(), error: jest.fn(), info: jest.fn(),
  } as unknown as Logger, __pg_connection__: knex } as never, { public_key: merchant, private_key: "test",
    result_url: "https://example.com", server_url: "https://example.com" })

  beforeAll(async () => {
    knex = connect()
    for (const sql of Object.values(LEDGER_SCHEMA)) await knex.raw(sql)
    store = newStore()
  })
  afterEach(async () => {
    jest.restoreAllMocks()
    await db.query("DELETE FROM liqpay_refund_operation WHERE merchant=?", [merchant])
    await db.query("DELETE FROM liqpay_attempt WHERE merchant=?", [merchant])
  })
  afterAll(async () => { await knex.destroy() })

  it("allows only one concurrent refund, even with different keys", async () => {
    const results = await Promise.allSettled([
      store.beginRefund(session.session_id, "one", 10),
      newStore().beginRefund(session.session_id, "two", 10),
    ])
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1)
  })

  it("blocks stale pending operations after a new store instance starts", async () => {
    await store.beginRefund(session.session_id, "crashed", 10)
    await db.query("UPDATE liqpay_refund_operation SET updated_at=now()-interval '1 day' WHERE merchant=?", [merchant])
    const restarted = newStore()
    await expect(restarted.beginRefund(session.session_id, "crashed", 10)).rejects.toThrow(/reconcile/)
    await expect(restarted.beginRefund(session.session_id, "new-key", 10)).rejects.toThrow(/unresolved/)
  })

  it("replays a successful refund without another network call", async () => {
    const fetch = jest.spyOn(global, "fetch").mockResolvedValue({ ok: true,
      json: async () => ({ result: "ok", status: "reversed" }) } as Response)
    const input = { data: session, amount: 10, context: { idempotency_key: "one" } }
    await provider().refundPayment(input)
    const replay = await provider().refundPayment(input)
    expect(replay.data?.refunded_amount).toBe(10)
    expect(fetch).toHaveBeenCalledTimes(1)
    await expect(provider().refundPayment({ ...input, amount: 20 })).rejects.toThrow(/different amount/)
  })

  it.each([null, {}, { result: "ok", status: "processing" },
    { result: "error", status: "reversed", err_code: "inconsistent" },
    { result: "ok", status: "reversed", wait_amount: "true" }])(
    "blocks retries after ambiguous response %j", async (payload) => {
      const fetch = jest.spyOn(global, "fetch").mockResolvedValue({ ok: true,
        json: async () => payload } as Response)
      const input = { data: session, amount: 10, context: { idempotency_key: "one" } }
      await expect(provider().refundPayment(input)).rejects.toThrow()
      await expect(provider().refundPayment(input)).rejects.toThrow(/reconcile/)
      await expect(provider().refundPayment({ ...input, context: { idempotency_key: "two" } }))
        .rejects.toThrow(/unresolved/)
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(await store.refundedTotal(session.session_id)).toBe(0)
    })

  it("retains a retired attempt and records a late settlement", async () => {
    await store.remember(session)
    await store.retire(session)
    expect(await newStore().observe(session.session_id,
      { status: "success", amount: 100, currency: "UAH" })).toBe(true)
    const { rows } = await db.query("SELECT * FROM liqpay_attempt WHERE merchant=?", [merchant])
    expect(rows[0]).toMatchObject({ retired: true, needs_review: true,
      snapshot: { session_id: session.session_id, amount: 100 }, last_status: { status: "success" } })
  })

  it("retires the old attempt when the cart changes mid-payment, so it cannot complete the cart", async () => {
    const service = provider()
    const signed = (params: Record<string, unknown>) => {
      const data = encodeData(params)
      return { data: { data, signature: signData("test", data) }, rawData: "", headers: {} }
    }
    // Attempt A is issued, the customer reaches 3-D Secure, then the cart total changes.
    const fetch = jest.spyOn(global, "fetch")
    const a = await service.initiatePayment({ amount: 150, currency_code: "uah",
      data: { session_id: "payses_cart_a" } })
    await expect(service.deletePayment({ data: a.data })).resolves.toBeDefined()
    // Attempt B is issued for the new total.
    await service.initiatePayment({ amount: 200, currency_code: "uah",
      data: { session_id: "payses_cart_b" } })
    expect(fetch).not.toHaveBeenCalled()

    // A late payment on A is recorded for review and does not complete the cart.
    const late = await service.getWebhookActionAndData(signed({ order_id: "payses_cart_a",
      status: "sandbox", amount: 150, currency: "UAH" }))
    expect(late.action).toBe(PaymentActions.NOT_SUPPORTED)
    // B still settles normally.
    const paid = await service.getWebhookActionAndData(signed({ order_id: "payses_cart_b",
      status: "sandbox", amount: 200, currency: "UAH" }))
    expect(paid.action).toBe(PaymentActions.SUCCESSFUL)
    expect(paid.data?.session_id).toBe("payses_cart_b")

    const { rows } = await db.query(`SELECT session_id, retired, needs_review, last_status
      FROM liqpay_attempt WHERE merchant=? ORDER BY session_id`, [merchant])
    expect(rows).toMatchObject([
      { session_id: "payses_cart_a", retired: true, needs_review: true,
        last_status: { status: "sandbox", amount: 150 } },
      { session_id: "payses_cart_b", retired: false, needs_review: false },
    ])
  })

  it("flags a retired attempt only once LiqPay shows money may have moved", async () => {
    await store.retire(session)
    const flag = async () => (await db.query(`SELECT needs_review FROM liqpay_attempt
      WHERE merchant=? AND session_id=?`, [merchant, session.session_id])).rows[0].needs_review
    expect(await flag()).toBe(false)
    await store.observe(session.session_id, { status: undefined })
    await store.observe(session.session_id, { status: "failure" })
    expect(await flag()).toBe(false)
    await store.observe(session.session_id, { status: "processing" })
    expect(await flag()).toBe(true)
  })

  it("flags an attempt retired after LiqPay already reported a payment", async () => {
    await store.remember(session)
    expect(await store.observe(session.session_id, { status: "success", amount: 100 })).toBe(false)
    await store.retire(session)
    const { rows } = await db.query("SELECT needs_review FROM liqpay_attempt WHERE merchant=?", [merchant])
    expect(rows[0].needs_review).toBe(true)
  })

  it("rechecks retired attempts on a schedule and closes them after the recheck period", async () => {
    await store.retire(session)
    expect(await store.dueForRecheck(10)).toEqual([session.session_id])
    expect(await store.recordCheck(session.session_id, { status: undefined })).toBe(false)
    expect(await store.dueForRecheck(10)).toEqual([])
    // The wait doubles with age: checked at 7 h old, the next check is due at 14 h.
    await db.query(`UPDATE liqpay_attempt SET retired_at=now()-interval '10 hours',
      checked_at=now()-interval '3 hours' WHERE merchant=?`, [merchant])
    expect(await store.dueForRecheck(10)).toEqual([])
    await db.query(`UPDATE liqpay_attempt SET checked_at=now()-interval '8 hours' WHERE merchant=?`, [merchant])
    expect(await store.dueForRecheck(10)).toEqual([session.session_id])
    // ...and never exceeds 7 days.
    await db.query(`UPDATE liqpay_attempt SET retired_at=now()-interval '31 days',
      checked_at=now()-interval '6 days' WHERE merchant=?`, [merchant])
    expect(await store.dueForRecheck(10)).toEqual([])
    await db.query(`UPDATE liqpay_attempt SET checked_at=now()-interval '8 days' WHERE merchant=?`, [merchant])
    expect(await store.dueForRecheck(10)).toEqual([session.session_id])
    await store.recordCheck(session.session_id, { status: "failure" })
    const { rows } = await db.query("SELECT closed FROM liqpay_attempt WHERE merchant=?", [merchant])
    expect(rows[0].closed).toBe(true)
    expect(await store.dueForRecheck(10)).toEqual([])
    // A late callback on a closed attempt still flags it.
    await store.observe(session.session_id, { status: "success", amount: 100, currency: "UAH" })
    expect((await store.listForReview()).attempts).toMatchObject([{ session_id: session.session_id,
      amount: 100, currency_code: "uah", last_status: { status: "success" } }])
  })

  it("lists flagged attempts and unknown refunds, and records a review", async () => {
    await store.retire(session)
    await store.observe(session.session_id, { status: "success", amount: 100, currency: "UAH" })
    await store.beginRefund("payses_other", "op", 5)
    await store.finishRefund("payses_other", "op", "unknown")
    const list = await store.listForReview()
    expect(list.attempts.map((a) => a.session_id)).toEqual([session.session_id])
    expect(list.refunds).toMatchObject([{ session_id: "payses_other", operation_id: "op", amount: 5, state: "unknown" }])
    await expect(store.markReviewed(session.session_id, "user_1", " ")).rejects.toThrow(/note/)
    await store.markReviewed(session.session_id, "user_1", "Refunded in the cabinet")
    expect((await store.listForReview()).attempts).toEqual([])
    await expect(store.markReviewed(session.session_id, "user_1", "again")).rejects.toThrow(/awaits review/)
    const { rows } = await db.query("SELECT reviewed FROM liqpay_attempt WHERE merchant=?", [merchant])
    expect(rows[0].reviewed).toMatchObject({ actor: "user_1", note: "Refunded in the cabinet" })
  })

  it("retries a refund LiqPay confirmed failed with the same key", async () => {
    const fetch = jest.spyOn(global, "fetch")
      .mockResolvedValueOnce({ ok: true, json: async () => ({ result: "error",
        err_code: "payment_err_status", status: "error" }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ result: "ok", status: "reversed" }) } as Response)
    const input = { data: session, amount: 10, context: { idempotency_key: "one" } }
    await expect(provider().refundPayment(input)).rejects.toThrow(/refund failed/)
    await expect(provider().refundPayment(input)).resolves.toMatchObject({ data: { refunded_amount: 10 } })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it("keeps only evidence-backed flags when upgrading an earlier ledger", async () => {
    await db.query(`INSERT INTO liqpay_attempt (merchant, session_id, snapshot, retired, needs_review, last_status)
      VALUES (?,'old_none','{}',true,true,NULL), (?,'old_paid','{}',true,true,'{"status":"success"}')`, [merchant, merchant])
    await db.query(LEDGER_SCHEMA["002-attempt-review"])
    const { rows } = await db.query(`SELECT session_id, needs_review, retired_at IS NOT NULL AS dated
      FROM liqpay_attempt WHERE merchant=? ORDER BY session_id`, [merchant])
    expect(rows).toEqual([{ session_id: "old_none", needs_review: false, dated: true },
      { session_id: "old_paid", needs_review: true, dated: true }])
  })

  it("returns every connection and keeps its settings out of the shared pool", async () => {
    const own = connect({ pool: { min: 0, max: 2 } })
    try {
      const shared = new LiqPaySafetyStore(() => own, merchant)
      await shared.retire(session)
      expect(await shared.observe(session.session_id, { status: "success" })).toBe(true)
      const results = await Promise.allSettled([shared.beginRefund(session.session_id, "a", 1),
        shared.beginRefund(session.session_id, "b", 1)])
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
      await expect(shared.listForReview()).resolves.toMatchObject({ attempts: [{ session_id: session.session_id }] })
      expect(own.client.pool.numUsed()).toBe(0)
      // Settings are transaction-scoped and do not leak into Medusa's connections.
      const { rows } = await own.raw("SHOW statement_timeout")
      expect(rows[0].statement_timeout).toBe("0")
    } finally {
      await own.destroy()
    }
  })

  it("commits ledger writes even when the caller's own transaction rolls back", async () => {
    await (knex as unknown as { transaction(work: (trx: unknown) => Promise<void>): Promise<void> })
      .transaction(async () => {
        await store.remember(session)
        throw new Error("Medusa request failed")
      }).catch(() => undefined)
    const { rows } = await db.query("SELECT session_id FROM liqpay_attempt WHERE merchant=?", [merchant])
    expect(rows).toEqual([{ session_id: session.session_id }])
  })

  it("explains missing tables", async () => {
    const empty = `liqpay_empty_${randomUUID().slice(0, 8)}`
    await db.query(`CREATE SCHEMA ${empty}`)
    const isolated = connect({ searchPath: [empty], pool: { min: 0, max: 1 } })
    try {
      await expect(new LiqPaySafetyStore(() => isolated, merchant).remember(session))
        .rejects.toThrow(/medusa db:migrate/)
    } finally {
      await isolated.destroy()
      await db.query(`DROP SCHEMA ${empty} CASCADE`)
    }
  })

  it("preserves pre-ledger refund totals and records explicit operator resolution", async () => {
    await store.beginRefund(session.session_id, "one", 10, 20)
    await store.finishRefund(session.session_id, "one", "unknown")
    await store.resolveRefund(session.session_id, "one", "succeeded", "operator", "cabinet reference")
    expect(await store.refundedTotal(session.session_id)).toBe(30)
    await store.beginRefund(session.session_id, "two", 5, 30)
    await store.finishRefund(session.session_id, "two", "succeeded", { result: "ok", status: "reversed" })
    expect(await store.refundedTotal(session.session_id)).toBe(35)
    const { rows } = await db.query("SELECT resolution FROM liqpay_refund_operation WHERE merchant=? AND operation_id='one'", [merchant])
    expect(rows[0].resolution.actor).toBe("operator")
  })
})
