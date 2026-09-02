CREATE TYPE "public"."device_category" AS ENUM('mobile', 'tablet', 'desktop', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."locale" AS ENUM('en', 'he');--> statement-breakpoint
CREATE TYPE "public"."transaction_status" AS ENUM('pending', 'completed', 'failed', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."transaction_type" AS ENUM('brand_funding', 'creator_payout', 'platform_fee', 'refund', 'processing_fee', 'adjustment');--> statement-breakpoint
CREATE TYPE "public"."user_type" AS ENUM('anonymous', 'creator', 'brand', 'admin');--> statement-breakpoint
CREATE TABLE "admin_audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_uid" text NOT NULL,
	"admin_email_at_time" text,
	"action" text NOT NULL,
	"target_type" text DEFAULT 'none' NOT NULL,
	"target_id" text,
	"country_code" char(2),
	"session_id" uuid,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analytics_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_name" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"session_id" uuid NOT NULL,
	"visitor_id" uuid,
	"firebase_uid" text,
	"user_type" "user_type" DEFAULT 'anonymous' NOT NULL,
	"locale" "locale" NOT NULL,
	"path" text NOT NULL,
	"referrer_host" text,
	"utm_source" text,
	"utm_medium" text,
	"utm_campaign" text,
	"utm_content" text,
	"utm_term" text,
	"country_code" char(2),
	"device_category" "device_category" DEFAULT 'unknown' NOT NULL,
	"browser_family" text,
	"campaign_id" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analytics_sessions" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"visitor_id" uuid,
	"firebase_uid" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"entry_path" text NOT NULL,
	"last_path" text NOT NULL,
	"page_view_count" integer DEFAULT 0 NOT NULL,
	"event_count" integer DEFAULT 0 NOT NULL,
	"country_code" char(2),
	"device_category" "device_category" DEFAULT 'unknown' NOT NULL,
	"browser_family" text,
	"locale" "locale" NOT NULL,
	"first_referrer_host" text,
	"utm_source" text,
	"utm_medium" text,
	"utm_campaign" text,
	"utm_content" text,
	"utm_term" text,
	"is_new_visitor" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "financial_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_type" "transaction_type" NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"status" "transaction_status" DEFAULT 'pending' NOT NULL,
	"campaign_id" text,
	"brand_id" text,
	"creator_id" text,
	"external_provider" text,
	"external_provider_reference" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "user_analytics" (
	"firebase_uid" text PRIMARY KEY NOT NULL,
	"user_type" "user_type" DEFAULT 'anonymous' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locale" "locale",
	"country_code" char(2),
	"signup_source" text,
	"creator_onboarding_started_at" timestamp with time zone,
	"creator_onboarding_completed_at" timestamp with time zone,
	"brand_form_submitted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "idx_audit_created" ON "admin_audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_audit_admin" ON "admin_audit_log" USING btree ("admin_uid");--> statement-breakpoint
CREATE INDEX "idx_audit_action" ON "admin_audit_log" USING btree ("action");--> statement-breakpoint
CREATE INDEX "idx_events_occurred" ON "analytics_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "idx_events_name_occurred" ON "analytics_events" USING btree ("event_name","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_events_country_occurred" ON "analytics_events" USING btree ("country_code","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_events_uid_occurred" ON "analytics_events" USING btree ("firebase_uid","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_events_session_occurred" ON "analytics_events" USING btree ("session_id","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_events_path_occurred" ON "analytics_events" USING btree ("path","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_sessions_last_activity" ON "analytics_sessions" USING btree ("last_activity_at");--> statement-breakpoint
CREATE INDEX "idx_sessions_started" ON "analytics_sessions" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "idx_sessions_uid" ON "analytics_sessions" USING btree ("firebase_uid");--> statement-breakpoint
CREATE INDEX "idx_sessions_country" ON "analytics_sessions" USING btree ("country_code");--> statement-breakpoint
CREATE INDEX "idx_sessions_visitor" ON "analytics_sessions" USING btree ("visitor_id");--> statement-breakpoint
CREATE INDEX "idx_ledger_created" ON "financial_ledger" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_ledger_status" ON "financial_ledger" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_ledger_type" ON "financial_ledger" USING btree ("transaction_type");--> statement-breakpoint
CREATE INDEX "idx_ledger_campaign" ON "financial_ledger" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "idx_ledger_brand" ON "financial_ledger" USING btree ("brand_id");--> statement-breakpoint
CREATE INDEX "idx_ledger_creator" ON "financial_ledger" USING btree ("creator_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_ledger_provider_ref" ON "financial_ledger" USING btree ("external_provider","external_provider_reference") WHERE external_provider_reference is not null;--> statement-breakpoint
CREATE INDEX "idx_user_analytics_last_seen" ON "user_analytics" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX "idx_user_analytics_type" ON "user_analytics" USING btree ("user_type");--> statement-breakpoint
CREATE INDEX "idx_user_analytics_country" ON "user_analytics" USING btree ("country_code");--> statement-breakpoint
-- Financial integrity, enforced by the database rather than by application code.
-- A bug in a webhook handler must not be able to write a negative fee or a
-- currency the reporting layer cannot interpret.
ALTER TABLE "financial_ledger"
  ADD CONSTRAINT "ledger_currency_is_iso" CHECK ("currency" ~ '^[A-Z]{3}$');--> statement-breakpoint
ALTER TABLE "financial_ledger"
  ADD CONSTRAINT "ledger_amount_nonnegative" CHECK ("amount_minor" >= 0);--> statement-breakpoint
-- A completed transaction must record when it completed.
ALTER TABLE "financial_ledger"
  ADD CONSTRAINT "ledger_completed_has_timestamp"
  CHECK ("status" <> 'completed' OR "completed_at" IS NOT NULL);--> statement-breakpoint
-- Country codes are ISO 3166-1 alpha-2 everywhere they appear.
ALTER TABLE "analytics_events"
  ADD CONSTRAINT "events_country_is_iso" CHECK ("country_code" IS NULL OR "country_code" ~ '^[A-Z]{2}$');--> statement-breakpoint
ALTER TABLE "analytics_sessions"
  ADD CONSTRAINT "sessions_country_is_iso" CHECK ("country_code" IS NULL OR "country_code" ~ '^[A-Z]{2}$');--> statement-breakpoint
-- Paths are stored without a query string; a stored '?' means the collector
-- stripping failed and personal data could be sitting in the column.
ALTER TABLE "analytics_events"
  ADD CONSTRAINT "events_path_has_no_query" CHECK ("path" NOT LIKE '%?%');
