import { defineMiddlewares, validateAndTransformBody } from "@medusajs/framework/http"
import type { MedusaRequest, MedusaResponse, MedusaNextFunction } from "@medusajs/framework/http"
import { z } from "@medusajs/framework/zod"
import { LIQPAY_MODULE, isLiqPayProviderId } from "../lib/constants"
import type LiqPayModuleService from "../modules/liqpay/service"

function liqpay(req: MedusaRequest): LiqPayModuleService {
  return req.scope.resolve<LiqPayModuleService>(LIQPAY_MODULE)
}

function tooMany(res: MedusaResponse, message: string) {
  res.setHeader("Retry-After", "60")
  res.status(429).json({ message })
}

/**
 * Status lookups are limited per cart, not per client IP: storefront servers (the Next.js
 * Starter's server actions and route handlers) send every shopper's requests from one IP.
 */
function limitStatus(req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction) {
  res.setHeader("Cache-Control", "no-store")
  if (!liqpay(req).allowRequest("status", req.params.id ?? req.path)) {
    return tooMany(res, "Too many LiqPay status requests")
  }
  next()
}

/**
 * Each LiqPay session signs a payable form and writes a ledger row, and the Store API
 * needs only a publishable key, so LiqPay session creation is limited per payment
 * collection. Other providers' sessions pass through untouched.
 */
export function limitSessions(req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction) {
  const providerId = (req.body as { provider_id?: unknown } | undefined)?.provider_id
  if (!isLiqPayProviderId(providerId)) return next()
  if (!liqpay(req).allowRequest("session", req.params.id ?? req.path)) {
    return tooMany(res, "Too many LiqPay payment attempts")
  }
  next()
}

// LiqPay calls this route directly, so the client IP is LiqPay's (or an attacker's).
// req.ip uses the host's trusted-proxy configuration; never read forwarded headers directly.
function verifyHook(req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction) {
  const service = liqpay(req)
  if (!service.allowRequest("callback", req.ip ?? "unknown")) {
    res.setHeader("Retry-After", "60")
    res.sendStatus(429)
    return
  }
  if (!service.verifyCallback(req.body)) {
    res.sendStatus(400)
    return
  }
  next()
}

export const MarkReviewedSchema = z.object({ note: z.string().trim().min(1).max(1000) })

export default defineMiddlewares({ routes: [
  { matcher: "/store/liqpay/carts/:id/status", methods: ["GET"], middlewares: [limitStatus] },
  { matcher: "/store/payment-collections/:id/payment-sessions", methods: ["POST"],
    middlewares: [limitSessions] },
  { matcher: /^\/hooks\/payment\/(?:pp_)?liqpay_[^/]+$/, methods: ["POST"],
    bodyParser: { sizeLimit: "96kb", preserveRawBody: true }, middlewares: [verifyHook] },
  { matcher: "/admin/liqpay/attempts/:session_id/review", methods: ["POST"],
    middlewares: [validateAndTransformBody(MarkReviewedSchema)] },
] })
