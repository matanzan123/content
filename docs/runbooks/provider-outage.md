# Runbook: Whop Provider Outage

## Detection
- Whop status page: https://status.whop.com
- API calls returning 503 / 502 from Whop's servers
- Vercel function logs: `fetch failed`, `ECONNREFUSED`, or Whop error responses
- Creator flows (checkout, connect, KYC, payout portal) returning errors

## App behavior during an outage
The app is designed to fail closed, not fail open:
- Checkout creation: returns error, no payment object created, no money moves
- Whop OAuth / connect: returns error, no account row created
- KYC start: returns error
- Payout portal: returns error
- Webhook receipt: if Whop's outage affects delivery — see [webhook-outage.md](webhook-outage.md)

No data corruption should result from an outage because no partial writes occur (each operation is atomic).

## During the outage
1. Monitor Whop status page for ETA
2. Do not attempt to work around the outage by calling Whop's API directly in ways not modeled in the app — this risks creating orphaned state
3. Inform affected creators that the issue is upstream

## After recovery
- Retry any creator flows that were interrupted (they are stateless — starting over is safe)
- Check `whop_webhook_receipts` for any gaps during the outage window — Whop may re-deliver missed events or they may need manual recovery (see [webhook-outage.md](webhook-outage.md))
- Check `payment_orders` for rows stuck in `checkout_created` / `payment_pending` that should have been resolved

## If the outage affects only specific Whop regions
Whop's sandbox and production are separate systems. An outage of sandbox does not affect production and vice versa. Confirm `WHOP_ENV` is `production` before investigating.

## Escalation
- Whop support: via their dashboard or status page contact
- For payments impacted: document the time window and the payment IDs for post-recovery reconciliation
