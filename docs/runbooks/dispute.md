# Runbook: Dispute (Chargeback)

## Detection
Webhooks `dispute.created`, `dispute_alert.created`, `resolution_center_case.created`.
```sql
SELECT dispute_id, whop_dispute_id, order_id, amount_minor, status, reason, evidence_due_at, evidence_submitted_at
FROM payment_disputes WHERE status IN ('warning','open') ORDER BY evidence_due_at;

SELECT alert_id, whop_alert_id, alert_type, status FROM dispute_alerts ORDER BY created_at DESC LIMIT 20;
SELECT case_id, whop_case_id, status, outcome FROM resolution_center_cases ORDER BY created_at DESC LIMIT 20;
```

**`evidence_due_at` is a hard deadline.** Sort by it and act first on the nearest.

## Response
1. Gather evidence: `payment_orders`, `interview_bookings` (scheduled time, `meeting_url`, status), `admin_audit_log`.
2. Submit evidence in the Whop dashboard (no in-app UI).
3. Outcome arrives as `dispute.updated` → `status` becomes `won` / `lost` / `closed`.

## Accounting
Posted automatically: `dispute_opened`, then `dispute_won` or `dispute_lost` (+ `revenue_split_reversed` on loss). Opening a dispute freezes the related earning:
```sql
SELECT earning_id, status, frozen_by_dispute, frozen_by_dispute_id FROM creator_earnings WHERE order_id = '<order_id>';
```
If entries are missing: `POST /api/admin/reconciliation/repair/disputes` or redeliver the webhook.

## Lost after creator was paid
Same as refunds: manual handling with the creator, documented in `admin_audit_log`.
