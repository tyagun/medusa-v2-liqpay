import { isLiqPayProviderId } from "../lib/constants"
import LiqPayModuleService, { validateModuleOptions } from "../modules/liqpay/service"
import { decodeData } from "../lib/client"

const OPTIONS = { public_key: "sandbox_pub", private_key: "priv" }

afterEach(() => {
  jest.restoreAllMocks()
})

describe("validateModuleOptions", () => {
  it("requires both keys", () => {
    expect(() => validateModuleOptions(OPTIONS)).not.toThrow()
    expect(() => validateModuleOptions(undefined)).toThrow(/public_key/)
    expect(() => validateModuleOptions({ ...OPTIONS, private_key: "" })).toThrow(/private_key/)
  })

  it("validates rate limits and the recheck batch size", () => {
    expect(() => validateModuleOptions({ ...OPTIONS, rate_limits: false })).not.toThrow()
    expect(() => validateModuleOptions({ ...OPTIONS, rate_limits: { status_per_cart: 120 } })).not.toThrow()
    expect(() => validateModuleOptions({ ...OPTIONS, rate_limits: { status_per_cart: 0 } }))
      .toThrow(/rate_limits.status_per_cart/)
    expect(() => validateModuleOptions({ ...OPTIONS, recheck_batch_size: 5000 })).toThrow(/recheck_batch_size/)
  })
})

describe("allowRequest", () => {
  it("limits per key with the configured value, and not at all when disabled", () => {
    const limited = new LiqPayModuleService({}, { ...OPTIONS, rate_limits: { status_per_cart: 2 } })
    expect([1, 2, 3].map(() => limited.allowRequest("status", "cart_1"))).toEqual([true, true, false])
    // Another cart from the same storefront server is not affected.
    expect(limited.allowRequest("status", "cart_2")).toBe(true)
    const open = new LiqPayModuleService({}, { ...OPTIONS, rate_limits: false })
    for (let i = 0; i < 100; i++) expect(open.allowRequest("session", "paycol_1")).toBe(true)
  })
})

describe("LiqPayModuleService", () => {
  it("derives sandbox mode from the key and asks LiqPay for a status by order_id", async () => {
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ result: "ok", status: "sandbox" }),
    } as Response)

    const service = new LiqPayModuleService({}, OPTIONS)
    expect(service.isSandbox()).toBe(true)
    expect(new LiqPayModuleService({}, { ...OPTIONS, public_key: "i000" }).isSandbox()).toBe(false)

    await expect(service.getStatus("payses_9")).resolves.toMatchObject({ status: "sandbox" })
    const body = new URLSearchParams(String(fetchSpy.mock.calls[0][1]?.body))
    expect(decodeData(body.get("data")!)).toMatchObject({
      version: 3,
      public_key: "sandbox_pub",
      action: "status",
      order_id: "payses_9",
    })
  })
})

describe("isLiqPayProviderId", () => {
  it("matches every provider id registered from this provider", () => {
    expect(isLiqPayProviderId("pp_liqpay_liqpay")).toBe(true)
    expect(isLiqPayProviderId("pp_liqpay_main")).toBe(true)
    expect(isLiqPayProviderId("pp_system_default")).toBe(false)
    expect(isLiqPayProviderId(undefined)).toBe(false)
  })
})
