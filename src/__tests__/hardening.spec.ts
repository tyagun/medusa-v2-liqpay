import { LiqPayClient, encodeData, signData } from "../lib/client"
import { parsePayload } from "../lib/validation"
import { RequestLimit } from "../lib/request-limit"
import LiqPayModuleService, { isLiqPayBusyError } from "../modules/liqpay/service"

afterEach(() => jest.restoreAllMocks())

describe("external payload validation", () => {
  it.each([null, [], 1, "text", { status: {} }, { amount: Infinity }, { amount: -1 },
    { amount: "NaN" }, { order_id: {} }, { currency: "USDT" }])("rejects %j", (payload) => {
    expect(() => parsePayload(payload)).toThrow()
  })
  it("normalizes documented decimal strings and drops unknown fields", () => {
    expect(parsePayload({ amount: "12.50", payment_id: "42", surprise: "ignored" }))
      .toEqual({ amount: 12.5, payment_id: 42 })
  })
  it("rejects a response for a different merchant or order", async () => {
    for (const payload of [{ status: "success", public_key: "other" },
      { status: "success", order_id: "other" }]) {
      const client = new LiqPayClient("merchant", "private", async () => ({
        ok: true, status: 200, json: async () => payload,
      }))
      await expect(client.request({ action: "status", order_id: "expected" })).rejects.toThrow(/identity/)
    }
  })
})

describe("admission control", () => {
  it("bounds request rate and key cardinality and recovers after expiration", () => {
    const limit = new RequestLimit(2, 100, 2)
    expect(limit.allow("a", 0)).toBe(true)
    expect(limit.allow("a", 1)).toBe(true)
    expect(limit.allow("a", 2)).toBe(false)
    expect(limit.allow("b", 3)).toBe(true)
    expect(limit.allow("c", 4)).toBe(false)
    expect(limit.allow("c", 104)).toBe(true)
  })
  it("coalesces status requests", async () => {
    let resolve!: (value: Response) => void
    const fetch = jest.spyOn(global, "fetch").mockImplementation(() => new Promise((r) => { resolve = r }))
    const service = new LiqPayModuleService({}, { public_key: "key", private_key: "private" })
    const first = service.getStatus("one")
    const second = service.getStatus("one")
    resolve({ ok: true, json: async () => ({ status: "processing" }) } as Response)
    await Promise.all([first, second])
    await service.getStatus("one")
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it("caps upstream concurrency without queueing unbounded work", async () => {
    const resolvers: ((value: Response) => void)[] = []
    const fetch = jest.spyOn(global, "fetch").mockImplementation(() => new Promise((resolve) => {
      resolvers.push(resolve)
    }))
    const service = new LiqPayModuleService({},
      { public_key: "key", private_key: "private", status_concurrency: 4 })
    const requests = ["1", "2", "3", "4"].map((id) => service.getStatus(id))
    const busy = await service.getStatus("5").catch((error: unknown) => error)
    expect(isLiqPayBusyError(busy)).toBe(true)
    // A workflow may pass on a plain copy of the error; the message still identifies it.
    expect(isLiqPayBusyError({ message: (busy as Error).message })).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(4)
    for (const resolve of resolvers) resolve({ ok: true, json: async () => ({ status: "processing" }) } as Response)
    await Promise.all(requests)
  })
  it("rejects forged and oversized callbacks before queue admission", () => {
    const service = new LiqPayModuleService({}, { public_key: "key", private_key: "private" })
    const data = encodeData({ order_id: "one" })
    expect(service.verifyCallback({ data, signature: signData("private", data) })).toBe(true)
    expect(service.verifyCallback({ data, signature: "forged" })).toBe(false)
    expect(service.verifyCallback({ data: "x".repeat(65537), signature: "forged" })).toBe(false)
  })
})
