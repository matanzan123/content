# Runbook: Refund

Refunds are issued in the Whop dashboard. The app learns about them via `refund.created` / `refund.updated` and posts the ledger automatically.

## Steps
1. Whop dashboard → Payments → the payment → Refund.
2. Verify the refund row and receipts:
```sql
SELECT refund_id, whop_refund_id, order_id, amount_minor, provider_status, status, failure_reason
FROM payment_refunds WHERE whop_payment_id = '<whop_payment_id>';

SELECT event_type, status, failure_category, received_at
FROM whop_webhook_receipts WHERE resource_id = '<whop_refund_id>' ORDER BY received_at;
```
3. Verify accounting: expect `payment_refunded` and `revenue_split_reversed` for the order.
```sql
SELECT t.economic_event, e.account, e.amount_minor
FROM accounting_transactions t JOIN accounting_entries e ON e.transaction_id = t.transaction_id
WHERE t.order_id = '<order_id>' ORDER BY t.posted_at, e.leg;
```
4. Verify creator earning reversal:
```sql
SELECT earning_id, status, reversed_at, transfer_id FROM creator_earnings WHERE order_id = '<order_id>';
```

## If accounting is missing
- Redeliver the refund webhook from Whop (idempotent).
- Or use the admin repair endpoint: `POST /api/admin/reconciliation/repair/refunds` (admin session required).

## Creator already paid
If the earning was already `transferred`, the reversal cannot pull money back automatically, and the transfer API does not accept negative amounts. Handle manually with the creator and record it in `admin_audit_log`.
