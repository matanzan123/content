-- ENVIRONMENT ON THE WHOP OAUTH LINK.
--
-- WHY. `whop_connections` stores a Whop OIDC subject (`whop_user_id`) and the
-- encrypted tokens issued alongside it, and it had no `environment` column.
-- That looked harmless because OAuth is a different credential from payments,
-- but it is not: `whop-oauth.ts` resolves the authorize/token/userinfo hosts
-- from WHOP_ENV against two DIFFERENT hosts, and an app created at
-- sandbox.whop.com exists ONLY there. So a stored row is environment-specific
-- in every respect except the one column that would say so.
--
-- WHAT IT BREAKS. `POST /api/whop/account` uses `getActiveConnection(uid)` as
-- its proof of provider identity — the `whop_identity_required` gate — and that
-- read was environment-blind. After a cutover to WHOP_ENV=production, a
-- creator whose only link was made in SANDBOX still satisfies the gate, and the
-- route then creates a REAL production connected account (`biz_…`) for them via
-- the platform API key, stamping the sandbox `whop_user_id` into that
-- production account's provider metadata — which Task #9's reconciliation later
-- reads back as identity. A sandbox artefact authorising a production provider
-- mutation is the exact leak Task #25 exists to close.
--
-- The stale tokens would of course fail against the production host, but the
-- readiness signal, the account object and its metadata are all created before
-- anything would notice.
--
-- `whop_oauth_states` gets the same column for the same reason and one more: a
-- state minted in sandbox and redeemed after a cutover currently fails deep
-- inside the token exchange with a provider error. With the column present the
-- callback refuses it as a cross-environment state, which is a diagnosable
-- answer instead of a confusing one. `google_oauth_states` already carries
-- `environment`; this removes that inconsistency.
--
-- BACKFILL. Every existing row is sandbox, and that is measured rather than
-- assumed: a read-only inventory taken immediately before writing this
-- migration found every environment-carrying table in the database holding
-- sandbox rows and nothing else (whop_accounts 1, payment_orders 3,
-- accounting_transactions 3, payment_refunds 2, whop_webhook_receipts 7, all
-- sandbox; production 0 everywhere), with 1 active whop_connections row and 1
-- whop_oauth_states row. No production credential has ever been configured.
-- So the column is added with a 'sandbox' default, backfilled by that default,
-- and only then made NOT NULL and stripped of the default — a new row must
-- state its environment rather than inherit one.
--
-- SAFETY OF THE INDEXES. Both new keys are the old key PLUS `environment`, so
-- each is strictly WIDER: widening a unique key cannot create a collision the
-- narrower key allowed, so neither build can fail on uniqueness. The partial
-- `WHERE revoked_at is null` predicate is preserved on both — dropping it would
-- newly constrain revoked history rows, which exist precisely so that a
-- disconnect leaves a trail without blocking a later reconnection.
--
-- ORDER. CREATE-then-DROP, as in 0011, so uniqueness is never unenforced for an
-- instant. During the overlap the stricter old index still applies; the new
-- behaviour begins only when the DROP lands, inside this transaction.
--
-- LOCKING. Plain CREATE INDEX takes ACCESS EXCLUSIVE. Correct at this size —
-- one row. NOT the template to copy if this table ever grows; use CREATE UNIQUE
-- INDEX CONCURRENTLY outside drizzle's transaction wrapper and check for an
-- INVALID index afterwards.
--
-- CODE COUPLING. `whop-connections.ts` reads and writes these rows and its
-- queries are scoped by environment in the same change. A read that ignored the
-- new column would defeat the point of adding it.

ALTER TABLE "whop_connections" ADD COLUMN "environment" "whop_environment" DEFAULT 'sandbox' NOT NULL;--> statement-breakpoint
ALTER TABLE "whop_connections" ALTER COLUMN "environment" DROP DEFAULT;--> statement-breakpoint

ALTER TABLE "whop_oauth_states" ADD COLUMN "environment" "whop_environment" DEFAULT 'sandbox' NOT NULL;--> statement-breakpoint
ALTER TABLE "whop_oauth_states" ALTER COLUMN "environment" DROP DEFAULT;--> statement-breakpoint

-- One ACTIVE link per ClipRewards user, PER ENVIRONMENT.
CREATE UNIQUE INDEX "uniq_whop_connection_active_user_env" ON "whop_connections" USING btree ("firebase_uid","environment") WHERE revoked_at is null;--> statement-breakpoint
DROP INDEX "uniq_whop_connection_active_user";--> statement-breakpoint

-- One ACTIVE link per Whop identity, PER ENVIRONMENT. The anti-takeover rule
-- still holds inside an environment, which is the only place a Whop `sub` means
-- anything; a sandbox subject no longer blocks a production link.
CREATE UNIQUE INDEX "uniq_whop_connection_active_whop_user_env" ON "whop_connections" USING btree ("whop_user_id","environment") WHERE revoked_at is null;--> statement-breakpoint
DROP INDEX "uniq_whop_connection_active_whop_user";--> statement-breakpoint

CREATE INDEX "idx_whop_connections_env" ON "whop_connections" USING btree ("environment");
