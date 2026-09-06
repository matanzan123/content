CREATE TABLE "whop_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firebase_uid" text NOT NULL,
	"whop_user_id" text NOT NULL,
	"whop_username" text,
	"scopes" text NOT NULL,
	"access_token_ciphertext" text,
	"refresh_token_ciphertext" text,
	"token_expires_at" timestamp with time zone,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_refreshed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "whop_oauth_states" (
	"state" text PRIMARY KEY NOT NULL,
	"firebase_uid" text NOT NULL,
	"code_verifier_ciphertext" text NOT NULL,
	"return_path" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_whop_connections_uid" ON "whop_connections" USING btree ("firebase_uid");--> statement-breakpoint
CREATE INDEX "idx_whop_connections_whop_user" ON "whop_connections" USING btree ("whop_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_whop_connection_active_user" ON "whop_connections" USING btree ("firebase_uid") WHERE revoked_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_whop_connection_active_whop_user" ON "whop_connections" USING btree ("whop_user_id") WHERE revoked_at is null;--> statement-breakpoint
CREATE INDEX "idx_oauth_states_expires" ON "whop_oauth_states" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_oauth_states_uid" ON "whop_oauth_states" USING btree ("firebase_uid");