CREATE TYPE "public"."approval_status" AS ENUM('onboarding', 'pending_interview', 'pending_review', 'approved', 'rejected', 'needs_followup');--> statement-breakpoint
CREATE TYPE "public"."booking_status" AS ENUM('scheduled', 'cancelled', 'completed', 'no_show');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('creator', 'brand');--> statement-breakpoint
CREATE TABLE "interview_bookings" (
	"booking_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firebase_uid" text NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"duration_minutes" integer NOT NULL,
	"status" "booking_status" DEFAULT 'scheduled' NOT NULL,
	"meeting_url" text,
	"admin_notes" text,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_profiles" (
	"firebase_uid" text PRIMARY KEY NOT NULL,
	"full_name" text,
	"bio" text,
	"photo_url" text,
	"languages" jsonb,
	"creator_type" text,
	"referral_source" text,
	"socials" jsonb,
	"company_name" text,
	"last_step" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"firebase_uid" text PRIMARY KEY NOT NULL,
	"role" "user_role",
	"approval_status" "approval_status" DEFAULT 'onboarding' NOT NULL,
	"onboarding_completed_at" timestamp with time zone,
	"approved_at" timestamp with time zone,
	"rejected_at" timestamp with time zone,
	"decided_by_uid" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "interview_bookings" ADD CONSTRAINT "interview_bookings_firebase_uid_users_firebase_uid_fk" FOREIGN KEY ("firebase_uid") REFERENCES "public"."users"("firebase_uid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_firebase_uid_users_firebase_uid_fk" FOREIGN KEY ("firebase_uid") REFERENCES "public"."users"("firebase_uid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_bookings_active_user" ON "interview_bookings" USING btree ("firebase_uid") WHERE status = 'scheduled';--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_bookings_active_slot" ON "interview_bookings" USING btree ("scheduled_at") WHERE status = 'scheduled';--> statement-breakpoint
CREATE INDEX "idx_bookings_user" ON "interview_bookings" USING btree ("firebase_uid");--> statement-breakpoint
CREATE INDEX "idx_bookings_scheduled" ON "interview_bookings" USING btree ("scheduled_at");--> statement-breakpoint
CREATE INDEX "idx_bookings_status" ON "interview_bookings" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_users_status" ON "users" USING btree ("approval_status");--> statement-breakpoint
CREATE INDEX "idx_users_role" ON "users" USING btree ("role");--> statement-breakpoint
CREATE INDEX "idx_users_created" ON "users" USING btree ("created_at");

--> statement-breakpoint
--
-- ===========================================================================
-- HAND-WRITTEN INVARIANTS.
--
-- Everything above is generated from src/lib/db/schema.ts. Everything below
-- expresses rules Drizzle cannot model.
--
-- ADDITIVE ONLY. Three enums, three tables, their indexes and foreign keys.
-- Nothing existing is altered: no column is added to user_analytics, no
-- accounting or payment table is touched, and no trigger from 0004 is changed.
-- `user_analytics` in particular keeps its own `user_type` column and its own
-- meaning — it is analytics, it is written by browser traffic, and it is
-- deliberately NOT the identity record.
--
-- THE SECURITY-RELEVANT RULE IN THIS FILE is the timestamp coherence below:
-- `approved_at` must be present exactly when the row says `approved`. A guard
-- that trusted the status while the timestamp disagreed, or the reverse, would
-- be a guard with two answers.
-- ===========================================================================

-- A brand-new account is never approved. Enforced rather than merely defaulted,
-- so an INSERT that names the column explicitly cannot bypass the default.
ALTER TABLE "users"
  ADD CONSTRAINT "users_approved_has_time"
  CHECK (("approval_status" <> 'approved') OR ("approved_at" IS NOT NULL));--> statement-breakpoint

ALTER TABLE "users"
  ADD CONSTRAINT "users_approved_time_only_when_approved"
  CHECK (("approved_at" IS NULL) OR ("approval_status" = 'approved'));--> statement-breakpoint

ALTER TABLE "users"
  ADD CONSTRAINT "users_rejected_has_time"
  CHECK (("approval_status" <> 'rejected') OR ("rejected_at" IS NOT NULL));--> statement-breakpoint

ALTER TABLE "users"
  ADD CONSTRAINT "users_rejected_time_only_when_rejected"
  CHECK (("rejected_at" IS NULL) OR ("approval_status" = 'rejected'));--> statement-breakpoint

-- Any decision state must record who made it and when. An unattributed verdict
-- is not auditable, and these three values have exactly one writer.
ALTER TABLE "users"
  ADD CONSTRAINT "users_decision_is_attributed"
  CHECK (
    "approval_status" NOT IN ('approved', 'rejected', 'needs_followup')
    OR ("decided_by_uid" IS NOT NULL AND "decided_at" IS NOT NULL)
  );--> statement-breakpoint

-- A Firebase UID is an opaque token; the shape check only rejects blanks and
-- absurd lengths rather than pretending to know Firebase's alphabet.
ALTER TABLE "users"
  ADD CONSTRAINT "users_uid_present"
  CHECK (length(btrim("firebase_uid")) BETWEEN 1 AND 128);--> statement-breakpoint

--
-- ONBOARDING COHERENCE. A user cannot be past onboarding without having
-- finished it. This is the database half of the rule `computeProgressStatus`
-- applies in code, so a future writer that skips that function still cannot
-- move an unfinished account into the review queue.
--
ALTER TABLE "users"
  ADD CONSTRAINT "users_progress_requires_onboarding"
  CHECK (
    "approval_status" NOT IN ('pending_interview', 'pending_review')
    OR ("role" IS NOT NULL AND "onboarding_completed_at" IS NOT NULL)
  );--> statement-breakpoint

--
-- BOOKINGS.
--
ALTER TABLE "interview_bookings"
  ADD CONSTRAINT "interview_bookings_duration_sane"
  CHECK ("duration_minutes" BETWEEN 5 AND 240);--> statement-breakpoint

ALTER TABLE "interview_bookings"
  ADD CONSTRAINT "interview_bookings_cancelled_has_time"
  CHECK (("status" <> 'cancelled') OR ("cancelled_at" IS NOT NULL));--> statement-breakpoint

ALTER TABLE "interview_bookings"
  ADD CONSTRAINT "interview_bookings_cancelled_time_only_when_cancelled"
  CHECK (("cancelled_at" IS NULL) OR ("status" = 'cancelled'));--> statement-breakpoint

-- A meeting URL is pasted by staff and must at least be an https URL. Not a
-- Meet-specific pattern: staff may legitimately send a different provider, and
-- a constraint that assumed meet.google.com would reject a real link.
-- The bound is split in two on purpose: Postgres refuses a POSIX regex whose
-- repetition count exceeds 255, so `{3,500}` is not merely wrong here — it
-- raises "invalid repetition count(s)" at evaluation time and every URL write
-- fails. The length limit is expressed as its own comparison instead.
ALTER TABLE "interview_bookings"
  ADD CONSTRAINT "interview_bookings_meeting_url_https"
  CHECK (
    "meeting_url" IS NULL
    OR ("meeting_url" ~ '^https://[^[:space:]]{3,200}' AND length("meeting_url") <= 500)
  );--> statement-breakpoint

--
-- PROFILE.
--
ALTER TABLE "user_profiles"
  ADD CONSTRAINT "user_profiles_step_range"
  CHECK ("last_step" BETWEEN 0 AND 20);--> statement-breakpoint

ALTER TABLE "user_profiles"
  ADD CONSTRAINT "user_profiles_bio_length"
  CHECK ("bio" IS NULL OR length("bio") <= 280);--> statement-breakpoint

ALTER TABLE "user_profiles"
  ADD CONSTRAINT "user_profiles_name_length"
  CHECK ("full_name" IS NULL OR length("full_name") <= 120);
