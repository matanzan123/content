CREATE TYPE "public"."payment_order_status" AS ENUM('created', 'checkout_created', 'payment_pending', 'paid', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "payment_orders" (
	"order_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment" "whop_environment" NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"status" "payment_order_status" DEFAULT 'created' NOT NULL,
	"purpose" text NOT NULL,
	"whop_checkout_id" text,
	"whop_plan_id" text,
	"whop_payment_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "idx_orders_status" ON "payment_orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_orders_created" ON "payment_orders" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_orders_checkout" ON "payment_orders" USING btree ("whop_checkout_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_orders_whop_payment" ON "payment_orders" USING btree ("whop_payment_id") WHERE whop_payment_id is not null;