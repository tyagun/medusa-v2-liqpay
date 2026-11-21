# Changelog

## 0.1.0 (unreleased)

First release.

- LiqPay payment provider (`medusa-plugin-liqpay/providers/liqpay`): hosted checkout with `action: "pay"`, live status on authorization, amount and currency check, signed webhook, refunds. Sandbox mode follows the key (`sandbox_` prefix), so a live key never accepts a test payment.
- Safety ledger in Medusa's database, created by `npx medusa db:migrate`; each write commits on its own connection. Refund attempts survive crashes; an unconfirmed refund blocks further refunds until it is reconciled, a confirmed success replays without moving money again, and a confirmed failure can be retried. A `medusa exec` script records an operator's resolution of an uncertain refund.
- Replaced checkout attempts (cart total changed, or a new attempt) are retired, never refused: their signed forms stay payable, so a late payment on one is held for review instead of completing a cart. A scheduled job rechecks retired attempts with LiqPay on a schedule that backs off with age (`recheck_batch_size`), so a lost callback cannot hide a payment. Only attempts where money may have moved are flagged.
- Admin: order-page widget with live **Check status**, and **Settings → LiqPay** listing flagged attempts (with **Mark reviewed**) and refunds with an unknown outcome. English and Ukrainian.
- `liqpay` module (from the plugin options) for status lookups, the recheck job and the review routes. Status lookups are coalesced, cached for five seconds and capped per process (`status_concurrency`, default 16); over the cap the routes answer `503`.
- Routes: `GET /store/liqpay/carts/:id/status`, `GET /admin/liqpay/payments/:id/status`, `GET /admin/liqpay/reviews`, `POST /admin/liqpay/attempts/:session_id/review`. Configurable rate limits (`rate_limits`) per cart, per payment collection and per callback IP, never per shopper IP.
- Validation of gateway payloads and response identity; paid mismatches are told apart from declines.
- Next.js Starter example (compiled in CI) that reuses a payment session only while it matches the cart.
- Typed exports: `medusa-plugin-liqpay/workflows`, `medusa-plugin-liqpay/lib`.
