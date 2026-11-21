import { toCheckoutOutcome } from "../lib/outcome"

const session = { amount: 150, currency_code: "uah" }
const paid = { amount: 150, currency: "UAH" }

describe("toCheckoutOutcome", () => {
  it("maps payment_not_found to not_paid", () => {
    expect(
      toCheckoutOutcome({ result: "error", err_code: "payment_not_found" }, true, session)
    ).toBe("not_paid")
  })

  it("counts sandbox as paid only in sandbox mode", () => {
    expect(toCheckoutOutcome({ status: "sandbox", ...paid }, true, session)).toBe("paid")
    expect(toCheckoutOutcome({ status: "sandbox", ...paid }, false, session)).toBe("failed")
    expect(toCheckoutOutcome({ status: "success", ...paid }, false, session)).toBe("paid")
  })

  it("reports a paid amount or currency that differs from the session as failed", () => {
    expect(toCheckoutOutcome({ status: "success", amount: 1, currency: "UAH" }, false, session)).toBe("needs_review")
    expect(toCheckoutOutcome({ status: "success", amount: 150, currency: "USD" }, false, session)).toBe("needs_review")
    expect(toCheckoutOutcome({ status: "success" }, false, session)).toBe("needs_review")
  })

  it("maps declines and errors to failed", () => {
    expect(toCheckoutOutcome({ status: "failure" }, true, session)).toBe("failed")
    expect(toCheckoutOutcome({ status: "error" }, true, session)).toBe("failed")
    expect(toCheckoutOutcome({ result: "error", err_code: "err_payment" }, true, session)).toBe("pending")
  })

  it("treats processing and verify steps as pending", () => {
    expect(toCheckoutOutcome({ status: "processing" }, true, session)).toBe("pending")
    expect(toCheckoutOutcome({ status: "3ds_verify" }, true, session)).toBe("pending")
    expect(toCheckoutOutcome({ status: "wait_secure" }, true, session)).toBe("pending")
  })
})
