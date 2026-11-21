# Contributing

Issues and pull requests are welcome. Every change needs to pass the unit tests, the type checks and the build. A change to the provider, the module or the routes also needs a passing end-to-end run.

```bash
npm install
npm test
npm run typecheck
npm run build
```

## End-to-end suite

`e2e/run.mjs` drives a real Medusa app through its Store, Admin and webhook HTTP APIs against the LiqPay sandbox. You need PostgreSQL and a LiqPay **sandbox** merchant (its public key starts with `sandbox_`).

The suite pays with LiqPay's public test card through the server API, because the hosted page needs a browser. The resulting payment has the same `sandbox` status as a payment made on the page.

1. **Create a host app** outside this repo:

   ```bash
   createdb liqpay_host
   npx create-medusa-app@latest liqpay-host --db-url postgres://localhost/liqpay_host --no-browser
   ```

2. **Install the plugin from this checkout:**

   ```bash
   # in this repo
   npx medusa plugin:publish
   # in the host app's backend
   npx medusa plugin:add medusa-plugin-liqpay
   ```

   After changing the plugin, run `npx medusa plugin:develop` here; it republishes on every change.

3. **Configure the host** as shown in the README's Configure section. Use `http://localhost:9000/hooks/payment/liqpay_liqpay` as `server_url`. The suite posts callbacks to it itself, so it does not need to be public. Add `LIQPAY_PUBLIC_KEY` and `LIQPAY_PRIVATE_KEY` to the host's `.env`. A `sandbox_` key puts the plugin in sandbox mode.

4. **Seed the fixture:** a UAH region with LiqPay, Ukraine in the shipping zone, and UAH prices.

   ```bash
   npx medusa db:migrate   # creates the plugin's safety ledger tables
   cp <this repo>/e2e/setup-host.ts src/scripts/liqpay-e2e-setup.ts
   npx medusa exec ./src/scripts/liqpay-e2e-setup.ts
   npx medusa user -e e2e-admin@example.com -p e2e-admin-pass
   npx medusa develop
   ```

5. **Run the suite** from this repo, with an env file outside it:

   ```bash
   # e2e.env
   PUBLISHABLE_KEY=pk_...          # Admin → Settings → Publishable API keys
   ADMIN_EMAIL=e2e-admin@example.com
   ADMIN_PASSWORD=e2e-admin-pass
   LIQPAY_PUBLIC_KEY=sandbox_...
   LIQPAY_PRIVATE_KEY=sandbox_...

   node --env-file=/path/to/e2e.env e2e/run.mjs
   ```

The suite covers these scenarios:

- signed checkout form with no secret in the session data;
- unpaid cart refused;
- paid cart with browser return gives one order with the payment captured;
- Admin live status, including the unauthenticated case;
- callback-only completion (the customer closed the tab);
- forged callback ignored;
- underpayment refused;
- sandbox refund refused and not recorded;
- store route 404 and missing publishable key.

After a run, check the backend log for webhook-processing errors. The hook route answers 200 whatever happens next, so the log is the only place they show.

Never commit keys. `e2e.env` and `.env` are git-ignored.
