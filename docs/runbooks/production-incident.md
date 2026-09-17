# Runbook: Production Incident (General)

## Severity levels

| Level | Definition | Response time | Example |
|---|---|---|---|
| P1 | Money moving incorrectly, data loss, auth broken | Immediate | Double-charge, payment not recorded, admin inaccessible |
| P2 | User-facing feature down, no data loss | < 1 hour | Creator cannot connect Whop, KYC flow broken |
| P3 | Degraded experience, workaround exists | < 4 hours | Slow page, audit page errors |
| P4 | Minor/cosmetic | Next deploy | Display bug, wrong label |

## First response (first 5 minutes)

1. **Is money at risk?** If yes → P1. Stop new transactions if possible (set `WHOP_ENV` to an invalid value temporarily to disable payment processing — this fails closed per the existing code).
2. **Check Vercel logs** for the error rate and first occurrence time.
3. **Check Whop status page** — is this upstream?
4. **Check Neon dashboard** — is the DB up?
5. **Preserve evidence** — do not redeploy until you have the failing request logs.

## Investigation
```bash
# Vercel logs (via Vercel CLI or dashboard)
vercel logs --since=<iso_timestamp>

# Or in Vercel dashboard: Functions → filter by status 500/503
```

Key tables to check depending on the symptom:

| Symptom | Tables to inspect |
|---|---|
| Payment not recorded | `payment_orders`, `whop_webhook_receipts`, `accounting_transactions` |
| Creator payout stuck | `creator_withdrawals`, `creator_transfers`, `whop_accounts` |
| Admin page broken | `admin_audit_log` (check for recent schema changes) |
| Webhooks failing | `whop_webhook_receipts` (check `status`, `failure_category`) |
| Auth broken | Firebase Console → Authentication → recent errors |

## Rollback a bad deploy
Vercel supports instant rollback to any previous deployment:
Vercel dashboard → your project → Deployments → select the last known-good deploy → Promote to Production.

This does **not** roll back database migrations. If the deploy included a migration, also follow [db-migration-rollback.md](db-migration-rollback.md).

## Communication
- Affected creators: notify directly if payments or payouts are impacted
- No public status page exists today — add one if this becomes recurring

## Post-incident (within 24 hours of resolution)
Write a brief post-mortem:
1. What happened (timeline)
2. Why it happened (root cause)
3. What was the impact (users, money, duration)
4. What was done to fix it
5. What prevents recurrence

Store in `docs/incidents/YYYY-MM-DD-<slug>.md`. Not in the audit log — that is per-action, not per-incident.

## Contacts
- Whop support: via Whop dashboard
- Neon support: via Neon dashboard
- Firebase support: via Firebase Console → Support
- Google Cloud: via Google Cloud Console → Support
