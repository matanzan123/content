CREATE TYPE "public"."dispute_alert_status" AS ENUM('actionable', 'not_actionable');--> statement-breakpoint
CREATE TYPE "public"."dispute_status" AS ENUM('warning', 'open', 'won', 'lost', 'closed');--> statement-breakpoint
CREATE TYPE "public"."resolution_case_status" AS ENUM('open', 'closed');--> statement-breakpoint
CREATE TABLE "dispute_alerts" (
	"alert_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text DEFAULT 'whop' NOT NULL,
	"whop_alert_id" text NOT NULL,
	"whop_payment_id" text,
	"order_id" uuid,
	"environment" "whop_environment" NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"alert_type" text NOT NULL,
	"status" "dispute_alert_status" DEFAULT 'not_actionable' NOT NULL,
	"not_actionable_reason" text,
	"fee_charged" boolean DEFAULT false NOT NULL,
	"reported_at" timestamp with time zone,
	"provider_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_disputes" (
	"dispute_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text DEFAULT 'whop' NOT NULL,
	"whop_dispute_id" text NOT NULL,
	"whop_payment_id" text NOT NULL,
	"order_id" uuid,
	"environment" "whop_environment" NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"provider_status" text NOT NULL,
	"status" "dispute_status" DEFAULT 'open' NOT NULL,
	"inquiry" boolean DEFAULT false NOT NULL,
	"rapid_dispute_resolution" boolean DEFAULT false NOT NULL,
	"reason" text,
	"reason_code" text,
	"evidence_due_at" timestamp with time zone,
	"evidence_submitted_at" timestamp with time zone,
	"opened_at" timestamp with time zone,
	"provider_updated_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resolution_center_cases" (
	"case_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text DEFAULT 'whop' NOT NULL,
	"whop_case_id" text NOT NULL,
	"whop_payment_id" text,
	"order_id" uuid,
	"environment" "whop_environment" NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"provider_status" text NOT NULL,
	"status" "resolution_case_status" DEFAULT 'open' NOT NULL,
	"outcome" text,
	"refund_source" text,
	"reason" text,
	"escalated" boolean DEFAULT false NOT NULL,
	"provider_updated_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dispute_alerts" ADD CONSTRAINT "dispute_alerts_order_id_payment_orders_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."payment_orders"("order_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_disputes" ADD CONSTRAINT "payment_disputes_order_id_payment_orders_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."payment_orders"("order_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resolution_center_cases" ADD CONSTRAINT "resolution_center_cases_order_id_payment_orders_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."payment_orders"("order_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_alerts_provider_alert" ON "dispute_alerts" USING btree ("provider","whop_alert_id");--> statement-breakpoint
CREATE INDEX "idx_alerts_payment" ON "dispute_alerts" USING btree ("whop_payment_id");--> statement-breakpoint
CREATE INDEX "idx_alerts_order" ON "dispute_alerts" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "idx_alerts_status" ON "dispute_alerts" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_disputes_provider_dispute" ON "payment_disputes" USING btree ("provider","whop_dispute_id");--> statement-breakpoint
CREATE INDEX "idx_disputes_payment" ON "payment_disputes" USING btree ("whop_payment_id");--> statement-breakpoint
CREATE INDEX "idx_disputes_order" ON "payment_disputes" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "idx_disputes_status" ON "payment_disputes" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_disputes_evidence_due" ON "payment_disputes" USING btree ("evidence_due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_cases_provider_case" ON "resolution_center_cases" USING btree ("provider","whop_case_id");--> statement-breakpoint
CREATE INDEX "idx_cases_payment" ON "resolution_center_cases" USING btree ("whop_payment_id");--> statement-breakpoint
CREATE INDEX "idx_cases_order" ON "resolution_center_cases" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "idx_cases_status" ON "resolution_center_cases" USING btree ("status");

--> statement-breakpoint
--
-- ===========================================================================
-- HAND-WRITTEN INVARIANTS.
--
-- Everything above is generated from src/lib/db/schema.ts. Everything below
-- expresses rules Drizzle cannot model.
--
-- ADDITIVE ONLY. This migration creates three enums and three tables and
-- touches nothing that already exists. It alters no accounting table, adds no
-- column to payment_orders, payment_refunds or the journal, and changes no
-- trigger from 0004 — the append-only and balance rules over
-- accounting_transactions / accounting_entries are untouched and must stay
-- that way. A dispute is a NEW economic event; nothing about the settlement or
-- the refunds it may follow needs to change.
--
-- NO ECONOMIC EVENT VALUES ARE ADDED. `economic_event` already carries
-- 'dispute_opened', 'dispute_won' and 'dispute_lost' from 0004, which is what
-- dispute postings use. Adding an enum value would be a schema change on a
-- financial column, and it is not needed.
--
-- drizzle-kit does not track check constraints, so a later `db:generate` will
-- neither recreate nor drop any of this.
-- ===========================================================================

-- Amounts are never negative on any of the three resources. A dispute or case
-- amount of ZERO is legitimate (a documentation request moves nothing), so the
-- bound is >= 0 here rather than > 0 as it is for a refund.
ALTER TABLE "payment_disputes"
  ADD CONSTRAINT "payment_disputes_amount_nonnegative"
  CHECK ("amount_minor" >= 0);--> statement-breakpoint

ALTER TABLE "dispute_alerts"
  ADD CONSTRAINT "dispute_alerts_amount_nonnegative"
  CHECK ("amount_minor" >= 0);--> statement-breakpoint

ALTER TABLE "resolution_center_cases"
  ADD CONSTRAINT "resolution_center_cases_amount_nonnegative"
  CHECK ("amount_minor" >= 0);--> statement-breakpoint

-- Lowercase ISO 4217 everywhere, the same rule the journal carries, so a
-- dispute and the transaction that accounts for it can never disagree about
-- the form of a currency code.
ALTER TABLE "payment_disputes"
  ADD CONSTRAINT "payment_disputes_currency_format"
  CHECK ("currency" ~ '^[a-z]{3}$');--> statement-breakpoint

ALTER TABLE "dispute_alerts"
  ADD CONSTRAINT "dispute_alerts_currency_format"
  CHECK ("currency" ~ '^[a-z]{3}$');--> statement-breakpoint

ALTER TABLE "resolution_center_cases"
  ADD CONSTRAINT "resolution_center_cases_currency_format"
  CHECK ("currency" ~ '^[a-z]{3}$');--> statement-breakpoint

-- The provider ids must carry their documented prefixes. A `dspt_` id in the
-- alert table, or a `pay_` id in a dispute id column, is a wiring mistake that
-- would otherwise sit in the table looking entirely plausible.
ALTER TABLE "payment_disputes"
  ADD CONSTRAINT "payment_disputes_dispute_id_prefix"
  CHECK ("whop_dispute_id" ~ '^dspt_[A-Za-z0-9]{1,64}$');--> statement-breakpoint

ALTER TABLE "payment_disputes"
  ADD CONSTRAINT "payment_disputes_payment_id_prefix"
  CHECK ("whop_payment_id" ~ '^pay_[A-Za-z0-9]{1,64}$');--> statement-breakpoint

ALTER TABLE "dispute_alerts"
  ADD CONSTRAINT "dispute_alerts_alert_id_prefix"
  CHECK ("whop_alert_id" ~ '^dspa_[A-Za-z0-9]{1,64}$');--> statement-breakpoint

-- Nullable here, unlike on a dispute: Whop documents an alert's payment as
-- "null when Whop could not match the report to a payment". The shape is only
-- enforced when a value is actually present.
ALTER TABLE "dispute_alerts"
  ADD CONSTRAINT "dispute_alerts_payment_id_prefix"
  CHECK ("whop_payment_id" IS NULL OR "whop_payment_id" ~ '^pay_[A-Za-z0-9]{1,64}$');--> statement-breakpoint

ALTER TABLE "resolution_center_cases"
  ADD CONSTRAINT "resolution_center_cases_case_id_prefix"
  CHECK ("whop_case_id" ~ '^reso_[A-Za-z0-9]{1,64}$');--> statement-breakpoint

ALTER TABLE "resolution_center_cases"
  ADD CONSTRAINT "resolution_center_cases_payment_id_prefix"
  CHECK ("whop_payment_id" IS NULL OR "whop_payment_id" ~ '^pay_[A-Za-z0-9]{1,64}$');--> statement-breakpoint

-- The raw provider status is the forensic record and must never be blank: it
-- is what lets an operator see exactly what Whop said, independently of our
-- own reduction of it.
ALTER TABLE "payment_disputes"
  ADD CONSTRAINT "payment_disputes_provider_status_present"
  CHECK (length(btrim("provider_status")) > 0);--> statement-breakpoint

ALTER TABLE "resolution_center_cases"
  ADD CONSTRAINT "resolution_center_cases_provider_status_present"
  CHECK (length(btrim("provider_status")) > 0);--> statement-breakpoint

ALTER TABLE "dispute_alerts"
  ADD CONSTRAINT "dispute_alerts_type_present"
  CHECK (length(btrim("alert_type")) > 0);--> statement-breakpoint

ALTER TABLE "payment_disputes"
  ADD CONSTRAINT "payment_disputes_provider_present"
  CHECK (length(btrim("provider")) > 0);--> statement-breakpoint

ALTER TABLE "dispute_alerts"
  ADD CONSTRAINT "dispute_alerts_provider_present"
  CHECK (length(btrim("provider")) > 0);--> statement-breakpoint

ALTER TABLE "resolution_center_cases"
  ADD CONSTRAINT "resolution_center_cases_provider_present"
  CHECK (length(btrim("provider")) > 0);--> statement-breakpoint

--
-- THE RESOLUTION RULES.
--
-- `resolved_at` is what "this dispute is finished" means operationally, and
-- reconciliation uses its presence to decide whether a posting could be owed.
-- The two must not be able to disagree: a row claiming `won` with no
-- resolution time, or a resolution time on a row still `open`, would each make
-- a reconciliation pass either miss a movement or look for one twice.
--
ALTER TABLE "payment_disputes"
  ADD CONSTRAINT "payment_disputes_resolved_has_time"
  CHECK ("status" NOT IN ('won', 'lost', 'closed') OR "resolved_at" IS NOT NULL);--> statement-breakpoint

ALTER TABLE "payment_disputes"
  ADD CONSTRAINT "payment_disputes_resolved_time_only_when_resolved"
  CHECK ("resolved_at" IS NULL OR "status" IN ('won', 'lost', 'closed'));--> statement-breakpoint

ALTER TABLE "resolution_center_cases"
  ADD CONSTRAINT "resolution_center_cases_closed_has_time"
  CHECK ("status" <> 'closed' OR "closed_at" IS NOT NULL);--> statement-breakpoint

ALTER TABLE "resolution_center_cases"
  ADD CONSTRAINT "resolution_center_cases_closed_time_only_when_closed"
  CHECK ("closed_at" IS NULL OR "status" = 'closed');--> statement-breakpoint

--
-- A case that is still open cannot already know who won. Whop documents
-- `outcome` as "null until the case closes", and a row that contradicts that
-- is reporting a decision nobody made.
--
ALTER TABLE "resolution_center_cases"
  ADD CONSTRAINT "resolution_center_cases_outcome_only_when_closed"
  CHECK ("outcome" IS NULL OR "status" = 'closed');--> statement-breakpoint

--
-- The two decision vocabularies, constrained to exactly what Whop can produce.
-- `refund_source` in particular decides a reconciliation question — whether
-- money is claimed to have come off OUR balance — and a typo in it would
-- silently turn that check off.
--
ALTER TABLE "resolution_center_cases"
  ADD CONSTRAINT "resolution_center_cases_outcome_values"
  CHECK ("outcome" IS NULL OR "outcome" IN ('customer_won', 'merchant_won', 'withdrawn'));--> statement-breakpoint

ALTER TABLE "resolution_center_cases"
  ADD CONSTRAINT "resolution_center_cases_refund_source_values"
  CHECK ("refund_source" IS NULL OR "refund_source" IN ('none', 'merchant', 'platform'));--> statement-breakpoint

--
-- An alert's type is a closed set of three, and its actionability reason is a
-- closed set of five. Both come straight from the SDK enums.
--
ALTER TABLE "dispute_alerts"
  ADD CONSTRAINT "dispute_alerts_type_values"
  CHECK ("alert_type" IN ('early_fraud_warning', 'dispute_alert', 'rapid_dispute_resolution'));--> statement-breakpoint

ALTER TABLE "dispute_alerts"
  ADD CONSTRAINT "dispute_alerts_not_actionable_reason_values"
  CHECK (
    "not_actionable_reason" IS NULL
    OR "not_actionable_reason" IN (
      'network_resolved', 'payment_unmatched', 'payment_not_captured',
      'payment_disputed', 'payment_refunded'
    )
  );--> statement-breakpoint

--
-- An actionable alert has no reason not to be, and a non-actionable one should
-- say why. The second half is deliberately NOT enforced as NOT NULL: Whop
-- documents the reason as null while `actionable` is true, but does not
-- promise one is always present when it is false, and inventing a constraint
-- the provider does not honour would reject real data.
--
ALTER TABLE "dispute_alerts"
  ADD CONSTRAINT "dispute_alerts_actionable_has_no_reason"
  CHECK ("status" <> 'actionable' OR "not_actionable_reason" IS NULL);
