import { defineConfig } from "eslint/config"
import medusa from "@medusajs/eslint-plugin"

export default defineConfig([
  // Storefront code, not backend: it imports @medusajs/types like the Next.js Starter does.
  { ignores: ["examples/**"] },
  ...medusa.configs.recommended,
])
