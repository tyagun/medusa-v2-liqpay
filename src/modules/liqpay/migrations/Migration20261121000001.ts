import { Migration } from "@medusajs/framework/mikro-orm/migrations"
import { LEDGER_SCHEMA } from "../../../lib/ledger-schema"

/** Review state of retired attempts: flag only on evidence, recheck the rest. */
export class Migration20261121000001 extends Migration {
  async up(): Promise<void> {
    this.addSql(LEDGER_SCHEMA["002-attempt-review"])
  }

  /** Columns hold review evidence; they are never dropped automatically. */
  async down(): Promise<void> {}
}
