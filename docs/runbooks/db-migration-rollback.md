# Runbook: Database Migration Rollback

## Architecture
Migrations are managed by drizzle-kit. Files live in `drizzle/`. The applied state is tracked in a `__drizzle_migrations` table in the database.

Drizzle does **not** auto-generate rollback scripts. This is intentional: destructive reversals (DROP TABLE, DROP COLUMN) are too risky to automate. All rollbacks are manual.

## Before any migration
1. Verify: `npm run db:status` — all existing migrations applied, connection OK
2. Back up: Neon supports PITR — note the current timestamp before running
3. Test: run `npm run db:migrate` against a branch database first, not the production connection

## If a migration fails mid-run
Drizzle uses transactions per statement where possible. A failed statement leaves the DB in a partially applied state.

1. Identify which statement failed (check the error output)
2. Connect to the database directly and check schema state:
   ```sql
   SELECT * FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 5;
   ```
3. If the migration entry is not present, the migration did not commit — the schema is unchanged. Fix the SQL and re-run.
4. If it is present but the schema is wrong — the migration committed but did something unexpected. Proceed to manual reversal below.

## Manual reversal
Write an inverse SQL script and apply it manually:

```sql
-- Example: reversing only the rate-limit part of 0010_creator_money_notifications_rate_limits.sql
-- Forward:  CREATE TABLE rate_limit_counters (...)
-- Reverse:
DROP TABLE IF EXISTS rate_limit_counters;

-- Rolling back a whole migration also requires removing its record:
DELETE FROM drizzle.__drizzle_migrations WHERE hash = '<hash_of_0010>';
-- Note: Postgres cannot drop a value added with ALTER TYPE ... ADD VALUE.
```

Then create the corrected migration file and re-run.

## Neon PITR (point-in-time recovery)
For a catastrophic migration (data loss):
1. Neon dashboard → your project → Restore → select a timestamp before the migration ran
2. Restore creates a new branch — do not immediately overwrite production
3. Verify the restored branch contains expected data
4. Update `DATABASE_URL` to point to the restored branch
5. Redeploy

## Post-rollback checklist
- [ ] `npm run db:status` shows expected tables
- [ ] App starts without DB errors
- [ ] `payment_orders`, `accounting_transactions`, `creator_withdrawals` row counts match pre-migration numbers
- [ ] No new `error` entries in Vercel logs
- [ ] Write `admin_audit_log` entry documenting the rollback
