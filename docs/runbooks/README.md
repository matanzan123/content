# Runbooks — ClipRewards Production

Operational recovery procedures. Read the relevant runbook **before** taking action.

## Index

| Scenario | Runbook |
|---|---|
| Payment failed or not settled | [payment-failure.md](payment-failure.md) |
| Refund needed | [refund.md](refund.md) |
| Chargeback / dispute opened | [dispute.md](dispute.md) |
| Creator KYC blocked | [kyc-failure.md](kyc-failure.md) |
| Connected account creation failed | [connected-account-failure.md](connected-account-failure.md) |
| Payout failed or stuck | [payout-failure.md](payout-failure.md) |
| Transfer row stuck in `pending` | [stuck-transfer.md](stuck-transfer.md) |
| Ledger out of balance | [reconciliation-mismatch.md](reconciliation-mismatch.md) |
| Webhook deliveries failing | [webhook-outage.md](webhook-outage.md) |
| Whop API down | [provider-outage.md](provider-outage.md) |
| Credential rotation | [secret-rotation.md](secret-rotation.md) |
| Database migration rollback | [db-migration-rollback.md](db-migration-rollback.md) |
| Production incident (general) | [production-incident.md](production-incident.md) |

---

## Monitoring

### Logs to watch
- Vercel → Functions logs: filter for `error`, `unverified`, `db_unavailable`, `rate_limited`
- Whop dashboard → Webhooks → Deliveries: undelivered = red flag
- Neon / database: long-running queries, connection exhaustion

### Key admin pages (require admin session)
- `/admin/finance` — trial balance, reconciliation discrepancies
- `/admin/sandbox-audit` — environment flags (must read `production` post-go-live)
- `/admin/revenue` — earnings overview
- `/admin/applicants` / `/admin/users` — KYC / connected account status per creator

### Alerts to set up (external, not in-app)
| What | Where to configure | Threshold |
|---|---|---|
| Webhook delivery failure rate | Whop dashboard | >5% in 15 min |
| 5xx rate | Vercel / uptime monitor | >1% sustained |
| Database connection exhaustion | Neon | >80% pool used |
| No webhook received in 1 hour | External cron + DB check | 0 rows in `whop_webhook_receipts` newer than 1h during business hours |
| Reconciliation gap | Admin → finance page manual check | Daily |

### Backup expectations
- **Database**: Neon automatic PITR (point-in-time recovery) — verify retention period in Neon dashboard (target: 7 days minimum). No additional backup script is in-app.
- **Secrets**: stored in Vercel environment variables. Maintain an offline copy (password manager, not a file in this repo).
- **Audit log**: `admin_audit_log` table is append-only. Do not delete rows.
- **Webhook receipts**: `whop_webhook_receipts` is the replay record. Do not delete rows.

---

## Launch Checklist

Run this in order before going live.

### Infrastructure
- [ ] `WHOP_ENV=production` in Vercel (Production environment only)
- [ ] `ENABLE_SANDBOX_CHECKOUT_TEST_UI` is unset or empty
- [ ] `APP_PUBLIC_URL` is the real production domain (no tunnel)
- [ ] `WHOP_API_KEY`, `WHOP_COMPANY_ID` are production values
- [ ] `WHOP_OAUTH_TOKEN_ENCRYPTION_KEY` is a fresh 32-byte key (not sandbox)
- [ ] `GOOGLE_TOKEN_ENCRYPTION_KEY` is set
- [ ] `DATABASE_URL` points to production Neon (pooled connection string)
- [ ] `FIREBASE_ADMIN_*` are the production service account credentials
- [ ] Production domain added to Firebase Authorized Domains

### Whop configuration
- [ ] Production app created at whop.com (not sandbox.whop.com)
- [ ] Webhook endpoint registered: `https://<domain>/api/webhooks/whop`
- [ ] Webhook subscriptions include all events in `SUPPORTED_EVENTS` (see `src/lib/server/whop-webhooks.ts:74`)
- [ ] `WHOP_WEBHOOK_SECRET` is the production signing secret (not reused from sandbox)
- [ ] OAuth redirect URI registered: `https://<domain>/api/whop/callback`

### Database
- [ ] `npm run db:migrate` run against production DATABASE_URL
- [ ] `npm run db:status` — all tables present, connection OK
- [ ] `/admin/sandbox-audit` → `WHOP_ENV` shows `production`, sandbox row counts = 0

### Google Calendar
- [ ] Redirect URI registered: `https://<domain>/api/google/calendar/callback`
- [ ] OAuth consent screen status is "Production" (not "Testing")
- [ ] Calendar account connected via `/api/google/calendar/connect` (admin action)

### Smoke tests (before first real transaction)
- [ ] Sign in with Google → Firebase session created
- [ ] Creator: start Whop OAuth → child account created → KYC initiated
- [ ] Admin: load `/admin` → all sections render, no DB errors in logs
- [ ] Send one test webhook event from Whop dashboard → receipt row appears in DB
- [ ] Admin: `/admin/finance` → trial balance shows 0s (expected, no transactions yet)
