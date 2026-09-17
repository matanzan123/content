# Runbook: Reconciliation Mismatch

The journal is `accounting_transactions` + `accounting_entries`. Entry `amount_minor` is signed: **debit positive, credit negative**. Every transaction sums to 0.

## Detection
- `/admin/finance` → reconciliation / fee drift sections
- `GET /api/admin/reconciliation/summary`, `/balances`, `/payouts`, `/payment/<id>`

```sql
-- Whole journal must be 0
SELECT SUM(amount_minor) AS net FROM accounting_entries;

-- Unbalanced transactions
SELECT t.transaction_id, t.economic_event, t.idempotency_key, SUM(e.amount_minor) AS net
FROM accounting_transactions t JOIN accounting_entries e ON e.transaction_id = t.transaction_id
GROUP BY t.transaction_id HAVING SUM(e.amount_minor) <> 0;

-- Sandbox/production must never mix
SELECT environment, COUNT(*) FROM accounting_transactions GROUP BY environment;
```

## Investigation
1. Take `order_id` / `provider_resource_id` from the affected transaction.
2. Compare with Whop's record of the payment/refund/dispute amounts and fees.
3. Check `source_webhook_id` → `whop_webhook_receipts` for that delivery.

## Resolution
- **Never UPDATE or DELETE journal rows.** Corrections are new transactions (`reversal` / `manual_adjustment`) with `reverses_transaction_id` set.
- Missing refund/dispute postings: `POST /api/admin/reconciliation/repair/refunds` or `/repair/disputes`.
- Fee drift: `POST /api/admin/fees/reconcile/<id>`.
- Every manual correction gets an `admin_audit_log` entry: what, why, who.
