# Payment safety deployment and recovery

## Deploy

1. Back up the database. Register both the plugin entry and the provider (see the README), then run `npx medusa db:migrate`. It creates the ledger tables (`liqpay_attempt`, `liqpay_refund_operation`) in Medusa's database, alongside every other module's tables. Migrations are idempotent, so a database whose ledger tables were created by hand from an earlier copy of the SQL is upgraded in place.
2. The ledger uses Medusa's own database connection, so every API and worker instance shares it with no extra configuration. Each ledger write runs in its own transaction on its own pooled connection.
3. Deploy the plugin entry as well as the provider. Besides the migrations, it verifies callback signatures before Medusa enqueues events, rate-limits LiqPay routes and runs the recheck job. A provider-only deployment has none of these.
4. Enforce cluster-wide rate limits at the gateway (then you may set `rate_limits: false` on the plugin entry) for `/store/liqpay/*`, payment-session creation and `/hooks/payment/liqpay_*` (also the `pp_liqpay_*` spelling). Configure Express trusted proxies correctly. The plugin's limits are per process, not a distributed DDoS defense. Do not disable TLS certificate verification.
5. Watch **Settings → LiqPay** in Admin, and alert on the `LiqPay:` error logs. Never delete ledger rows as routine cleanup; back the ledger up with the commerce database.

A missing table or a database outage fails payment mutations closed. Every ledger write commits in its own transaction on its own connection, independent of the Medusa request around it, so a rollback or a worker crash does not erase evidence that money may have moved. Ledger statements time out after 5 s.

## Dependency policy

The development lockfile updates AJV and overrides BullMQ’s UUID dependency to 11.1.1. BullMQ uses its compatible `v4()` API. The Next.js 15 build fixture uses a patched PostCSS override. npm overrides in a plugin are not inherited by consuming applications: audit your host lockfile and apply equivalent tested overrides or upstream updates there.

## Uncertain refunds

**Settings → LiqPay** lists refunds in state `pending` or `unknown`. `pending` means the operation was committed before the call to LiqPay; it may also mean the worker crashed. Age alone NEVER makes it safe to retry. An unknown or pending operation blocks every further refund on that payment, even with a different key. Refunds with `wait_amount=true` are also held for reconciliation because they depend on future merchant payments.

1. Stop all API processes and payment workers that can issue refunds. This prevents resolving a suspended operation while its original process can still resume and send money.
2. Match the merchant, session/order ID, amount, timestamp and transaction in the LiqPay cabinet. A payment's aggregate status alone does not prove whether a particular partial refund succeeded. If the result remains uncertain, leave the operation blocked.
3. Once independently confirmed, record the operator and evidence (case ID or merchant transaction reference; no card or secret data):

```sh
# from the Medusa app's directory, with its usual environment
npx medusa exec ./node_modules/medusa-plugin-liqpay/.medusa/server/src/scripts/reconcile-refund.js \
  payses_ID ORIGINAL_OPERATION_ID succeeded operator@example.com 'Merchant refund reference ABC' workers-stopped
```

The script runs inside your Medusa app, so it uses the app's database and the plugin entry's merchant keys. The last argument, `workers-stopped`, confirms step 1. It changes local evidence only; it never calls LiqPay. Use `failed` only when LiqPay confirms the request did not refund money and will not complete later.

4. Restart workers. For a confirmed success, replay the original Medusa refund with the **same idempotency key** to record it in Medusa without sending it again. If the host cannot replay that key, reconcile through a controlled host workflow; do not click a fresh refund. For a confirmed failure, retry the refund with the same key or a new one.

A refund LiqPay itself answered as failed (an error result and a failed status) moved no money, so it is not blocked: retrying it with the same key sends it again. Successful operations and their saved responses remain replayable. Legacy `refunded_amount` is retained as a baseline when the first ledger operation is created. The ledger's totals describe refunds issued through this integration; reconcile cabinet-issued refunds separately.

## Replaced checkout attempts

Medusa deletes a payment session when the cart total changes or a new attempt replaces it. The provider never refuses that: Medusa logs and ignores a refusal, which would leave the old session payable at its old amount. A signed LiqPay form cannot be revoked, so the deleted attempt is retired in `liqpay_attempt` (`retired=true`, `retired_at`) and watched:

- A callback on a retired attempt never completes a cart. Its status is recorded, an error is logged, and the attempt is flagged (`needs_review=true`) unless LiqPay reports no payment or a failure.
- A scheduled job (`recheck-liqpay-attempts`, every 15 minutes) asks LiqPay about retired attempts that are not flagged, in case a callback was lost. The wait between checks doubles with the attempt's age (1 h, 2 h, 4 h, …), capped at 7 days, which is about 13 checks per attempt. Each run checks up to `recheck_batch_size` attempts (default 50), four at a time. After 30 days with no payment an attempt is closed and no longer polled; a late callback still flags it.
- An attempt that LiqPay had already reported paid when it was retired is flagged at once.
- If the ledger is unreachable when a session is deleted, the session is still deleted and an error naming it is logged; check that attempt by hand.

Flagged attempts appear in **Settings → LiqPay** with the signed amount and LiqPay's last status. For each:

1. Find the payment in the LiqPay cabinet by its order ID (the session ID shown) and compare the amount with the signed amount.
2. Either refund it in the cabinet, or complete the intended order through an explicitly reviewed recovery. The original Medusa payment session is soft-deleted but keeps its payment collection and cart link; keep soft-deleted sessions until their attempts are reconciled. Do not attach the payment to the newer cart automatically: prices, items and stock may have changed.
3. Click **Mark reviewed** and note what you did. The admin user, note and time are stored with the attempt. A later payment on it flags it again.

Upgrading from a version that flagged every retired attempt keeps only flags with evidence that money may have moved; the recheck job asks LiqPay about the rest within the hour.

## Verification

`LIQPAY_TEST_DATABASE_URL=... npm test -- --runInBand` runs real PostgreSQL concurrency, restart, recheck and review tests against a dedicated test database, through a knex connection like Medusa's. The suite applies the migrations and deletes only its own randomly namespaced test records. Never point it at production. Without this variable, the integration tests are skipped; CI supplies a PostgreSQL service.

Before rollout, also test the complete host flow with real sandbox callbacks, two open checkout tabs, a cart changed mid-payment, delayed callbacks, proxy middleware and rate limits, and a small supervised live refund. The sandbox cannot establish live refund behavior.
