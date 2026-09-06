CREATE TYPE "public"."economic_event" AS ENUM('payment_settled', 'payment_refunded', 'dispute_opened', 'dispute_won', 'dispute_lost', 'payout_sent', 'payout_reversed', 'manual_adjustment', 'reversal');--> statement-breakpoint
CREATE TYPE "public"."ledger_account" AS ENUM('provider_balance', 'payout_clearing', 'unallocated_customer_funds', 'tax_payable', 'creator_payable', 'campaign_funds', 'refunds_payable', 'dispute_reserve', 'platform_revenue', 'provider_fee_expense', 'fx_adjustment');--> statement-breakpoint
CREATE TABLE "accounting_entries" (
	"entry_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_id" uuid NOT NULL,
	"leg" integer NOT NULL,
	"account" "ledger_account" NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"counterparty_type" text,
	"counterparty_id" text,
	"source_detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "accounting_transactions" (
	"transaction_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"economic_event" "economic_event" NOT NULL,
	"provider" text NOT NULL,
	"provider_resource_id" text,
	"environment" "whop_environment" NOT NULL,
	"currency" char(3) NOT NULL,
	"idempotency_key" text NOT NULL,
	"order_id" uuid,
	"reverses_transaction_id" uuid,
	"source_webhook_id" text,
	"description" text,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"occurred_at" timestamp with time zone,
	"metadata" jsonb
);
--> statement-breakpoint
ALTER TABLE "accounting_entries" ADD CONSTRAINT "accounting_entries_transaction_id_accounting_transactions_transaction_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."accounting_transactions"("transaction_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_transactions" ADD CONSTRAINT "accounting_transactions_order_id_payment_orders_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."payment_orders"("order_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_accounting_entry_leg" ON "accounting_entries" USING btree ("transaction_id","leg");--> statement-breakpoint
CREATE INDEX "idx_entries_transaction" ON "accounting_entries" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "idx_entries_account" ON "accounting_entries" USING btree ("account","created_at");--> statement-breakpoint
CREATE INDEX "idx_entries_counterparty" ON "accounting_entries" USING btree ("counterparty_type","counterparty_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_accounting_idempotency" ON "accounting_transactions" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_accounting_reversal" ON "accounting_transactions" USING btree ("reverses_transaction_id") WHERE reverses_transaction_id is not null;--> statement-breakpoint
CREATE INDEX "idx_accounting_posted" ON "accounting_transactions" USING btree ("posted_at");--> statement-breakpoint
CREATE INDEX "idx_accounting_event" ON "accounting_transactions" USING btree ("economic_event","posted_at");--> statement-breakpoint
CREATE INDEX "idx_accounting_resource" ON "accounting_transactions" USING btree ("provider","provider_resource_id");--> statement-breakpoint
CREATE INDEX "idx_accounting_order" ON "accounting_transactions" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "idx_accounting_webhook" ON "accounting_transactions" USING btree ("source_webhook_id");
--> statement-breakpoint
--
-- ===========================================================================
-- HAND-WRITTEN INVARIANTS.
--
-- Everything above is generated from src/lib/db/schema.ts. Everything below
-- expresses rules Drizzle cannot model: a self-reference, value checks, and
-- the balance rule that makes this a journal rather than two loose tables.
--
-- These are enforced by POSTGRES, so they hold for every writer — the
-- application, a migration, a console session, a future code path nobody
-- routed through src/lib/server/accounting/journal.ts.
--
-- drizzle-kit does not track triggers or check constraints, so a later
-- `db:generate` will neither recreate nor drop any of this. Changing a rule
-- below means writing the change into a new migration deliberately, which is
-- the correct amount of friction for a rule about money.
-- ===========================================================================

-- A reversal must point at a transaction that actually exists.
ALTER TABLE "accounting_transactions"
  ADD CONSTRAINT "accounting_transactions_reverses_fk"
  FOREIGN KEY ("reverses_transaction_id")
  REFERENCES "public"."accounting_transactions"("transaction_id")
  ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- ...and never at itself.
ALTER TABLE "accounting_transactions"
  ADD CONSTRAINT "accounting_transactions_no_self_reversal"
  CHECK ("reverses_transaction_id" IS NULL OR "reverses_transaction_id" <> "transaction_id");--> statement-breakpoint

-- Lowercase ISO 4217, on both tables, so a currency can never be ambiguous.
ALTER TABLE "accounting_transactions"
  ADD CONSTRAINT "accounting_transactions_currency_format"
  CHECK ("currency" ~ '^[a-z]{3}$');--> statement-breakpoint

ALTER TABLE "accounting_entries"
  ADD CONSTRAINT "accounting_entries_currency_format"
  CHECK ("currency" ~ '^[a-z]{3}$');--> statement-breakpoint

ALTER TABLE "accounting_transactions"
  ADD CONSTRAINT "accounting_transactions_provider_present"
  CHECK (length(btrim("provider")) > 0);--> statement-breakpoint

ALTER TABLE "accounting_transactions"
  ADD CONSTRAINT "accounting_transactions_key_present"
  CHECK (length(btrim("idempotency_key")) >= 8);--> statement-breakpoint

-- A zero leg moves nothing and can only ever pad a journal.
ALTER TABLE "accounting_entries"
  ADD CONSTRAINT "accounting_entries_amount_nonzero"
  CHECK ("amount_minor" <> 0);--> statement-breakpoint

ALTER TABLE "accounting_entries"
  ADD CONSTRAINT "accounting_entries_leg_positive"
  CHECK ("leg" >= 1);--> statement-breakpoint

--
-- APPEND-ONLY, enforced rather than promised.
--
-- The application has no UPDATE or DELETE path for either table, but "the code
-- does not do it" is not the same guarantee as "it cannot happen". These rules
-- make rewriting history fail loudly whoever attempts it.
--
CREATE OR REPLACE FUNCTION accounting_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'accounting is append-only: % on % is not permitted. Post a compensating transaction instead.',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER accounting_transactions_append_only
  BEFORE UPDATE OR DELETE ON "accounting_transactions"
  FOR EACH ROW EXECUTE FUNCTION accounting_append_only();--> statement-breakpoint

CREATE TRIGGER accounting_entries_append_only
  BEFORE UPDATE OR DELETE ON "accounting_entries"
  FOR EACH ROW EXECUTE FUNCTION accounting_append_only();--> statement-breakpoint

--
-- THE BALANCE RULE.
--
-- Every transaction must end its writing transaction with at least two legs,
-- all in the transaction's own currency, summing to exactly zero.
--
-- DEFERRABLE INITIALLY DEFERRED is not a detail: the check runs once, at
-- COMMIT, when all the legs are present. An immediate check would fire after
-- the first leg and reject every multi-leg journal ever written, which is to
-- say every real one.
--
CREATE OR REPLACE FUNCTION accounting_assert_balanced() RETURNS trigger AS $$
DECLARE
  target uuid;
  leg_count integer;
  residual bigint;
  wrong_currency integer;
  txn_currency char(3);
BEGIN
  target := NEW.transaction_id;

  SELECT t.currency INTO txn_currency
  FROM accounting_transactions t
  WHERE t.transaction_id = target;

  -- The header was rolled back; nothing to check.
  IF txn_currency IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT count(*), COALESCE(sum(e.amount_minor), 0),
         count(*) FILTER (WHERE e.currency <> txn_currency)
    INTO leg_count, residual, wrong_currency
  FROM accounting_entries e
  WHERE e.transaction_id = target;

  IF leg_count < 2 THEN
    RAISE EXCEPTION 'accounting transaction % has % leg(s); a journal needs at least 2',
      target, leg_count
      USING ERRCODE = 'check_violation';
  END IF;

  IF wrong_currency > 0 THEN
    RAISE EXCEPTION 'accounting transaction % has % leg(s) in a currency other than %',
      target, wrong_currency, txn_currency
      USING ERRCODE = 'check_violation';
  END IF;

  IF residual <> 0 THEN
    RAISE EXCEPTION 'accounting transaction % does not balance: legs sum to %',
      target, residual
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE CONSTRAINT TRIGGER accounting_entries_balanced
  AFTER INSERT ON "accounting_entries"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION accounting_assert_balanced();--> statement-breakpoint

--
-- ...and the other direction: a header written with NO legs at all would never
-- fire the trigger above, and would sit in the ledger as an event that
-- accounts for nothing.
--
CREATE OR REPLACE FUNCTION accounting_assert_has_legs() RETURNS trigger AS $$
DECLARE
  leg_count integer;
  residual bigint;
BEGIN
  SELECT count(*), COALESCE(sum(e.amount_minor), 0) INTO leg_count, residual
  FROM accounting_entries e
  WHERE e.transaction_id = NEW.transaction_id;

  IF leg_count < 2 OR residual <> 0 THEN
    RAISE EXCEPTION 'accounting transaction % is not a balanced journal: % leg(s), residual %',
      NEW.transaction_id, leg_count, residual
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE CONSTRAINT TRIGGER accounting_transactions_have_legs
  AFTER INSERT ON "accounting_transactions"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION accounting_assert_has_legs();
