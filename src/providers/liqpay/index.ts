import { ModuleProvider, Modules } from "@medusajs/framework/utils"
import LiqPayProviderService from "./service"

export default ModuleProvider(Modules.PAYMENT, {
  services: [LiqPayProviderService],
})
