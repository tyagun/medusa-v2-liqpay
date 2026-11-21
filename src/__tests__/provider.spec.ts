import { createHash } from "node:crypto"
import {
  BigNumber,
  PaymentActions,
  PaymentSessionStatus,
} from "@medusajs/framework/utils"
import type { Logger } from "@medusajs/framework/types"
import { decodeData, encodeData, signData, verifySignature } from "../lib/client"
import { toSessionStatus, toWebhookAction } from "../lib/status"
import { toLiveStatus } from "../lib/live-status"
import LiqPayProviderService from "../providers/liqpay/service"

jest.mock("../lib/safety-store", () => ({
  ledgerDatabase: jest.fn(() => () => undefined),
  LiqPaySafetyStore: jest.fn().mockImplementation(() => ({
    remember: jest.fn().mockResolvedValue(undefined),
    retire: jest.fn().mockResolvedValue(undefined),
    observe: jest.fn().mockResolvedValue(false),
    beginRefund: jest.fn().mockResolvedValue(null),
    finishRefund: jest.fn().mockResolvedValue(undefined),
    refundedTotal: jest.fn().mockResolvedValue(250),
  })),
}))

const PRIVATE_KEY = "test_private_key"
const OPTIONS = {
  public_key: "sandbox_test_public_key",
  private_key: PRIVATE_KEY,
  result_url: "http://localhost:8000/checkout/liqpay/return",
  server_url: "http://localhost:9000/hooks/payment/liqpay_liqpay",
}

const logger = { warn: jest.fn(), info: jest.fn(), error: jest.fn() } as unknown as Logger

function makeService(options: Partial<typeof OPTIONS> = {}) {
  return new LiqPayProviderService({ logger }, { ...OPTIONS, ...options })
}

function callback(params: Record<string, unknown>) {
  const data = encodeData(params)
  return { data, signature: signData(PRIVATE_KEY, data) }
}

function mockApi(payload: Record<string, unknown>) {
  return jest.spyOn(global, "fetch").mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => payload,
  } as Response)
}

afterEach(() => {
  jest.restoreAllMocks()
})

describe("signature", () => {
  it("is base64(sha1(private + data + private))", () => {
    const data = encodeData({ action: "status", order_id: "x" })
    const expected = createHash("sha1")
      .update(PRIVATE_KEY + data + PRIVATE_KEY)
      .digest("base64")
    expect(signData(PRIVATE_KEY, data)).toBe(expected)
  })

  it("verifies its own signature and rejects a tampered one", () => {
    const { data, signature } = callback({ order_id: "payses_1", status: "success" })
    expect(verifySignature(PRIVATE_KEY, data, signature)).toBe(true)
    expect(verifySignature(PRIVATE_KEY, data, signature.slice(0, -2) + "AA")).toBe(false)
    expect(verifySignature("other_key", data, signature)).toBe(false)
  })

  it("survives a form parser that turned + into a space", () => {
    let found: { data: string; signature: string } | undefined
    for (let i = 0; i < 200 && !found; i++) {
      const candidate = callback({ order_id: `payses_${i}`, status: "success", amount: 1250 })
      if (candidate.data.includes("+") || candidate.signature.includes("+")) {
        found = candidate
      }
    }
    expect(found).toBeDefined()
    const { data, signature } = found!
    expect(
      verifySignature(PRIVATE_KEY, data.replace(/\+/g, " "), signature.replace(/\+/g, " "))
    ).toBe(true)
  })

  it("round-trips Ukrainian text through the data envelope", () => {
    const data = encodeData({ description: "Оплата замовлення №1250 — чай" })
    expect(decodeData(data)).toEqual({ description: "Оплата замовлення №1250 — чай" })
  })
})

describe("status mapping", () => {
  it("maps session statuses", () => {
    expect(toSessionStatus("success", false)).toBe(PaymentSessionStatus.CAPTURED)
    expect(toSessionStatus("sandbox", true)).toBe(PaymentSessionStatus.CAPTURED)
    expect(toSessionStatus("sandbox", false)).toBe(PaymentSessionStatus.ERROR)
    expect(toSessionStatus("failure", true)).toBe(PaymentSessionStatus.ERROR)
    expect(toSessionStatus("error", true)).toBe(PaymentSessionStatus.ERROR)
    expect(toSessionStatus("reversed", true)).toBe(PaymentSessionStatus.CANCELED)
    expect(toSessionStatus("3ds_verify", true)).toBe(PaymentSessionStatus.REQUIRES_MORE)
    expect(toSessionStatus("processing", true)).toBe(PaymentSessionStatus.PENDING)
    expect(toSessionStatus(undefined, true)).toBe(PaymentSessionStatus.PENDING)
  })

  it("maps webhook actions", () => {
    expect(toWebhookAction("success", false)).toBe(PaymentActions.SUCCESSFUL)
    expect(toWebhookAction("sandbox", true)).toBe(PaymentActions.SUCCESSFUL)
    expect(toWebhookAction("sandbox", false)).toBe(PaymentActions.FAILED)
    expect(toWebhookAction("failure", true)).toBe(PaymentActions.FAILED)
    expect(toWebhookAction("reversed", true)).toBe(PaymentActions.NOT_SUPPORTED)
    expect(toWebhookAction("wait_accept", true)).toBe(PaymentActions.PENDING)
    expect(toWebhookAction(undefined, true)).toBe(PaymentActions.NOT_SUPPORTED)
  })
})

describe("validateOptions", () => {
  it("requires keys and URLs", () => {
    expect(() => LiqPayProviderService.validateOptions({ ...OPTIONS })).not.toThrow()
    expect(() =>
      LiqPayProviderService.validateOptions({ ...OPTIONS, private_key: "" })
    ).toThrow(/private_key/)
  })

  it("requires absolute http(s) URLs", () => {
    expect(() =>
      LiqPayProviderService.validateOptions({ ...OPTIONS, result_url: "/checkout/return" })
    ).toThrow(/result_url.*absolute/)
    expect(() =>
      LiqPayProviderService.validateOptions({ ...OPTIONS, server_url: "ftp://example.com/hook" })
    ).toThrow(/server_url.*absolute/)
  })

  it("accepts only the languages LiqPay's page supports", () => {
    expect(() => LiqPayProviderService.validateOptions({ ...OPTIONS, language: "en" })).not.toThrow()
    expect(() => LiqPayProviderService.validateOptions({ ...OPTIONS, language: "ru" })).toThrow(
      /language/
    )
  })

  it("ignores a stale sandbox option: sandbox mode follows the key", async () => {
    const live = makeService({ public_key: "i12345678901", sandbox: true } as Partial<typeof OPTIONS>)
    mockApi({ result: "ok", status: "sandbox", amount: 150, currency: "UAH" })
    await expect(live.authorizePayment({ data: { session_id: "payses_1", amount: 150,
      currency_code: "uah" } })).resolves.toMatchObject({ status: PaymentSessionStatus.ERROR })
  })
})

describe("initiatePayment", () => {
  it("echoes session_id and builds a signed checkout form without the private key", async () => {
    const service = makeService()
    const result = await service.initiatePayment({
      amount: 1250,
      currency_code: "uah",
      data: { session_id: "payses_123" },
    })

    expect(result.id).toBe("payses_123")
    expect(result.status).toBe(PaymentSessionStatus.PENDING)
    const data = result.data as Record<string, unknown>
    expect(data.session_id).toBe("payses_123")
    expect(data.currency_code).toBe("uah")
    expect(data.amount).toBe(1250)
    expect(JSON.stringify(data)).not.toContain(PRIVATE_KEY)

    const checkoutData = data.checkout_data as string
    expect(verifySignature(PRIVATE_KEY, checkoutData, data.checkout_signature as string)).toBe(true)
    expect(decodeData(checkoutData)).toMatchObject({
      version: 3,
      public_key: "sandbox_test_public_key",
      action: "pay",
      order_id: "payses_123",
      amount: 1250,
      currency: "UAH",
      language: "uk",
      result_url: OPTIONS.result_url,
      server_url: OPTIONS.server_url,
      sandbox: 1,
    })
  })

  it("rounds the amount to kopiyky and omits sandbox in production", async () => {
    const service = makeService({ public_key: "i12345678901" })
    const result = await service.initiatePayment({
      amount: 99.999,
      currency_code: "uah",
      data: { session_id: "payses_1" },
    })
    const params = decodeData((result.data as Record<string, string>).checkout_data)
    expect(params.amount).toBe(100)
    expect(params).not.toHaveProperty("sandbox")
  })

  it("clears payment fields a shopper planted in the session data", async () => {
    const result = await makeService().initiatePayment({
      amount: 100,
      currency_code: "uah",
      data: { session_id: "payses_1", refunded_amount: 100, transaction_id: 1, sender_card_mask2: "4*1" },
    })
    // Medusa stores { ...input.data, ...result.data }: an explicit undefined wins the spread.
    const stored = JSON.parse(
      JSON.stringify({ session_id: "payses_1", refunded_amount: 100, transaction_id: 1, ...result.data })
    )
    expect(stored).not.toHaveProperty("refunded_amount")
    expect(stored).not.toHaveProperty("transaction_id")
  })

  it("uses the configured description and language, with defaults", async () => {
    const defaults = await makeService().initiatePayment({
      amount: 10,
      currency_code: "uah",
      data: { session_id: "payses_1" },
    })
    expect(decodeData((defaults.data as Record<string, string>).checkout_data)).toMatchObject({
      description: "Order payment",
      language: "uk",
    })

    const custom = await new LiqPayProviderService(
      { logger },
      { ...OPTIONS, description: "Оплата замовлення в магазині", language: "en" }
    ).initiatePayment({ amount: 10, currency_code: "uah", data: { session_id: "payses_1" } })
    expect(decodeData((custom.data as Record<string, string>).checkout_data)).toMatchObject({
      description: "Оплата замовлення в магазині",
      language: "en",
    })
  })

  it("rejects data without a session_id", async () => {
    await expect(
      makeService().initiatePayment({ amount: 1, currency_code: "uah", data: {} })
    ).rejects.toThrow(/session_id/)
  })
})

describe("authorizePayment", () => {
  const sessionData = {
    session_id: "payses_123",
    currency_code: "uah",
    amount: 150,
    status: "created",
  }

  it("returns captured when LiqPay reports the sandbox payment as paid", async () => {
    const fetchSpy = mockApi({
      result: "ok",
      status: "sandbox",
      amount: 150,
      currency: "UAH",
      payment_id: 777,
      paytype: "card",
      sender_card_mask2: "424242*42",
    })
    const result = await makeService().authorizePayment({ data: sessionData })

    expect(result.status).toBe(PaymentSessionStatus.CAPTURED)
    expect(result.data).toMatchObject({
      session_id: "payses_123",
      liqpay_payment_id: 777,
      paytype: "card",
      sender_card_mask2: "424242*42",
    })
    const body = new URLSearchParams(String(fetchSpy.mock.calls[0][1]?.body))
    expect(decodeData(body.get("data")!)).toMatchObject({
      action: "status",
      order_id: "payses_123",
    })
  })

  it("stays pending while LiqPay has no payment for the order", async () => {
    mockApi({ result: "error", status: "error", err_code: "payment_not_found" })
    const result = await makeService().authorizePayment({ data: sessionData })
    expect(result.status).toBe(PaymentSessionStatus.PENDING)
  })

  it("reports a declined payment as an error", async () => {
    mockApi({ result: "ok", status: "failure", err_code: "limit" })
    const result = await makeService().authorizePayment({ data: sessionData })
    expect(result.status).toBe(PaymentSessionStatus.ERROR)
  })

  it.each([
    ["a different amount", { amount: 1, currency: "UAH" }],
    ["a different currency", { amount: 150, currency: "USD" }],
    ["no amount", { currency: "UAH" }],
  ])("refuses a paid payment with %s and logs it", async (_, paid) => {
    mockApi({ result: "ok", status: "sandbox", payment_id: 777, ...paid })
    const result = await makeService().authorizePayment({ data: sessionData })
    expect(result.status).toBe(PaymentSessionStatus.ERROR)
    expect(result.data).toMatchObject({ err_code: "amount_mismatch", liqpay_payment_id: 777 })
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("payses_123"))
  })

  it("accepts an amount that differs only by float noise", async () => {
    mockApi({ result: "ok", status: "sandbox", amount: 150.0000001, currency: "uah" })
    const result = await makeService().authorizePayment({ data: sessionData })
    expect(result.status).toBe(PaymentSessionStatus.CAPTURED)
  })

  it("leaves unpaid statuses alone when the amount differs", async () => {
    mockApi({ result: "ok", status: "3ds_verify", amount: 1, currency: "UAH" })
    const result = await makeService().authorizePayment({ data: sessionData })
    expect(result.status).toBe(PaymentSessionStatus.REQUIRES_MORE)
  })
})

describe("getPaymentStatus", () => {
  it("applies the same amount check as authorizePayment", async () => {
    mockApi({ result: "ok", status: "sandbox", amount: 1, currency: "UAH" })
    const result = await makeService().getPaymentStatus({
      data: { session_id: "payses_123", currency_code: "uah", amount: 150 },
    })
    expect(result.status).toBe(PaymentSessionStatus.ERROR)
  })
})

describe("payment lifecycle guards", () => {
  const session = { session_id: "payses_123", amount: 150, currency_code: "uah", status: "created" }

  it("refuses authorization and capture of a held payment", async () => {
    mockApi({ result: "ok", status: "hold_wait", amount: 150, currency: "UAH" })
    expect((await makeService().authorizePayment({ data: session })).status).toBe(PaymentSessionStatus.ERROR)
    await expect(makeService().capturePayment({ data: session })).rejects.toThrow(/not confirmed settled/)
  })

  it("rejects changing the amount of an already issued checkout", async () => {
    await expect(makeService().updatePayment({ data: session, amount: 151, currency_code: "uah" }))
      .rejects.toThrow(/new LiqPay payment attempt/)
  })

  // Medusa swallows a deletePayment error and keeps the old, still payable session, so
  // the provider must never refuse: it retires the attempt for late-payment review.
  it("retires a replaced attempt without refusing or calling LiqPay", async () => {
    const fetch = mockApi({ result: "ok", status: "3ds_verify", amount: 150, currency: "UAH" })
    const service = makeService()
    await expect(service.deletePayment({ data: session })).resolves.toEqual({ data: session })
    expect((service as unknown as { safety_: { retire: jest.Mock } }).safety_.retire)
      .toHaveBeenCalledWith(session)
    expect(fetch).not.toHaveBeenCalled()
  })

  it("still deletes the session when the ledger is unavailable, and logs it", async () => {
    const service = makeService()
    const { safety_ } = service as unknown as { safety_: { retire: jest.Mock } }
    safety_.retire.mockRejectedValueOnce(new Error("connection refused"))
    await expect(service.deletePayment({ data: session })).resolves.toEqual({ data: session })
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("could not retire attempt payses_123"))
  })

  it("ignores cleanup data without a session id", async () => {
    const service = makeService()
    await expect(service.deletePayment({ data: {} })).resolves.toEqual({ data: {} })
    expect((service as unknown as { safety_: { retire: jest.Mock } }).safety_.retire)
      .not.toHaveBeenCalled()
  })

  it("rejects a refund without a stable key before contacting LiqPay", async () => {
    const fetch = mockApi({ result: "ok", status: "reversed" })
    await expect(makeService().refundPayment({ data: session, amount: 10 })).rejects.toThrow(/idempotency/)
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([null, [], { order_id: {}, amount: 100 }, { order_id: "payses_123", amount: 100, status: {} }])(
    "ignores a malformed signed callback %j", async (value) => {
      const data = encodeData(value as Record<string, unknown>)
      const result = await makeService().getWebhookActionAndData({ data: {
        data, signature: signData(PRIVATE_KEY, data),
      }, rawData: "", headers: {} })
      expect(result.action).toBe(PaymentActions.NOT_SUPPORTED)
    })
})

describe("refundPayment", () => {
  const sessionData = { session_id: "payses_123", currency_code: "uah", status: "sandbox" }

  it("refunds the amount and records it", async () => {
    const fetchSpy = mockApi({ result: "ok", status: "reversed" })
    const result = await makeService().refundPayment({ amount: 250, data: sessionData, context: { idempotency_key: "refund-1" } })
    expect(result.data).toMatchObject({ status: "reversed", refunded_amount: 250 })
    const body = new URLSearchParams(String(fetchSpy.mock.calls[0][1]?.body))
    expect(decodeData(body.get("data")!)).toMatchObject({ action: "refund", amount: 250 })
  })

  it("throws when LiqPay refuses the refund", async () => {
    mockApi({ result: "error", err_code: "err_amount", err_description: "Сума повернення завелика" })
    await expect(
      makeService().refundPayment({ amount: 99999, data: sessionData, context: { idempotency_key: "refund-1" } })
    ).rejects.toThrow(/LiqPay refund failed/)
  })

  it("tells the owner to check LiqPay before retrying when the refund got no answer", async () => {
    jest.spyOn(global, "fetch").mockRejectedValue(new Error("The operation was aborted due to timeout"))
    await expect(
      makeService().refundPayment({ amount: 250, data: sessionData, context: { idempotency_key: "refund-1" } })
    ).rejects.toThrow(/unknown whether the refund went through/)
  })

  it("sends every API call with a timeout signal", async () => {
    const fetchSpy = mockApi({ result: "ok", status: "reversed" })
    await makeService().refundPayment({ amount: 250, data: sessionData, context: { idempotency_key: "refund-1" } })
    expect(fetchSpy.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal)
  })
})

describe("getWebhookActionAndData", () => {
  const webhook = (body: Record<string, unknown>) =>
    makeService().getWebhookActionAndData({
      data: body,
      rawData: Buffer.from(new URLSearchParams(body as Record<string, string>).toString()),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    })

  it("maps a paid callback to SUCCESSFUL with the session id and amount", async () => {
    const result = await webhook(
      callback({ order_id: "payses_123", status: "sandbox", amount: 1250, currency: "UAH" })
    )
    expect(result.action).toBe(PaymentActions.SUCCESSFUL)
    expect(result.data?.session_id).toBe("payses_123")
    expect(new BigNumber(result.data!.amount).numeric).toBe(1250)
  })

  it("returns FAILED for a bad signature instead of throwing", async () => {
    const { data } = callback({ order_id: "payses_123", status: "success", amount: 1250 })
    const result = await webhook({ data, signature: "forged" })
    expect(result.action).toBe(PaymentActions.FAILED)
  })

  it("returns NOT_SUPPORTED for a body that is not a LiqPay callback", async () => {
    expect((await webhook({ hello: "world" })).action).toBe(PaymentActions.NOT_SUPPORTED)
    const noOrder = await webhook(callback({ status: "success", amount: 10 }))
    expect(noOrder.action).toBe(PaymentActions.NOT_SUPPORTED)
  })

  it("leaves a processing payment pending", async () => {
    const result = await webhook(
      callback({ order_id: "payses_123", status: "processing", amount: 1250 })
    )
    expect(result.action).toBe(PaymentActions.PENDING)
  })
})

describe("toLiveStatus", () => {
  const checkedAt = new Date("2026-11-18T10:00:00.000Z")

  it("keeps the named fields of a found payment", () => {
    const live = toLiveStatus(
      {
        result: "ok",
        status: "sandbox",
        public_key: "must_not_leak",
        payment_id: 1,
        transaction_id: 1,
        paytype: "card",
        sender_card_mask2: "424242*42",
        amount: 320,
        currency: "UAH",
        end_date: 1795030108969,
      },
      checkedAt
    )
    expect(live).toMatchObject({
      found: true,
      status: "sandbox",
      paytype: "card",
      amount: 320,
      checked_at: "2026-11-18T10:00:00.000Z",
    })
    expect(JSON.stringify(live)).not.toContain("must_not_leak")
  })

  it("reports payment_not_found as not found, with no status", () => {
    const live = toLiveStatus(
      { result: "error", status: "error", err_code: "payment_not_found" },
      checkedAt
    )
    expect(live.found).toBe(false)
    expect(live.status).toBeNull()
  })

  it("keeps other API errors as found with their message", () => {
    const live = toLiveStatus(
      { result: "error", status: "error", err_code: "x", err_description: "Помилка" },
      checkedAt
    )
    expect(live).toMatchObject({ found: true, status: "error", err_description: "Помилка" })
  })
})
