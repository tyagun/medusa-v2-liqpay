// End-to-end check of medusa-plugin-liqpay against a running Medusa host and the real
// LiqPay sandbox. It drives the Store, Admin and webhook HTTP APIs the way a storefront
// and LiqPay do, and pays with LiqPay's public sandbox test card server-side (the hosted
// page needs a browser; its result is the same `sandbox` status this produces).
//
//   node --env-file=.env e2e/run.mjs
//
// Env: BACKEND_URL (default http://localhost:9000), PUBLISHABLE_KEY, ADMIN_EMAIL,
// ADMIN_PASSWORD, LIQPAY_PUBLIC_KEY / LIQPAY_PRIVATE_KEY (a sandbox merchant).

import { createHash } from "node:crypto"

const BACKEND = process.env.BACKEND_URL ?? "http://localhost:9000"
const PK = need("PUBLISHABLE_KEY")
const PUBLIC_KEY = need("LIQPAY_PUBLIC_KEY")
const PRIVATE_KEY = need("LIQPAY_PRIVATE_KEY")
const ADMIN_EMAIL = need("ADMIN_EMAIL")
const ADMIN_PASSWORD = need("ADMIN_PASSWORD")
const PROVIDER = "pp_liqpay_liqpay"
const TEST_CARD = { card: "4242424242424242", card_exp_month: "03", card_exp_year: "29", card_cvv: "111" }

function need(name) {
  const value = process.env[name]
  if (!value) {
    console.error(`Missing env ${name}`)
    process.exit(2)
  }
  return value
}

// ------------------------------------------------------------------ helpers

const results = []
async function scenario(name, fn) {
  const started = Date.now()
  try {
    await fn()
    results.push({ name, ok: true })
    console.log(`PASS  ${name}  (${((Date.now() - started) / 1000).toFixed(1)}s)`)
  } catch (error) {
    results.push({ name, ok: false })
    console.log(`FAIL  ${name}\n      ${error?.stack ?? error}`)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function http(method, path, { body, headers = {}, form } = {}) {
  const res = await fetch(`${BACKEND}${path}`, {
    method,
    headers: {
      ...(form
        ? { "content-type": "application/x-www-form-urlencoded" }
        : body
          ? { "content-type": "application/json" }
          : {}),
      ...headers,
    },
    body: form ? new URLSearchParams(form).toString() : body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json
  try {
    json = text ? JSON.parse(text) : undefined
  } catch {
    json = text
  }
  return { status: res.status, json }
}

const store = (method, path, body) => http(method, path, { body, headers: { "x-publishable-api-key": PK } })

let adminToken
async function admin(method, path, body) {
  if (!adminToken) {
    const { json } = await http("POST", "/auth/user/emailpass", {
      body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    })
    adminToken = json?.token
    assert(adminToken, `admin login failed: ${JSON.stringify(json)}`)
  }
  return http(method, path, { body, headers: { authorization: `Bearer ${adminToken}` } })
}

const sign = (data) => createHash("sha1").update(PRIVATE_KEY + data + PRIVATE_KEY).digest("base64")
const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64")
const decode = (data) => JSON.parse(Buffer.from(data, "base64").toString("utf8"))

/** Server-side sandbox card payment for a session's order_id (what the hosted page does). */
async function payInSandbox(orderId, amount, currency = "UAH") {
  const data = encode({
    version: 3,
    public_key: PUBLIC_KEY,
    action: "pay",
    order_id: orderId,
    amount,
    currency,
    description: "medusa-plugin-liqpay e2e",
    sandbox: 1,
    ...TEST_CARD,
  })
  const res = await fetch("https://www.liqpay.ua/api/request", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ data, signature: sign(data) }).toString(),
  })
  const json = await res.json()
  assert(json.status === "sandbox" || json.status === "success", `sandbox pay failed: ${JSON.stringify(json)}`)
  return json
}

/** A cart in the UAH region, ready to pay, with a fresh LiqPay session. */
async function readyCart() {
  const { json: r } = await store("GET", "/store/regions?currency_code=uah")
  const region = r.regions?.[0]
  assert(region, "no UAH region; run the e2e setup script")
  const { json: p } = await store("GET", `/store/products?region_id=${region.id}&fields=*variants.calculated_price&limit=20`)
  const variant = p.products
    .flatMap((x) => x.variants)
    .find((v) => v.calculated_price?.calculated_amount > 0)
  assert(variant, "no variant priced in UAH")

  const { json: c } = await store("POST", "/store/carts", {
    region_id: region.id,
    email: "liqpay-e2e@example.com",
    items: [{ variant_id: variant.id, quantity: 1 }],
    shipping_address: {
      first_name: "Тест",
      last_name: "LiqPay",
      address_1: "вул. Хрещатик, 1",
      city: "Київ",
      country_code: "ua",
      postal_code: "01001",
      phone: "+380000000000",
    },
  })
  const cart = c.cart
  assert(cart?.id, `cart create failed: ${JSON.stringify(c)}`)

  const { json: so } = await store("GET", `/store/shipping-options?cart_id=${cart.id}`)
  // The setup script's UAH option; the seed's options in the same zone have no UAH price.
  const option = so.shipping_options?.find((o) => o.name === "Nova Poshta (E2E)")
  assert(option, `no shipping option for ua: ${JSON.stringify(so)}`)
  const sm = await store("POST", `/store/carts/${cart.id}/shipping-methods`, { option_id: option.id })
  assert(sm.status === 200, `shipping method: ${JSON.stringify(sm.json)}`)

  return { cart: sm.json.cart, ...(await newSession(sm.json.cart.id)) }
}

async function newSession(cartId) {
  const { json: pc } = await store("POST", "/store/payment-collections", { cart_id: cartId })
  const collection = pc.payment_collection
  assert(collection?.id, `payment collection: ${JSON.stringify(pc)}`)
  const ps = await store("POST", `/store/payment-collections/${collection.id}/payment-sessions`, {
    provider_id: PROVIDER,
  })
  assert(ps.status === 200, `payment session: ${JSON.stringify(ps.json)}`)
  const session = ps.json.payment_collection.payment_sessions.find((s) => s.provider_id === PROVIDER)
  assert(session, "no LiqPay session in the collection")
  return { session, total: Number(ps.json.payment_collection.amount) }
}

const outcome = async (cartId) => (await store("GET", `/store/liqpay/carts/${cartId}/status`)).json

async function waitFor(fn, timeoutMs = 30_000) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const value = await fn()
    if (value) return value
    await sleep(1000)
  }
  return null
}

// ---------------------------------------------------------------- scenarios

let paidOrder

await scenario("session data carries a signed checkout form and no secret", async () => {
  const { session, total } = await readyCart()
  const d = session.data
  assert(d.checkout_url === "https://www.liqpay.ua/api/3/checkout", "checkout_url")
  assert(d.session_id === session.id, "session_id is the Medusa session id")
  assert(d.checkout_signature === sign(d.checkout_data), "signature matches the private key")
  assert(!JSON.stringify(d).includes(PRIVATE_KEY), "private key leaked into session data")
  const params = decode(d.checkout_data)
  assert(params.action === "pay" && params.version === 3, "action pay, version 3")
  assert(params.order_id === session.id, "order_id = session id")
  assert(params.currency === "UAH" && params.amount === total, `amount ${params.amount} vs total ${total}`)
  assert(params.sandbox === 1, "sandbox flag")
  assert(params.server_url.endsWith("/hooks/payment/liqpay_liqpay"), "server_url")
})

await scenario("unpaid: completion is refused, outcome is not_paid, cart stays open", async () => {
  const { cart } = await readyCart()
  const done = await store("POST", `/store/carts/${cart.id}/complete`)
  assert(done.json?.type !== "order", `unpaid cart completed: ${JSON.stringify(done.json)}`)
  const o = await outcome(cart.id)
  assert(o.outcome === "not_paid" && o.completed === false, JSON.stringify(o))
})

await scenario("paid + browser return: one order, payment captured", async () => {
  const { cart, session, total } = await readyCart()
  await payInSandbox(session.id, total)
  const o = await outcome(cart.id)
  assert(o.outcome === "paid" && o.completed === false, JSON.stringify(o))
  const done = await store("POST", `/store/carts/${cart.id}/complete`)
  assert(done.json?.type === "order", `complete: ${JSON.stringify(done.json)}`)
  paidOrder = done.json.order
  const again = await store("POST", `/store/carts/${cart.id}/complete`)
  assert(again.json?.order?.id === paidOrder.id, "second completion returns the same order")
  const { json } = await admin(
    "GET",
    `/admin/orders/${paidOrder.id}?fields=payment_status,*payment_collections.payments`
  )
  assert(json.order.payment_status === "captured", `payment_status ${json.order.payment_status}`)
  const payment = json.order.payment_collections[0].payments[0]
  assert(payment.provider_id === PROVIDER, "provider id")
  assert(payment.data.status === "sandbox" && payment.data.transaction_id, "stored LiqPay fields")
  paidOrder.payment_id = payment.id
})

await scenario("admin live status route returns LiqPay's named fields", async () => {
  assert(paidOrder?.payment_id, "needs the previous scenario")
  const { status, json } = await admin("GET", `/admin/liqpay/payments/${paidOrder.payment_id}/status`)
  assert(status === 200, `status ${status}`)
  const live = json.liqpay_status
  assert(live.found === true && live.status === "sandbox", JSON.stringify(live))
  assert(typeof live.transaction_id === "number" && live.currency === "UAH", "named fields")
  assert(!("public_key" in live), "raw payload leaked")
  const anon = await http("GET", `/admin/liqpay/payments/${paidOrder.payment_id}/status`)
  assert(anon.status === 401, `unauthenticated admin route answered ${anon.status}`)
})

await scenario("paid + tab closed: the signed callback alone creates the order", async () => {
  const { cart, session, total } = await readyCart()
  const paid = await payInSandbox(session.id, total)
  const data = encode({ ...paid, order_id: session.id, amount: total, currency: "UAH", status: paid.status })
  const hook = await http("POST", "/hooks/payment/liqpay_liqpay", { form: { data, signature: sign(data) } })
  assert(hook.status === 200, `hook answered ${hook.status}`)
  const o = await waitFor(async () => {
    const value = await outcome(cart.id)
    return value.completed ? value : null
  }, 45_000)
  assert(o?.completed === true, "callback did not complete the cart within 45 s")
  const done = await store("POST", `/store/carts/${cart.id}/complete`)
  assert(done.json?.type === "order", "late browser return gets the callback's order")
})

await scenario("forged callback is ignored", async () => {
  const { cart, session, total } = await readyCart()
  const data = encode({ order_id: session.id, status: "success", amount: total, currency: "UAH" })
  const hook = await http("POST", "/hooks/payment/liqpay_liqpay", {
    form: { data, signature: "forged" + sign(data).slice(6) },
  })
  assert(hook.status === 200, `hook answered ${hook.status}`)
  await sleep(10_000)
  const o = await outcome(cart.id)
  assert(o.completed === false && o.outcome === "not_paid", JSON.stringify(o))
})

await scenario("paid amount different from the session is refused", async () => {
  const { cart, session } = await readyCart()
  await payInSandbox(session.id, 1)
  const done = await store("POST", `/store/carts/${cart.id}/complete`)
  assert(done.json?.type !== "order", "underpaid cart completed")
  const o = await outcome(cart.id)
  assert(o.outcome === "failed" && o.completed === false, JSON.stringify(o))
})

await scenario("refund of a sandbox payment surfaces LiqPay's refusal and records nothing", async () => {
  assert(paidOrder?.payment_id, "needs the paid scenario")
  const res = await admin("POST", `/admin/payments/${paidOrder.payment_id}/refund`, { amount: 1 })
  assert(res.status >= 400, `refund answered ${res.status}`)
  assert(/LiqPay refund failed/.test(JSON.stringify(res.json)), JSON.stringify(res.json))
  const { json } = await admin("GET", `/admin/payments/${paidOrder.payment_id}?fields=*refunds`)
  assert((json.payment.refunds ?? []).length === 0, "a refund row was recorded")
})

await scenario("store outcome route: 404 for an unknown cart, needs a publishable key", async () => {
  const missing = await store("GET", "/store/liqpay/carts/cart_does_not_exist/status")
  assert(missing.status === 404, `unknown cart answered ${missing.status}`)
  const nokey = await http("GET", "/store/liqpay/carts/cart_does_not_exist/status")
  assert(nokey.status === 400 || nokey.status === 401, `no key answered ${nokey.status}`)
})

const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} scenarios passed`)
process.exit(failed ? 1 : 0)
