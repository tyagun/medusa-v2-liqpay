import type { MedusaNextFunction, MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { limitSessions } from "../api/middlewares"
import { mayHaveMoved } from "../lib/safety-store"
import LiqPayModuleService, { validateModuleOptions } from "../modules/liqpay/service"

const OPTIONS = { public_key: "sandbox_pub", private_key: "priv" }

afterEach(() => jest.restoreAllMocks())

type Ledger = { dueForRecheck: jest.Mock; recordCheck: jest.Mock }

function serviceWithLedger(due: string[]) {
  const service = new LiqPayModuleService({}, OPTIONS)
  const ledger = (service as unknown as { ledger_: Ledger }).ledger_
  ledger.dueForRecheck = jest.fn().mockResolvedValue(due)
  ledger.recordCheck = jest.fn(async (_id: string, payload: { status?: string }) =>
    mayHaveMoved(payload.status))
  return { service, ledger }
}

function answers(byOrder: Record<string, unknown>) {
  return jest.spyOn(global, "fetch").mockImplementation(async (_url, init) => {
    const data = new URLSearchParams(String(init?.body)).get("data")!
    const { order_id } = JSON.parse(Buffer.from(data, "base64").toString("utf8"))
    const answer = byOrder[order_id]
    if (answer instanceof Error) throw answer
    return { ok: true, status: 200, json: async () => answer } as Response
  })
}

describe("recheckRetiredAttempts", () => {
  it("flags attempts LiqPay shows as paid and clears ones it has no payment for", async () => {
    answers({
      paid: { result: "ok", status: "success", amount: 10, currency: "UAH" },
      absent: { result: "error", err_code: "payment_not_found" },
      declined: { result: "ok", status: "failure" },
    })
    const { service, ledger } = serviceWithLedger(["paid", "absent", "declined"])
    await expect(service.recheckRetiredAttempts()).resolves.toEqual({ checked: 3, flagged: ["paid"] })
    expect(ledger.recordCheck).toHaveBeenCalledWith("absent", { status: undefined })
  })

  it("leaves unanswered or ambiguous lookups for the next run", async () => {
    answers({ down: new Error("timeout"), limited: { result: "error", err_code: "limit" } })
    const { service, ledger } = serviceWithLedger(["down", "limited"])
    await expect(service.recheckRetiredAttempts()).resolves.toEqual({ checked: 0, flagged: [] })
    expect(ledger.recordCheck).not.toHaveBeenCalled()
  })
})

describe("review flags", () => {
  it("flag only statuses where money may have moved", () => {
    for (const status of [undefined, null, "failure", "error"]) expect(mayHaveMoved(status)).toBe(false)
    for (const status of ["success", "sandbox", "processing", "3ds_verify", "hold_wait", "reversed"]) {
      expect(mayHaveMoved(status)).toBe(true)
    }
  })
})

describe("module options", () => {
  it("bounds status_concurrency", () => {
    expect(() => validateModuleOptions({ ...OPTIONS, status_concurrency: 32 })).not.toThrow()
    for (const value of [0, 1.5, 1000]) {
      expect(() => validateModuleOptions({ ...OPTIONS, status_concurrency: value })).toThrow(/status_concurrency/)
    }
  })
})

describe("payment session rate limit", () => {
  const liqpay = new LiqPayModuleService({}, OPTIONS)
  function call(body: unknown, ip: string, id = "paycol_1") {
    const res = { setHeader: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn() }
    const next = jest.fn()
    const scope = { resolve: () => liqpay }
    limitSessions({ body, ip, params: { id }, path: "/x", scope } as unknown as MedusaRequest,
      res as unknown as MedusaResponse, next as MedusaNextFunction)
    return { res, next }
  }

  it("limits LiqPay sessions per payment collection and leaves other providers alone", () => {
    for (let i = 0; i < 10; i++) expect(call({ provider_id: "pp_liqpay_liqpay" }, `ip${i}`).next).toHaveBeenCalled()
    const limited = call({ provider_id: "pp_liqpay_liqpay" }, "ip-new")
    expect(limited.next).not.toHaveBeenCalled()
    expect(limited.res.status).toHaveBeenCalledWith(429)
    expect(call({ provider_id: "pp_system_default" }, "ip-new").next).toHaveBeenCalled()
    // Shoppers behind one storefront server share an IP but not a payment collection.
    expect(call({ provider_id: "pp_liqpay_liqpay" }, "ip-new", "paycol_2").next).toHaveBeenCalled()
  })
})
