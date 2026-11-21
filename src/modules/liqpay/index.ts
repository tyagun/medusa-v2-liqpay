import type { LoaderOptions } from "@medusajs/framework/types"
import { Module } from "@medusajs/framework/utils"
import { LIQPAY_MODULE } from "../../lib/constants"
import type { LiqPayModuleOptions } from "../../lib/types"
import LiqPayModuleService, { validateModuleOptions } from "./service"

export { LIQPAY_MODULE }

async function validateOptionsLoader({ options }: LoaderOptions<LiqPayModuleOptions>) {
  validateModuleOptions(options)
}

export default Module(LIQPAY_MODULE, {
  service: LiqPayModuleService,
  loaders: [validateOptionsLoader],
})
