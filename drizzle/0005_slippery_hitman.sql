CREATE TYPE "public"."payment_refund_status" AS ENUM('pending', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "payment_refunds" (
	"refund_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text DEFAULT 'whop' NOT NULL,
	"whop_refund_id" text NOT NULL,
	"whop_payment_id" text NOT NULL,
	"order_id" uuid,
	"environment" "whop_environment" NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"provider_status" text NOT NULL,
	"status" "payment_refund_status" DEFAULT 'pending' NOT NULL,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"failed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_order_id_payment_orders_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."payment_orders"("order_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_refunds_provider_refund" ON "payment_refunds" USING btree ("provider","whop_refund_id");--> statement-breakpoint
CREATE INDEX "idx_refunds_payment" ON "payment_refunds" USING btree ("whop_payment_id");--> statement-breakpoint
CREATE INDEX "idx_refunds_order" ON "payment_refunds" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "idx_refunds_status" ON "payment_refunds" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_refunds_created" ON "payment_refunds" USING btree ("created_at");
--> statement-breakpoint
--
-- ===========================================================================
-- HAND-WRITTEN INVARIANTS.
--
-- Everything above is generated from src/lib/db/schema.ts. Everything below
-- expresses rules Drizzle cannot model: value checks, and the two rules that
-- make this an operational refund record rather than a free-text table.
--
-- ADDITIVE ONLY. This migration creates one type and one table and touches
-- nothing that already exists. It adds no column to payment_orders, alters no
-- accounting table, and changes no trigger from 0004 — the append-only and
-- balance rules over the journal are untouched and must stay that way. A
-- refund is a NEW economic event, so nothing about the settled payment it
-- reverses needs to change.
--
-- drizzle-kit does not track check constraints, so a later `db:generate` will
-- neither recreate nor drop any of this. Changing a rule below means writing
-- the change into a new migration deliberately, which is the correct amount of
-- friction for a rule about money.
-- ===========================================================================

-- A refund of nothing, or of a negative amount, is not a refund. Whop has no
-- such resource, and one reaching this table could only come from a reader
-- that failed open.
ALTER TABLE "payment_refunds"
  ADD CONSTRAINT "payment_refunds_amount_positive"
  CHECK ("amount_minor" > 0);--> statement-breakpoint

-- Lowercase ISO 4217, the same rule the journal carries, so a refund and the
-- transaction that accounts for it can never disagree about the form of a
-- currency code.
ALTER TABLE "payment_refunds"
  ADD CONSTRAINT "payment_refunds_currency_format"
  CHECK ("currency" ~ '^[a-z]{3}$');--> statement-breakpoint

-- The provider ids must have their documented prefixes. A `pay_` id in the
-- refund column, or the reverse, is a wiring mistake that would otherwise sit
-- in the table looking plausible.
ALTER TABLE "payment_refunds"
  ADD CONSTRAINT "payment_refunds_refund_id_prefix"
  CHECK ("whop_refund_id" ~ '^rf_[A-Za-z0-9]{1,64}$');--> statement-breakpoint

ALTER TABLE "payment_refunds"
  ADD CONSTRAINT "payment_refunds_payment_id_prefix"
  CHECK ("whop_payment_id" ~ '^pay_[A-Za-z0-9]{1,64}$');--> statement-breakpoint

ALTER TABLE "payment_refunds"
  ADD CONSTRAINT "payment_refunds_provider_present"
  CHECK (length(btrim("provider")) > 0);--> statement-breakpoint

ALTER TABLE "payment_refunds"
  ADD CONSTRAINT "payment_refunds_provider_status_present"
  CHECK (length(btrim("provider_status")) > 0);--> statement-breakpoint

--
-- THE TIMESTAMP RULES.
--
-- `completed_at` is what "this refund really happened" means operationally,
-- and reconciliation uses its presence to decide whether a posting is owed.
-- So the two must not be able to disagree: a row claiming `completed` with no
-- completion time, or a completion time on a row that is not completed, would
-- each make the repair pass either miss a posting or ask for one twice.
--
ALTER TABLE "payment_refunds"
  ADD CONSTRAINT "payment_refunds_completed_has_time"
  CHECK (("status" <> 'completed') OR ("completed_at" IS NOT NULL));--> statement-breakpoint

ALTER TABLE "payment_refunds"
  ADD CONSTRAINT "payment_refunds_completed_time_only_when_completed"
  CHECK (("completed_at" IS NULL) OR ("status" = 'completed'));--> statement-breakpoint

ALTER TABLE "payment_refunds"
  ADD CONSTRAINT "payment_refunds_failed_has_time"
  CHECK (("status" <> 'failed') OR ("failed_at" IS NOT NULL));
