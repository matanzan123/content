# Runbook: KYC Failure

## Detection
- Creator cannot finish verification, or dashboard verification card stays incomplete
- `account.updated` webhooks not arriving

## Check the live state (source of truth is Whop)
- As the creator (signed in): `GET /api/whop/kyc/status` and `GET /api/whop/payout/status` — both query Whop live.
- Whop dashboard → connected accounts → the creator's account.

```sql
SELECT id, whop_account_id, parent_account_id, environment, status, onboarding_type, updated_at
FROM whop_accounts WHERE firebase_uid = '<uid>';

SELECT event_type, status, failure_category, received_at
FROM whop_webhook_receipts WHERE event_type = 'account.updated' AND resource_id = '<whop_account_id>'
ORDER BY received_at DESC;
```

## Resolution
- **Not started / abandoned:** creator restarts from the dashboard (`POST /api/whop/kyc/start`, or `/api/whop/account/kyc-link`).
- **Under review:** wait; Whop decides. Nothing to do in-app.
- **Rejected:** requirements are Whop's. Creator contacts Whop support.
- **Whop shows approved, app does not:** confirm `account.updated` is subscribed on the production webhook and redeliver the event. There is no admin "force sync" endpoint.
- **Rate limited (429):** `whop:kyc_start` allows 10/hour per user. Wait for the hour window.
