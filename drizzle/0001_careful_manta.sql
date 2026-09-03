CREATE TYPE "public"."whop_environment" AS ENUM('sandbox', 'production');--> statement-breakpoint
CREATE TYPE "public"."whop_webhook_status" AS ENUM('received', 'processed', 'awaiting_mapping', 'unsupported', 'rejected_company', 'failed');--> statement-breakpoint
CREATE TABLE "whop_webhook_receipts" (
	"webhook_id" text PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"resource_id" text,
	"company_id" text,
	"environment" "whop_environment" NOT NULL,
	"status" "whop_webhook_status" DEFAULT 'received' NOT NULL,
	"failure_category" text,
	"delivery_count" integer DEFAULT 1 NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "idx_whop_receipts_received" ON "whop_webhook_receipts" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "idx_whop_receipts_status" ON "whop_webhook_receipts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_whop_receipts_event" ON "whop_webhook_receipts" USING btree ("event_type","received_at");--> statement-breakpoint
CREATE INDEX "idx_whop_receipts_resource" ON "whop_webhook_receipts" USING btree ("resource_id");--> statement-breakpoint
CREATE INDEX "idx_whop_receipts_claimed" ON "whop_webhook_receipts" USING btree ("status","claimed_at");