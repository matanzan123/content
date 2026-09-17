CREATE TYPE "public"."creator_earning_status" AS ENUM('held', 'available', 'transferred', 'reversed');--> statement-breakpoint
CREATE TYPE "public"."creator_transfer_status" AS ENUM('pending', 'submitted', 'completed', 'failed', 'reversed');--> statement-breakpoint
CREATE TYPE "public"."creator_withdrawal_status" AS ENUM('requested', 'eligible', 'processing', 'provider_pending', 'paid', 'failed', 'canceled', 'reversed');--> statement-breakpoint
CREATE TYPE "public"."notification_channel" AS ENUM('in_app');--> statement-breakpoint
CREATE TYPE "public"."notification_status" AS ENUM('unread', 'read');--> statement-breakpoint
ALTER TYPE "public"."economic_event" ADD VALUE 'revenue_split';--> statement-breakpoint
ALTER TYPE "public"."economic_event" ADD VALUE 'revenue_split_reversed';--> statement-breakpoint
ALTER TYPE "public"."economic_event" ADD VALUE 'provider_fee_reconciled';--> statement-breakpoint
CREATE TABLE "creator_earnings" (
	"earning_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firebase_uid" text NOT NULL,
	"environment" "whop_environment" NOT NULL,
	"whop_payment_id" text NOT NULL,
	"order_id" uuid,
	"gross_amount_minor" bigint NOT NULL,
	"platform_fee_minor" bigint NOT NULL,
	"net_amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"platform_fee_bps" integer NOT NULL,
	"status" "creator_earning_status" DEFAULT 'held' NOT NULL,
	"hold_until" timestamp with time zone NOT NULL,
	"frozen_by_dispute" boolean DEFAULT false NOT NULL,
	"frozen_by_dispute_id" text,
	"transfer_id" uuid,
	"accounting_transaction_id" uuid,
	"description" text,
	"payment_settled_at" timestamp with time zone,
	"available_at" timestamp with time zone,
	"transferred_at" timestamp with time zone,
	"reversed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "creator_transfers" (
	"transfer_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firebase_uid" text NOT NULL,
	"whop_account_id" text NOT NULL,
	"environment" "whop_environment" NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"status" "creator_transfer_status" DEFAULT 'pending' NOT NULL,
	"idempotency_key" text NOT NULL,
	"provider_transfer_id" text,
	"failure_reason" text,
	"purpose" text NOT NULL,
	"campaign_id" text,
	"accounting_transaction_id" uuid,
	"initiated_by_uid" text NOT NULL,
	"submitted_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"reversed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "creator_withdrawal_earnings" (
	"withdrawal_id" uuid NOT NULL,
	"earning_id" uuid NOT NULL,
	"reserved_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "creator_withdrawals" (
	"withdrawal_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firebase_uid" text NOT NULL,
	"environment" "whop_environment" NOT NULL,
	"amount_minor" bigint NOT NULL,
	"reserved_amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"status" "creator_withdrawal_status" DEFAULT 'requested' NOT NULL,
	"transfer_id" uuid,
	"failure_reason" text,
	"cancel_reason" text,
	"processed_by_uid" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"eligible_at" timestamp with time zone,
	"processing_at" timestamp with time zone,
	"provider_pending_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"canceled_at" timestamp with time zone,
	"reversed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"notification_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firebase_uid" text NOT NULL,
	"type" text NOT NULL,
	"channel" "notification_channel" DEFAULT 'in_app' NOT NULL,
	"status" "notification_status" DEFAULT 'unread' NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"action_url" text,
	"metadata" jsonb,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	CONSTRAINT "notifications_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "rate_limit_counters" (
	"key" text NOT NULL,
	"window_key" text NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "rate_limit_counters_key_window_key_pk" PRIMARY KEY("key","window_key")
);
--> statement-breakpoint
ALTER TABLE "creator_earnings" ADD CONSTRAINT "creator_earnings_firebase_uid_users_firebase_uid_fk" FOREIGN KEY ("firebase_uid") REFERENCES "public"."users"("firebase_uid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_earnings" ADD CONSTRAINT "creator_earnings_order_id_payment_orders_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."payment_orders"("order_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_transfers" ADD CONSTRAINT "creator_transfers_firebase_uid_users_firebase_uid_fk" FOREIGN KEY ("firebase_uid") REFERENCES "public"."users"("firebase_uid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_withdrawal_earnings" ADD CONSTRAINT "creator_withdrawal_earnings_withdrawal_id_creator_withdrawals_withdrawal_id_fk" FOREIGN KEY ("withdrawal_id") REFERENCES "public"."creator_withdrawals"("withdrawal_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_withdrawal_earnings" ADD CONSTRAINT "creator_withdrawal_earnings_earning_id_creator_earnings_earning_id_fk" FOREIGN KEY ("earning_id") REFERENCES "public"."creator_earnings"("earning_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_withdrawals" ADD CONSTRAINT "creator_withdrawals_firebase_uid_users_firebase_uid_fk" FOREIGN KEY ("firebase_uid") REFERENCES "public"."users"("firebase_uid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_withdrawals" ADD CONSTRAINT "creator_withdrawals_transfer_id_creator_transfers_transfer_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."creator_transfers"("transfer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_creator_earnings_payment_creator" ON "creator_earnings" USING btree ("whop_payment_id","firebase_uid");--> statement-breakpoint
CREATE INDEX "idx_creator_earnings_uid" ON "creator_earnings" USING btree ("firebase_uid","status");--> statement-breakpoint
CREATE INDEX "idx_creator_earnings_payment" ON "creator_earnings" USING btree ("whop_payment_id");--> statement-breakpoint
CREATE INDEX "idx_creator_earnings_hold_until" ON "creator_earnings" USING btree ("hold_until","status");--> statement-breakpoint
CREATE INDEX "idx_creator_earnings_created" ON "creator_earnings" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_creator_earnings_transfer" ON "creator_earnings" USING btree ("transfer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_creator_transfers_idempotency" ON "creator_transfers" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_creator_transfers_provider_id" ON "creator_transfers" USING btree ("provider_transfer_id") WHERE provider_transfer_id is not null;--> statement-breakpoint
CREATE INDEX "idx_creator_transfers_uid" ON "creator_transfers" USING btree ("firebase_uid");--> statement-breakpoint
CREATE INDEX "idx_creator_transfers_account" ON "creator_transfers" USING btree ("whop_account_id");--> statement-breakpoint
CREATE INDEX "idx_creator_transfers_status" ON "creator_transfers" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "idx_creator_transfers_campaign" ON "creator_transfers" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "idx_creator_transfers_created" ON "creator_transfers" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_withdrawal_earning" ON "creator_withdrawal_earnings" USING btree ("earning_id");--> statement-breakpoint
CREATE INDEX "idx_withdrawal_earnings_withdrawal" ON "creator_withdrawal_earnings" USING btree ("withdrawal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_withdrawal_active_creator" ON "creator_withdrawals" USING btree ("firebase_uid") WHERE status NOT IN ('paid', 'failed', 'canceled', 'reversed');--> statement-breakpoint
CREATE INDEX "idx_withdrawals_uid" ON "creator_withdrawals" USING btree ("firebase_uid","status");--> statement-breakpoint
CREATE INDEX "idx_withdrawals_status" ON "creator_withdrawals" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "idx_withdrawals_transfer" ON "creator_withdrawals" USING btree ("transfer_id");--> statement-breakpoint
CREATE INDEX "idx_withdrawals_created" ON "creator_withdrawals" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_notifications_uid_created" ON "notifications" USING btree ("firebase_uid","created_at");