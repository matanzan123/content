# Runbook: Payout / Withdrawal Failure

## Lifecycle
`creator_withdrawals.status`: `requested` → `eligible` → `processing` → `provider_pending` → `paid` | `failed` | `canceled` | `reversed`

The withdrawal is funded by a `creator_transfers` row (`transfer_id`). `paid` is set only after Whop confirms via `payout.*` webhook.

## Detection
```sql
SELECT withdrawal_id, firebase_uid, environment, amount_minor, reserved_amount_minor, status,
       transfer_id, failure_reason, provider_pending_at, updated_at
FROM creator_withdrawals
WHERE status IN ('processing','provider_pending','failed')
ORDER BY updated_at;

SELECT t.transfer_id, t.status, t.provider_transfer_id, t.failure_reason
FROM creator_transfers t WHERE t.transfer_id = '<transfer_id>';

SELECT event_type, status, failure_category, received_at
FROM whop_webhook_receipts WHERE resource_id = '<provider_transfer_id>' ORDER BY received_at;
```

## Resolution
- **`provider_pending` > 2 business days:** check Whop. If Whop shows completed → redeliver the `payout.updated` webhook. If failed → see below.
- **`failed`:** read `failure_reason`. Usually creator bank/KYC details — creator fixes them in the Whop payout portal, then requests a new withdrawal.
- **`reversed`:** bank returned the funds. Accounting (`payout_reversed`) posts from the webhook. Creator fixes details and requests again.
- Admin actions per withdrawal: `GET/POST/DELETE /api/admin/withdrawals/<id>` (30/hour).

## Never
- Never re-run a transfer for the same withdrawal until Whop definitively shows the first one failed.
- Check the reserved earnings before retrying:
```sql
SELECT we.earning_id, e.status, e.net_amount_minor, e.transfer_id
FROM creator_withdrawal_earnings we JOIN creator_earnings e ON e.earning_id = we.earning_id
WHERE we.withdrawal_id = '<withdrawal_id>';
```
