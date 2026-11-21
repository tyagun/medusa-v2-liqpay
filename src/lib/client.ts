import { createHash, timingSafeEqual } from "node:crypto"
import { MedusaError } from "@medusajs/framework/utils"
import type { LiqPayEnvelope, LiqPayPayload, LiqPayRequestParams } from "./types"
import { parsePayload } from "./validation"

export const LIQPAY_CHECKOUT_URL = "https://www.liqpay.ua/api/3/checkout"
export const LIQPAY_API_URL = "https://www.liqpay.ua/api/request"

/** Server API timeout. Refunds get longer: a lost refund response is the costly one. */
export const LIQPAY_TIMEOUT_MS = 15_000
export const LIQPAY_REFUND_TIMEOUT_MS = 30_000

/**
 * LiqPay sandbox merchants have public keys starting with "sandbox_". Sandbox mode with
 * any other key would mark every checkout `sandbox: 1` and count unpaid test payments
 * as paid on a live merchant.
 */
export function isSandboxKey(publicKey: unknown): boolean {
  return typeof publicKey === "string" && publicKey.startsWith("sandbox_")
}

/** base64(sha1(private_key + data + private_key)). */
export function signData(privateKey: string, data: string): string {
  return createHash("sha1")
    .update(privateKey + data + privateKey)
    .digest("base64")
}

export function encodeData(params: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(params), "utf8").toString("base64")
}

export function decodeData(data: string): LiqPayPayload {
  return JSON.parse(Buffer.from(data, "base64").toString("utf8")) as LiqPayPayload
}

/**
 * Constant-time signature check. A form parser turns an unescaped "+" into a space,
 * and base64 never contains spaces, so spaces are restored before comparing.
 */
export function verifySignature(privateKey: string, data: string, signature: string): boolean {
  const expected = Buffer.from(signData(privateKey, data.replace(/ /g, "+")))
  const received = Buffer.from(signature.replace(/ /g, "+"))
  return expected.length === received.length && timingSafeEqual(expected, received)
}

export type FetchLike = (
  url: string,
  init: {
    method: "POST"
    headers: Record<string, string>
    body: string
    signal?: AbortSignal
  }
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>

/** Signs requests, verifies callbacks and calls LiqPay's server API. */
export class LiqPayClient {
  private readonly publicKey: string
  private readonly privateKey: string
  private readonly fetchImpl?: FetchLike

  constructor(publicKey: string, privateKey: string, fetchImpl?: FetchLike) {
    this.publicKey = publicKey
    this.privateKey = privateKey
    this.fetchImpl = fetchImpl
  }

  envelope(params: LiqPayRequestParams): LiqPayEnvelope {
    const data = encodeData({ version: 3, public_key: this.publicKey, ...params })
    return { data, signature: signData(this.privateKey, data) }
  }

  verify(envelope: LiqPayEnvelope): boolean {
    return verifySignature(this.privateKey, envelope.data, envelope.signature)
  }

  /**
   * Server API call. LiqPay answers HTTP 200 for API errors too, so callers read
   * `result` / `err_code` from the returned payload. A network error, timeout or
   * non-2xx status throws: LiqPay's answer is then unknown, not an error result.
   */
  async request(
    params: LiqPayRequestParams,
    timeoutMs: number = LIQPAY_TIMEOUT_MS
  ): Promise<LiqPayPayload> {
    const { data, signature } = this.envelope(params)
    const doFetch = this.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
    let response: Awaited<ReturnType<FetchLike>>
    try {
      response = await doFetch(LIQPAY_API_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ data, signature }).toString(),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `LiqPay API did not answer: ${(error as Error)?.message ?? "network error"}`
      )
    }
    if (!response.ok) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `LiqPay API answered HTTP ${response.status}`
      )
    }
    const payload = parsePayload(await response.json())
    if (!payload.status && !payload.result) throw new MedusaError(MedusaError.Types.UNEXPECTED_STATE, "LiqPay response has no status or result")
    if ((payload.public_key && payload.public_key !== this.publicKey) ||
      (payload.order_id && payload.order_id !== params.order_id)) {
      throw new MedusaError(MedusaError.Types.UNEXPECTED_STATE, "LiqPay response identity mismatch")
    }
    return payload
  }
}
