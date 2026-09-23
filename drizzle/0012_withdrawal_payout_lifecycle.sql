-- CREATOR WITHDRAWAL → EXTERNAL PAYOUT LIFECYCLE (Task #15).
--
-- Two separate changes travel together because both are prerequisites for the
-- same feature and neither is useful alone.
--
-- ==========================================================================
-- PART 1 — `uniq_withdrawal_active_creator` BECOMES ENVIRONMENT-AWARE.
-- ==========================================================================
--
-- The index enforces "one active withdrawal per creator" on `(firebase_uid)`
-- alone. That is not one rule, it is two rules fused: a sandbox withdrawal and
-- a production withdrawal for the same creator are entirely unrelated pieces
-- of money, and the index made the first one block the second.
--
-- The consequence is a live production denial: any account used for sandbox
-- testing — which is every developer account — can be left permanently unable
-- to withdraw real earnings by one stale sandbox row. It is the same defect
-- migration 0011 fixed for seven provider-keyed indexes; this index is in that
-- family and was simply not in its scope.
--
-- Unlike 0011's cases, this key is OURS (`firebase_uid`), not Whop's, so there
-- was never an idempotency reason for the narrow key. It is just missing a
-- dimension.
--
-- SAFETY. The new key is the old key PLUS one column, so it is strictly WIDER.
-- A wider unique key cannot collide where the narrower one permitted, so this
-- build cannot fail on uniqueness. `environment` is NOT NULL and enum-typed,
-- so there is no NULL-distinctness surprise. The partial predicate is copied
-- BYTE FOR BYTE: only the key changes, never which rows are covered.
--
-- ==========================================================================
-- PART 2 — THE COLUMNS AN EXTERNAL PAYOUT ACTUALLY NEEDS.
-- ==========================================================================
--
-- A withdrawal used to be executed as an INTERNAL Whop ledger transfer
-- (`transfers.create`), which moves money from the platform balance to the
-- creator's Whop balance. That is Task #13, and it is not a withdrawal: the
-- money never leaves Whop. A withdrawal is `payouts.create` — the creator's
-- own balance to their own external destination — a different provider
-- resource with different ids (`wdrl_`), a different status vocabulary, and a
-- reversal state the transfer resource does not model.
--
-- `transfer_id` IS KEPT AND IS NOW LEGACY. Rows written before this migration
-- reference a real `creator_transfers` row and that history stays readable. No
-- new withdrawal sets it. A `wdrl_` payout is not a `creator_transfer` and
-- must never be recorded as one.
--
-- WHAT IS DELIBERATELY NOT STORED: no account_reference, no institution name,
-- no destination detail, no quote token, no provider auth. A payout method is
-- referenced by its opaque `potk_` id and nothing else; the bank details
-- behind it stay at the provider, where they are already protected. Quote
-- tokens are short-lived secrets and are used within one request, never
-- persisted.

--> statement-breakpoint

-- ------------------------------ PART 1 ------------------------------------

CREATE UNIQUE INDEX "uniq_withdrawal_active_creator_env" ON "creator_withdrawals" USING btree ("firebase_uid","environment") WHERE status NOT IN ('paid', 'failed', 'canceled', 'reversed');--> statement-breakpoint
DROP INDEX "uniq_withdrawal_active_creator";--> statement-breakpoint
ALTER INDEX "uniq_withdrawal_active_creator_env" RENAME TO "uniq_withdrawal_active_creator";--> statement-breakpoint

-- ------------------------------ PART 2 ------------------------------------

-- THE LOGICAL IDENTITY OF ONE INTENDED WITHDRAWAL, supplied by the client and
-- persisted before anything else happens. A browser that retries a timed-out
-- POST sends the same value and resolves to the SAME row rather than starting a
-- second withdrawal. Nullable because rows written before this migration have
-- no such identity and must not be invented one.
ALTER TABLE "creator_withdrawals" ADD COLUMN "request_id" text;--> statement-breakpoint

-- The destination chosen at request time, as an opaque provider token. Kept so
-- a retry or a reconciliation can prove which destination the creator's intent
-- named, and so an idempotent replay carrying a DIFFERENT destination is
-- refused as a conflict instead of silently paying elsewhere.
ALTER TABLE "creator_withdrawals" ADD COLUMN "payout_method_id" text;--> statement-breakpoint

-- The provider's own id for the payout, prefixed `wdrl_`. The anchor for every
-- authoritative read: `payouts.retrieve({ id, account_id })`.
ALTER TABLE "creator_withdrawals" ADD COLUMN "provider_payout_id" text;--> statement-breakpoint

-- The provider's status verbatim, in ITS vocabulary, never translated on the
-- way in: requested | in_review | processing | completed | reversed |
-- canceled | failed | denied. Our own `status` column is a product lifecycle
-- and the two are deliberately separate — keeping the raw value means a future
-- mapping change can be re-derived from what the provider actually said,
-- rather than from what an older mapping decided it meant.
ALTER TABLE "creator_withdrawals" ADD COLUMN "provider_status" text;--> statement-breakpoint

-- A classified failure code from the provider's catalog. The CODE only: the
-- human-readable `message` may be personalised to the destination for callers
-- holding `payout:destination:read`, which makes it a PII carrier, so it is
-- never stored and never shown to a creator.
ALTER TABLE "creator_withdrawals" ADD COLUMN "provider_failure_code" text;--> statement-breakpoint

-- NO `accounting_transaction_id` COLUMN.
--
-- A draft of Task #15 posted an internal journal for every payout and used
-- that column to mark a balance reservation consumed. Both were wrong. Task
-- #13 already DISCHARGES `creator_payable` when the money reaches the
-- creator's own Whop account; a withdrawal then moves THEIR funds to THEIR
-- bank and creates no ClipRewards obligation at all. Debiting the liability a
-- second time drove it negative, and capping the withdrawal against it meant
-- a creator whose money had already arrived could never withdraw any of it.
--
-- With no journal there is nothing to point at, so the column is not created.

-- When the provider accepted the payout, and when we last read its truth.
-- `provider_submitted_at` is written BEFORE the provider call, so orphan
-- discovery has a lower bound to search from when a response is lost.
ALTER TABLE "creator_withdrawals" ADD COLUMN "provider_submitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "creator_withdrawals" ADD COLUMN "reconciled_at" timestamp with time zone;--> statement-breakpoint

-- ENVIRONMENT-AWARE UNIQUENESS ON BOTH KEYS, for the reason 0011 established.
--
-- `provider_payout_id` is WHOP'S namespace. Sandbox and production are
-- separate id spaces with no guarantee a `wdrl_` value is unique across them,
-- so a global key would let a sandbox delivery resolve a production
-- withdrawal — the precise isolation failure 0011 existed to remove.
CREATE UNIQUE INDEX "uniq_withdrawal_provider_payout_env" ON "creator_withdrawals" USING btree ("provider_payout_id","environment") WHERE provider_payout_id IS NOT NULL;--> statement-breakpoint

-- `request_id` is the CLIENT'S namespace, scoped per creator per environment.
-- Two creators may legitimately generate the same token, and the same creator
-- may reuse one across environments; only the triple identifies one intent.
CREATE UNIQUE INDEX "uniq_withdrawal_request_creator_env" ON "creator_withdrawals" USING btree ("firebase_uid","environment","request_id") WHERE request_id IS NOT NULL;--> statement-breakpoint

CREATE INDEX "idx_withdrawals_provider_payout" ON "creator_withdrawals" USING btree ("provider_payout_id");--> statement-breakpoint

-- Finds withdrawals needing an authoritative read: accepted by the provider
-- but not yet settled. The reconciliation sweep's only query.
CREATE INDEX "idx_withdrawals_reconcile" ON "creator_withdrawals" USING btree ("environment","status","provider_submitted_at") WHERE provider_payout_id IS NOT NULL;
