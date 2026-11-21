import en from "./json/en.json" with { type: "json" }
import uk from "./json/uk.json" with { type: "json" }

/** Loaded under the `liqpay` namespace so keys never collide with Admin's or other plugins'. */
export default {
  en: { liqpay: en },
  uk: { liqpay: uk },
}
