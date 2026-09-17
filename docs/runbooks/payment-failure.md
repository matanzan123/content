# Runbook: Payment Failure

## Detection
- Whop dashboard: payment `failed` / `canceled`
- `payment_orders.status` is `failed`, or stuck in `checkout_created` / `payment_pending`
- `whop_webhook_receipts` row with `event_type = 'payment.failed'`

```sql
SELECT order_id, environment, status, amount_minor, whop_payment_id, created_at, paid_at
FROM payment_orders WHERE whop_payment_id = '<whop_payment_id>' OR order_id = '<order_id>';

SELECT webhook_id, event_type, status, failure_category, delivery_count, received_at
FROM whop_webhook_receipts WHERE resource_id = '<whop_payment_id>' ORDER BY received_at;
```

## Resolution
- **Declined / insufficient funds:** nothing to do. No ledger entries exist for a failed payment (posting happens only on a matched `payment.succeeded`).
- **Whop shows succeeded, order not `paid`:** the webhook was missed or failed. Redeliver it from Whop → Webhooks → Deliveries. Idempotent — safe to retry.
- **Receipt `status = 'failed'`:** check `failure_category`, fix the cause, redeliver.
- **Provider-side bug:** contact Whop with the payment id. Never write ledger rows by hand.

## Verify accounting after a successful payment
```sql
SELECT t.economic_event, e.leg, e.account, e.amount_minor
FROM accounting_transactions t JOIN accounting_entries e ON e.transaction_id = t.transaction_id
WHERE t.order_id = '<order_id>' ORDER BY t.posted_at, e.leg;
```
Expect `payment_settled` and `revenue_split`. Each transaction's `amount_minor` sums to 0 (debit positive, credit negative).
