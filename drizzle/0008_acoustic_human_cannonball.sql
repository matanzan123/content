CREATE TABLE "whop_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firebase_uid" text NOT NULL,
	"whop_account_id" text NOT NULL,
	"whop_user_id" text NOT NULL,
	"parent_account_id" text NOT NULL,
	"environment" "whop_environment" NOT NULL,
	"status" text,
	"onboarding_type" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "whop_accounts" ADD CONSTRAINT "whop_accounts_firebase_uid_users_firebase_uid_fk" FOREIGN KEY ("firebase_uid") REFERENCES "public"."users"("firebase_uid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_whop_account_user_env" ON "whop_accounts" USING btree ("firebase_uid","environment");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_whop_account_id_env" ON "whop_accounts" USING btree ("whop_account_id","environment");--> statement-breakpoint
CREATE INDEX "idx_whop_accounts_uid" ON "whop_accounts" USING btree ("firebase_uid");--> statement-breakpoint
CREATE INDEX "idx_whop_accounts_whop_user" ON "whop_accounts" USING btree ("whop_user_id");--> statement-breakpoint
-- SHAPE CONSTRAINTS. A Whop Account id is prefixed `biz_`; anything else is a
-- value that came from somewhere it should not have. Enforced here as well as
-- in the provider client, because a constraint the database holds cannot be
-- forgotten by a future call site.
ALTER TABLE "whop_accounts"
  ADD CONSTRAINT "whop_accounts_id_is_biz"
  CHECK ("whop_account_id" LIKE 'biz\_%' AND length("whop_account_id") > 4);--> statement-breakpoint
ALTER TABLE "whop_accounts"
  ADD CONSTRAINT "whop_accounts_parent_is_biz"
  CHECK ("parent_account_id" LIKE 'biz\_%' AND length("parent_account_id") > 4);--> statement-breakpoint
-- A CONNECTED ACCOUNT IS NEVER ITS OWN PARENT. That shape would mean a
-- standalone company was recorded as if it were a child of the platform.
ALTER TABLE "whop_accounts"
  ADD CONSTRAINT "whop_accounts_parent_is_not_self"
  CHECK ("parent_account_id" <> "whop_account_id");--> statement-breakpoint
-- The Whop user id is the OIDC subject, prefixed `user_`.
ALTER TABLE "whop_accounts"
  ADD CONSTRAINT "whop_accounts_whop_user_is_user"
  CHECK ("whop_user_id" LIKE 'user\_%' AND length("whop_user_id") > 5);
