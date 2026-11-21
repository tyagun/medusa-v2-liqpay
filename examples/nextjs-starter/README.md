# Next.js Starter example

Files for the [Medusa Next.js Starter](https://github.com/medusajs/nextjs-starter-medusa). Copy them into `src/` at the same paths. They use the starter's `@lib/config` SDK and `@lib/data/cookies` helpers.

| File | Purpose |
|---|---|
| `lib/liqpay.ts` | Server action that creates a LiqPay session and returns the signed form |
| `components/liqpay-pay-button.tsx` | Button that posts the form to LiqPay's hosted page |
| `app/[countryCode]/(checkout)/checkout/liqpay/return/route.ts` | `result_url` handler that completes the cart or reads the outcome |

Set the provider's `result_url` to `https://<storefront>/<countryCode>/checkout/liqpay/return`.

These files are adapted from a production storefront whose LiqPay flow was tested end to end in the sandbox. CI compiles these files against Next.js 15.5.29 and the installed Medusa SDK using `npm run check:storefront`; check them against your own starter version too. You also need to build the pending page (`/checkout/liqpay/pending`) and show the `?payment=failed|abandoned` messages on your payment step.

The example reuses an outstanding attempt and uses a fixed LiqPay form destination. Set `NEXT_PUBLIC_BASE_URL` to your HTTPS origin in production. Render `payment=needs_review` as a support/reconciliation message and disable starting another payment in that state. Pending-page polling must have backoff and a finite timeout; a payment marked paid can still fail cart completion because of stock or other cart validation errors.
