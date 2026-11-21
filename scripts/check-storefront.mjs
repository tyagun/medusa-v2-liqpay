// Compile the shipped example against a pinned Next.js/Medusa SDK fixture.
// It never contacts a backend or payment gateway.
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { resolve } from "node:path"
import { spawnSync } from "node:child_process"
const require = createRequire(import.meta.url)
const destination = resolve(".cache/next-fixture")
rmSync(destination, { recursive: true, force: true })
mkdirSync(destination, { recursive: true })
cpSync("examples/nextjs-starter", `${destination}/src`, { recursive: true })
mkdirSync(`${destination}/src/lib/data`, { recursive: true })
writeFileSync(`${destination}/package.json`, JSON.stringify({ private: true, name: "liqpay-example-check" }))
writeFileSync(`${destination}/next.config.mjs`, "export default { experimental: { cpus: 1 }, eslint: { ignoreDuringBuilds: true } }\n")
writeFileSync(`${destination}/tsconfig.json`, JSON.stringify({ compilerOptions: {
  target: "ES2017", lib: ["dom", "esnext"], strict: true, noEmit: true, esModuleInterop: true,
  module: "esnext", moduleResolution: "bundler", jsx: "preserve", skipLibCheck: true,
  resolveJsonModule: true, isolatedModules: true, paths: { "@lib/*": ["./src/lib/*"] },
}, include: ["next-env.d.ts", "src/**/*.ts", "src/**/*.tsx", ".next/types/**/*.ts"] }))
writeFileSync(`${destination}/src/lib/config.ts`, `import Medusa from "@medusajs/js-sdk"
export const sdk = new Medusa({ baseUrl: "https://example.invalid" })\n`)
writeFileSync(`${destination}/src/lib/data/cookies.ts`, `import { cookies } from "next/headers"
export async function getCartId() { return (await cookies()).get("_medusa_cart_id")?.value }
export async function getAuthHeaders(): Promise<Record<string,string>> { return {} }
export async function getCacheTag(name: string) { return name }
export async function removeCartId() { (await cookies()).delete("_medusa_cart_id") }\n`)
writeFileSync(`${destination}/src/app/layout.tsx`, `export default function Layout({children}: {children: React.ReactNode}) {
  return <html lang="en"><body>{children}</body></html>
}\n`)
writeFileSync(`${destination}/src/app/page.tsx`, `import { LiqPayPayButton } from "../components/liqpay-pay-button"
export default function Page() { return <LiqPayPayButton /> }\n`)
const build = spawnSync(process.execPath, [require.resolve("next/dist/bin/next"), "build", destination], {
  stdio: "inherit", env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", NEXT_PUBLIC_BASE_URL: "https://example.invalid" },
})
process.exit(build.status ?? 1)
