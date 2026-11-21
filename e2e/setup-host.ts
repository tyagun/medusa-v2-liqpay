import type { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, MedusaError, Modules } from "@medusajs/framework/utils"
import { createRegionsWorkflow, createShippingOptionsWorkflow } from "@medusajs/medusa/core-flows"

/**
 * E2E fixture for a fresh `create-medusa-app` host with the demo seed. Idempotent. Adds:
 * - region "Ukraine" (UAH, country ua) with LiqPay and the system provider,
 * - Ukraine to the seed's service zone, plus a free UAH shipping option,
 * - a UAH price on every seeded variant that has none.
 *
 *   npx medusa exec ./src/scripts/liqpay-e2e-setup.ts
 */
export default async function setupLiqPayE2E({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const fulfillment = container.resolve(Modules.FULFILLMENT)
  const pricing = container.resolve(Modules.PRICING)

  const { data: regions } = await query.graph({
    entity: "region",
    fields: ["id", "currency_code"],
    filters: { currency_code: "uah" },
  })
  if (!regions.length) {
    await createRegionsWorkflow(container).run({
      input: {
        regions: [
          {
            name: "Ukraine",
            currency_code: "uah",
            countries: ["ua"],
            payment_providers: ["pp_liqpay_liqpay", "pp_system_default"],
          },
        ],
      },
    })
    logger.info("LiqPay E2E: created region Ukraine (UAH)")
  }

  const [zone] = await fulfillment.listServiceZones({}, { relations: ["geo_zones", "shipping_options"] })
  if (!zone) {
    throw new MedusaError(MedusaError.Types.NOT_FOUND, "No service zone; run the demo seed first")
  }
  if (!zone.geo_zones.some((g) => g.country_code === "ua")) {
    await fulfillment.createGeoZones({ service_zone_id: zone.id, type: "country", country_code: "ua" })
    logger.info("LiqPay E2E: added ua to the service zone")
  }

  const { data: options } = await query.graph({
    entity: "shipping_option",
    fields: ["id", "name", "shipping_profile_id", "prices.currency_code"],
    filters: { service_zone_id: zone.id },
  })
  const hasUah = options.some((o) => (o.prices ?? []).some((p) => p?.currency_code === "uah"))
  if (!hasUah) {
    await createShippingOptionsWorkflow(container).run({
      input: [
        {
          name: "Nova Poshta (E2E)",
          price_type: "flat",
          provider_id: "manual_manual",
          service_zone_id: zone.id,
          shipping_profile_id: options[0].shipping_profile_id!,
          type: { label: "Standard", description: "E2E", code: "e2e-uah" },
          prices: [{ currency_code: "uah", amount: 0 }],
          rules: [
            { attribute: "enabled_in_store", value: "true", operator: "eq" },
            { attribute: "is_return", value: "false", operator: "eq" },
          ],
        },
      ],
    })
    logger.info("LiqPay E2E: created a UAH shipping option")
  }

  const { data: variants } = await query.graph({
    entity: "product_variant",
    fields: ["id", "price_set.id", "price_set.prices.currency_code"],
  })
  let priced = 0
  for (const variant of variants) {
    const set = variant.price_set
    if (!set?.id || (set.prices ?? []).some((p) => p?.currency_code === "uah")) {
      continue
    }
    await pricing.addPrices({ priceSetId: set.id, prices: [{ amount: 150, currency_code: "uah" }] })
    priced++
  }
  logger.info(`LiqPay E2E: setup done (${priced} variants got a UAH price)`)
}
