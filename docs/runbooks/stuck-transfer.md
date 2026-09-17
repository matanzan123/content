# Runbook: Stuck Transfer

A `creator_transfers` row is platform → creator's connected Whop account. It is separate from the creator's bank payout.

## Detection
```sql
SELECT transfer_id, firebase_uid, whop_account_id, environment, amount_minor, status,
       idempotency_key, provider_transfer_id, failure_reason, created_at, submitted_at
FROM creator_transfers
WHERE status IN ('pending','submitted') AND created_at < NOW() - INTERVAL '2 hours'
ORDER BY created_at;
```

| Status | Meaning |
|---|---|
| `pending` | Row written; Whop call not made or no response received |
| `submitted` | Whop returned a transfer id; waiting for webhook |
| `completed` / `reversed` | Set by webhook |
| `failed` | Whop rejected or network error. **Never auto-retried** |

## `pending` for more than a few minutes
Whop may or may not have received the call.
1. Search Whop dashboard transfers for the amount/account/time (and `idempotency_key` if shown).
2. **Exists in Whop:** record `provider_transfer_id`, set `status = 'submitted'`, write `admin_audit_log`.
3. **Does not exist:** set `status = 'failed'` with a reason **first**, audit it, and only then initiate a new transfer (dry run first).

## `submitted` for more than 2 business days
Check Whop. Completed → redeliver the webhook. Failed → mark `failed`, audit, investigate.

## Double-payment rule
A new transfer is allowed only when the old row is `failed` **and** Whop confirms no transfer exists.
