# Runbook: Webhook Outage

## Detection
- Whop dashboard → Webhooks → Deliveries: a large number of failed deliveries
- `whop_webhook_receipts` has no new rows despite known Whop activity
- `payment_orders` rows stuck in `checkout_created` or `payment_pending`
- Creator reports payment succeeded in Whop but not reflected in the app

## Immediate assessment

### Is the endpoint reachable?
```bash
curl -I https://<domain>/api/webhooks/whop
```
Expected: `405 Method Not Allowed` (GET is intentionally rejected). Any other response — DNS, 502, timeout — means the app is down.

### Is the signature secret correct?
If deliveries are reaching the endpoint but returning `401 unverified`:
- The `WHOP_WEBHOOK_SECRET` in the deployment does not match what Whop is signing with
- Check: Whop dashboard → Webhooks → your endpoint → show secret → compare to Vercel env var value
- Resolution: update `WHOP_WEBHOOK_SECRET` and redeploy (see [secret-rotation.md](secret-rotation.md))

### Is the database reachable?
A DB outage causes the webhook handler to return 500, which Whop retries. Check Neon dashboard for connection errors. The fail-soft pattern means the endpoint stays up but cannot persist receipts.

## Recovery

### When the endpoint comes back
Whop retries failed deliveries with backoff for a limited window — confirm the current retry window in Whop's webhook docs. Within it, events replay automatically and `webhook_id` dedupe prevents double-processing.

### After the retry window (or if events were dropped)
Events that were never delivered and are past Whop's retry window must be reconciled manually:

1. Pull the missed events from the Whop API (Whop supports listing events by time range)
2. For each missed `payment.succeeded`: verify `payment_orders` status and `accounting_transactions` — post manually if missing
3. For each missed `refund.*` / `dispute.*`: same check
4. Document all manual postings in `admin_audit_log`

### Re-delivering specific events
Whop dashboard → Webhooks → Deliveries → filter by date → select failed events → Retry. This is the preferred path for individual missed events.

## Prevention
- Configure an uptime monitor on `https://<domain>/api/webhooks/whop` (expect 405 from a GET)
- Alert when Whop delivery failure rate exceeds 5% over 15 minutes (Whop dashboard has a webhook health view)
