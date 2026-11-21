import { MedusaError } from "@medusajs/framework/utils"

function invalid(message: string): never {
  throw new MedusaError(MedusaError.Types.INVALID_DATA, `medusa-plugin-liqpay: ${message}`)
}

/**
 * Checks the merchant keys every part of the plugin needs. `where` names the config entry
 * in the error ("plugin" or "provider"), so a boot failure points at the right place.
 */
export function validateKeys(options: Record<string, unknown> | undefined, where: string): void {
  for (const key of ["public_key", "private_key"]) {
    if (typeof options?.[key] !== "string" || !options[key]) {
      invalid(`${where} option "${key}" is required (the plugin and the provider take the same keys)`)
    }
  }
}

/** Checks an optional integer option: absent, or a whole number in [min, max]. */
export function validateInteger(value: unknown, name: string, min: number, max: number): void {
  if (value === undefined) return
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    invalid(`option "${name}" must be an integer from ${min} to ${max}`)
  }
}

/** Throws with the plugin's prefix; for option checks specific to one part. */
export function invalidOption(message: string): never {
  return invalid(message)
}
