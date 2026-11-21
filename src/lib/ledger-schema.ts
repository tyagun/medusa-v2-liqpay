/**
 * Safety ledger schema, in order. The Medusa migrations of the plugin's `liqpay` module
 * run these through `npx medusa db:migrate`. Statements are idempotent, so a database
 * migrated by hand from an earlier copy of this SQL is upgraded in place.
 */
export const LEDGER_SCHEMA = {
  "001-payment-safety": `
CREATE TABLE IF NOT EXISTS liqpay_attempt (
  merchant text NOT NULL,
  session_id text NOT NULL,
  snapshot jsonb NOT NULL,
  retired boolean NOT NULL DEFAULT false,
  needs_review boolean NOT NULL DEFAULT false,
  last_status jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant, session_id)
);
CREATE TABLE IF NOT EXISTS liqpay_refund_operation (
  merchant text NOT NULL,
  session_id text NOT NULL,
  operation_id text NOT NULL,
  amount numeric NOT NULL CHECK (amount > 0),
  state text NOT NULL CHECK (state IN ('pending', 'unknown', 'succeeded', 'failed')),
  response jsonb,
  baseline_amount numeric NOT NULL DEFAULT 0 CHECK (baseline_amount >= 0),
  resolution jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant, session_id, operation_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS liqpay_one_unresolved_refund
  ON liqpay_refund_operation (merchant, session_id)
  WHERE state IN ('pending', 'unknown');
`,
  "002-attempt-review": `
ALTER TABLE liqpay_attempt ADD COLUMN IF NOT EXISTS retired_at timestamptz;
ALTER TABLE liqpay_attempt ADD COLUMN IF NOT EXISTS checked_at timestamptz;
ALTER TABLE liqpay_attempt ADD COLUMN IF NOT EXISTS closed boolean NOT NULL DEFAULT false;
ALTER TABLE liqpay_attempt ADD COLUMN IF NOT EXISTS reviewed jsonb;
CREATE INDEX IF NOT EXISTS liqpay_attempt_review
  ON liqpay_attempt (merchant, updated_at) WHERE needs_review;
CREATE INDEX IF NOT EXISTS liqpay_attempt_recheck
  ON liqpay_attempt (merchant, checked_at) WHERE retired AND NOT needs_review AND NOT closed;
UPDATE liqpay_attempt SET retired_at = updated_at WHERE retired AND retired_at IS NULL;
-- Earlier versions flagged every retired attempt. Keep only flags with evidence that
-- money may have moved; the recheck job asks LiqPay about the rest again.
UPDATE liqpay_attempt SET needs_review = false
  WHERE retired AND needs_review AND reviewed IS NULL
  AND COALESCE(last_status->>'status', '') IN ('', 'failure', 'error');
`,
} as const

export type LedgerMigrationName = keyof typeof LEDGER_SCHEMA
