import { Migration } from "@medusajs/framework/mikro-orm/migrations"
import { LEDGER_SCHEMA } from "../../../lib/ledger-schema"

/** LiqPay safety ledger: checkout attempts and refund operations. */
export class Migration20261121000000 extends Migration {
  async up(): Promise<void> {
    this.addSql(LEDGER_SCHEMA["001-payment-safety"])
  }

  /** The ledger is evidence that money may have moved; it is never dropped automatically. */
  async down(): Promise<void> {}
}
