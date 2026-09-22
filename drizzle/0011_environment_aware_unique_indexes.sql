-- ENVIRONMENT-AWARE UNIQUE INDEXES.
--
-- WHY. Seven unique indexes keyed a PROVIDER-OWNED identifier without our
-- `environment`. Whop's sandbox and production are separate id spaces, so a
-- `pay_…`, `rf_…`, `dp_…` or `tr_…` value carries no proof of which
-- environment it belongs to. Two consequences, both bad:
--
--   1. A sandbox row and a production row naming the same provider id could
--      not coexist. The second insert was refused by the index rather than
--      stored, so a legitimate sandbox delivery could be rejected because
--      production already held that id.
--
--   2. The read-backs behind those indexes (getRefundByProviderId,
--      getDisputeByProviderId, getAlertByProviderId, getCaseByProviderId and
--      the recordCreatorEarning idempotency check) could not be scoped by
--      environment WITHOUT breaking idempotency, because the ON CONFLICT they
--      serve fired across environments. The index was load-bearing for
--      idempotency and simultaneously the thing preventing isolation.
--
-- Widening each key with `environment` fixes both: uniqueness becomes
-- per-environment, and the read-backs can be scoped without disagreeing with
-- the conflict target.
--
-- SAFETY. Every new key is the old key PLUS one column, so it is strictly
-- WIDER. Widening a unique key can never create a collision that the narrower
-- key permitted, so these builds cannot fail on uniqueness. `environment` is
-- NOT NULL and enum-typed on all seven tables, so no NULL-distinctness
-- surprise is possible either. A read-only audit
-- (scripts/env-uniqueness-audit.mjs) confirmed zero provider ids straddling
-- environments before this ran.
--
-- ORDER. Each pair is CREATE-then-DROP, not DROP-then-CREATE, so uniqueness is
-- never unenforced for an instant. During the overlap both indexes exist and
-- the stricter old one still applies, which is safe: the old key is a prefix of
-- the new one, so anything the new index accepts and the old refuses is exactly
-- the cross-environment duplicate we are trying to start allowing. That means
-- the new behaviour begins only once the DROP lands — inside this transaction,
-- so externally it is atomic.
--
-- LOCKING. These are plain CREATE INDEX statements, which take ACCESS
-- EXCLUSIVE on the table and block reads and writes for the duration. That is
-- correct here: the audit measured 3 rows in payment_orders, 2 in
-- payment_refunds and 0 in the other five, so each build is sub-millisecond.
-- IF THESE TABLES EVER GROW, this migration is NOT the template to copy —
-- use CREATE UNIQUE INDEX CONCURRENTLY, which cannot run inside a transaction
-- block and therefore needs its own migration outside drizzle's wrapper, plus
-- a check for an INVALID index afterwards.
--
-- PARTIAL PREDICATES ARE PRESERVED. `payment_orders` and `creator_transfers`
-- constrain only rows whose provider id is non-null; dropping that predicate
-- would newly constrain every unsettled order and unsubmitted transfer.
--
-- CODE COUPLING. Four `onConflictDoUpdate` targets name these columns and were
-- updated in the same change. An ON CONFLICT target that no longer matches a
-- unique index raises "there is no unique or exclusion constraint matching the
-- ON CONFLICT specification" at runtime, so schema and code must ship together.

-- payment_orders: (whop_payment_id) -> (whop_payment_id, environment)
CREATE UNIQUE INDEX "uniq_orders_whop_payment_env" ON "payment_orders" USING btree ("whop_payment_id","environment") WHERE whop_payment_id is not null;--> statement-breakpoint
DROP INDEX "uniq_orders_whop_payment";--> statement-breakpoint
ALTER INDEX "uniq_orders_whop_payment_env" RENAME TO "uniq_orders_whop_payment";--> statement-breakpoint

-- payment_refunds: (provider, whop_refund_id) -> (provider, whop_refund_id, environment)
CREATE UNIQUE INDEX "uniq_refunds_provider_refund_env" ON "payment_refunds" USING btree ("provider","whop_refund_id","environment");--> statement-breakpoint
DROP INDEX "uniq_refunds_provider_refund";--> statement-breakpoint
ALTER INDEX "uniq_refunds_provider_refund_env" RENAME TO "uniq_refunds_provider_refund";--> statement-breakpoint

-- payment_disputes: (provider, whop_dispute_id) -> (provider, whop_dispute_id, environment)
CREATE UNIQUE INDEX "uniq_disputes_provider_dispute_env" ON "payment_disputes" USING btree ("provider","whop_dispute_id","environment");--> statement-breakpoint
DROP INDEX "uniq_disputes_provider_dispute";--> statement-breakpoint
ALTER INDEX "uniq_disputes_provider_dispute_env" RENAME TO "uniq_disputes_provider_dispute";--> statement-breakpoint

-- dispute_alerts: (provider, whop_alert_id) -> (provider, whop_alert_id, environment)
CREATE UNIQUE INDEX "uniq_alerts_provider_alert_env" ON "dispute_alerts" USING btree ("provider","whop_alert_id","environment");--> statement-breakpoint
DROP INDEX "uniq_alerts_provider_alert";--> statement-breakpoint
ALTER INDEX "uniq_alerts_provider_alert_env" RENAME TO "uniq_alerts_provider_alert";--> statement-breakpoint

-- resolution_center_cases: (provider, whop_case_id) -> (provider, whop_case_id, environment)
CREATE UNIQUE INDEX "uniq_cases_provider_case_env" ON "resolution_center_cases" USING btree ("provider","whop_case_id","environment");--> statement-breakpoint
DROP INDEX "uniq_cases_provider_case";--> statement-breakpoint
ALTER INDEX "uniq_cases_provider_case_env" RENAME TO "uniq_cases_provider_case";--> statement-breakpoint

-- creator_earnings: (whop_payment_id, firebase_uid) -> (+ environment)
CREATE UNIQUE INDEX "uniq_creator_earnings_payment_creator_env" ON "creator_earnings" USING btree ("whop_payment_id","firebase_uid","environment");--> statement-breakpoint
DROP INDEX "uniq_creator_earnings_payment_creator";--> statement-breakpoint
ALTER INDEX "uniq_creator_earnings_payment_creator_env" RENAME TO "uniq_creator_earnings_payment_creator";--> statement-breakpoint

-- creator_transfers: (provider_transfer_id) -> (provider_transfer_id, environment)
CREATE UNIQUE INDEX "uniq_creator_transfers_provider_id_env" ON "creator_transfers" USING btree ("provider_transfer_id","environment") WHERE provider_transfer_id is not null;--> statement-breakpoint
DROP INDEX "uniq_creator_transfers_provider_id";--> statement-breakpoint
ALTER INDEX "uniq_creator_transfers_provider_id_env" RENAME TO "uniq_creator_transfers_provider_id";
