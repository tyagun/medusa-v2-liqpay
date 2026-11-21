"use client"

// "Pay with LiqPay" for the Medusa Next.js Starter's payment step. Gets a fresh
// signed form from the server action and posts it to LiqPay's hosted page.

import { useEffect, useRef, useState } from "react"
import { type LiqPayForm, startLiqPayPayment } from "@lib/liqpay"

export function LiqPayPayButton() {
  const formRef = useRef<HTMLFormElement>(null)
  const [form, setForm] = useState<LiqPayForm | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const submitting = useRef(false)

  useEffect(() => {
    if (form) formRef.current?.submit()
  }, [form])

  const pay = async () => {
    if (submitting.current) return
    submitting.current = true
    setPending(true)
    try {
      setError(null)
      const result = await startLiqPayPayment()
      if ("error" in result) {
        setError(result.error)
        submitting.current = false
        setPending(false)
        return
      }
      setForm(result.form)
    } catch {
      setError("Unable to start payment. Check your connection and try again.")
      submitting.current = false
      setPending(false)
    }
  }

  return (
    <>
      <button type="button" onClick={pay} disabled={pending}>
        {pending ? "Redirecting to LiqPay…" : "Pay with LiqPay"}
      </button>
      {error && <p role="alert">{error}</p>}

      {/*
        No referrer: LiqPay's firewall blocks browsers whose liqpay.ua cookies contain
        "localhost" (its analytics cookie stores the referrer), which leaves the hosted
        page blank for months on a developer machine. Also set
        `export const metadata = { referrer: "no-referrer" }` on the checkout page.
      */}
      {form && (
        <form ref={formRef} method="POST" action={form.url} acceptCharset="utf-8" rel="noreferrer" hidden>
          <input type="hidden" name="data" value={form.data} />
          <input type="hidden" name="signature" value={form.signature} />
        </form>
      )}
    </>
  )
}
