CREATE TYPE "public"."calendar_provisioning_status" AS ENUM('pending', 'ready', 'failed');--> statement-breakpoint
CREATE TABLE "google_calendar_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment" "whop_environment" NOT NULL,
	"account_email" text,
	"refresh_token_ciphertext" text,
	"access_token_ciphertext" text,
	"access_token_expires_at" timestamp with time zone,
	"scopes" text NOT NULL,
	"connected_by_uid" text,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_refreshed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "google_oauth_states" (
	"state" text PRIMARY KEY NOT NULL,
	"admin_uid" text NOT NULL,
	"environment" "whop_environment" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "interview_bookings" ADD COLUMN "google_calendar_event_id" text;--> statement-breakpoint
ALTER TABLE "interview_bookings" ADD COLUMN "calendar_provisioning_status" "calendar_provisioning_status" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "interview_bookings" ADD COLUMN "calendar_retry_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "interview_bookings" ADD COLUMN "last_calendar_error_code" text;--> statement-breakpoint
ALTER TABLE "interview_bookings" ADD COLUMN "calendar_updated_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_google_calendar_active_env" ON "google_calendar_connections" USING btree ("environment") WHERE revoked_at is null;--> statement-breakpoint
CREATE INDEX "idx_google_calendar_env" ON "google_calendar_connections" USING btree ("environment");--> statement-breakpoint
CREATE INDEX "idx_google_oauth_states_expires" ON "google_oauth_states" USING btree ("expires_at");--> statement-breakpoint
-- A READY PROVISIONING MUST HAVE SOMETHING TO SHOW FOR IT. `ready` means an
-- event exists and a Meet link was captured; the state and the evidence for it
-- cannot drift apart.
ALTER TABLE "interview_bookings"
  ADD CONSTRAINT "bookings_ready_has_event"
  CHECK (
    "calendar_provisioning_status" <> 'ready'
    OR ("google_calendar_event_id" IS NOT NULL AND "meeting_url" IS NOT NULL)
  );--> statement-breakpoint
-- Retries are counted, never negative.
ALTER TABLE "interview_bookings"
  ADD CONSTRAINT "bookings_retry_count_is_sane"
  CHECK ("calendar_retry_count" >= 0 AND "calendar_retry_count" <= 100);--> statement-breakpoint
-- A LIVE CONNECTION HAS A REFRESH TOKEN. Clearing the credential is how a
-- connection is revoked, so an active row without one is a broken state.
ALTER TABLE "google_calendar_connections"
  ADD CONSTRAINT "google_calendar_active_has_refresh_token"
  CHECK ("revoked_at" IS NOT NULL OR "refresh_token_ciphertext" IS NOT NULL);--> statement-breakpoint
-- Tokens are stored as versioned AES-GCM envelopes, never as a raw value.
ALTER TABLE "google_calendar_connections"
  ADD CONSTRAINT "google_calendar_tokens_are_envelopes"
  CHECK (
    ("refresh_token_ciphertext" IS NULL OR "refresh_token_ciphertext" LIKE 'v1.%')
    AND ("access_token_ciphertext" IS NULL OR "access_token_ciphertext" LIKE 'v1.%')
  );--> statement-breakpoint
ALTER TABLE "google_oauth_states"
  ADD CONSTRAINT "google_oauth_states_expire_after_creation"
  CHECK ("expires_at" > "created_at");
