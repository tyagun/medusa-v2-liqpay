/**
 * LiqPay types. Field names follow LiqPay API v3: https://www.liqpay.ua/en/documentation
 */

/**
 * Options of the payment provider (`medusa-plugin-liqpay/providers/liqpay`).
 * Sandbox mode follows the key: a public key starting with `sandbox_` is a LiqPay sandbox
 * merchant, and only then does LiqPay's `sandbox` status count as paid.
 */
export type LiqPayProviderOptions = {
  /** Merchant public key. Sandbox merchants have keys starting with `sandbox_`. */
  public_key: string
  /** Merchant private key. Never leaves the server. */
  private_key: string
  /** Absolute URL LiqPay sends the customer's browser back to after payment. */
  result_url: string
  /** Absolute URL of Medusa's webhook route: `https://<backend>/hooks/payment/liqpay_<id>`. */
  server_url: string
  /** Payment description shown on LiqPay's page. Default: "Order payment". */
  description?: string
  /** Language of LiqPay's checkout page. Default: "uk". */
  language?: LiqPayLanguage
}

/**
 * Per-process request limits of the plugin's middleware, per minute. Every limit is keyed
 * by a cart, a payment collection or (for LiqPay's own callbacks) the caller's IP, never
 * by shopper IP: storefront servers send every shopper's requests from one address.
 */
export type LiqPayRateLimits = {
  /** `GET /store/liqpay/carts/:id/status` per cart. Default 60. */
  status_per_cart?: number
  /** LiqPay payment session creation per payment collection. Default 10. */
  sessions_per_collection?: number
  /** Callbacks on `/hooks/payment/liqpay_*` per client IP. Default 300. */
  callbacks_per_ip?: number
}

/** Options of the plugin's `liqpay` module (the `plugins` entry), used by its API routes. */
export type LiqPayModuleOptions = {
  public_key: string
  private_key: string
  /** Concurrent LiqPay status requests per process. Default 16. */
  status_concurrency?: number
  /** Middleware request limits, or `false` to leave rate limiting to your gateway. */
  rate_limits?: LiqPayRateLimits | false
  /** Replaced attempts rechecked per run of the 15-minute recheck job. Default 50. */
  recheck_batch_size?: number
}

export type LiqPayLanguage = "uk" | "en"

/** Statuses LiqPay returns in callbacks and `status` requests. Unknown values fall back to pending. */
export type LiqPayStatus =
  | "success"
  | "sandbox"
  | "failure"
  | "error"
  | "reversed"
  | "hold_wait"
  | "processing"
  | "prepared"
  | "wait_accept"
  | "wait_secure"
  | "wait_card"
  | "wait_lc"
  | "wait_reserve"
  | "invoice_wait"
  | "cash_wait"
  | "3ds_verify"
  | "otp_verify"
  | "cvv_verify"
  | "sender_verify"
  | "receiver_verify"
  | "phone_verify"
  | "ivr_verify"
  | "pin_verify"
  | "captcha_verify"
  | "password_verify"
  | "senderapp_verify"

/** Request parameters signed into the `data` envelope. */
export type LiqPayRequestParams = {
  action: "pay" | "status" | "refund"
  order_id: string
  amount?: number
  currency?: string
  description?: string
  result_url?: string
  server_url?: string
  language?: LiqPayLanguage
  sandbox?: 1
  /**
   * Server-side card payment. Only for test scripts paying with LiqPay's public test
   * card against a sandbox merchant; the checkout flow never sends card data.
   */
  card?: string
  card_exp_month?: string
  card_exp_year?: string
  card_cvv?: string
}

/**
 * Body of a callback (decoded `data`) and of an `api/request` response.
 * On API errors `result` is "error" and `err_code` is set; the HTTP status is still 200.
 */
export type LiqPayPayload = {
  /** Refund funded by future payments rather than immediately from the merchant account. */
  wait_amount?: boolean
  result?: "ok" | "error"
  status?: LiqPayStatus | string
  err_code?: string
  err_description?: string
  public_key?: string
  order_id?: string
  liqpay_order_id?: string
  payment_id?: number
  transaction_id?: number
  paytype?: string
  sender_card_mask2?: string
  amount?: number
  currency?: string
  is_3ds?: boolean
  create_date?: number
  end_date?: number
}

/** Signed form fields, posted by the browser to the checkout URL and by LiqPay to server_url. */
export type LiqPayEnvelope = {
  data: string
  signature: string
}

/**
 * The payment session `data` the provider persists. Flat and named (never a spread API
 * response). It reaches the storefront, so it holds no secret: the checkout signature
 * is the standard public form field.
 */
export type LiqPaySessionData = {
  session_id: string
  currency_code: string
  amount: number
  /** The storefront posts `data` = checkout_data and `signature` = checkout_signature here. */
  checkout_url: string
  checkout_data: string
  checkout_signature: string
  status: LiqPayStatus | "created" | string
  is_sandbox: boolean
  liqpay_payment_id?: number
  liqpay_order_id?: string
  transaction_id?: number
  paytype?: string
  sender_card_mask2?: string
  err_code?: string
  err_description?: string
  refunded_amount?: number
}

/** A replaced or flagged attempt as `GET /admin/liqpay/reviews` lists it. */
export type AttemptForReview = {
  session_id: string
  amount: number | null
  currency_code: string | null
  last_status: { status?: string; amount?: number; currency?: string; payment_id?: number } | null
  retired: boolean
  retired_at: string | null
  created_at: string
  updated_at: string
}

/** A refund whose outcome is unknown, as `GET /admin/liqpay/reviews` lists it. */
export type RefundForReview = {
  session_id: string
  operation_id: string
  amount: number
  state: "pending" | "unknown"
  created_at: string
  updated_at: string
}

/** Body of `GET /admin/liqpay/reviews`. */
export type LiqPayReviewList = {
  attempts: AttemptForReview[]
  refunds: RefundForReview[]
}
