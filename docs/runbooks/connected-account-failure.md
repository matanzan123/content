# Runbook: Connected Account Failure

## Detection
Creator's "Connect Whop" flow fails, or no child account is created.
```sql
SELECT state, created_at, expires_at FROM whop_oauth_states WHERE firebase_uid = '<uid>' ORDER BY created_at DESC;
SELECT whop_user_id, whop_username, connected_at, revoked_at FROM whop_connections WHERE firebase_uid = '<uid>';
SELECT whop_account_id, parent_account_id, environment, status FROM whop_accounts WHERE firebase_uid = '<uid>';
```

## Common causes
| Symptom | Cause | Fix |
|---|---|---|
| Whop rejects authorize (`redirect_uri`) | `WHOP_REDIRECT_URI` ≠ value registered on the production app | Make them identical |
| Whop rejects `client_id` | Sandbox app credentials with `WHOP_ENV=production` (apps exist in one environment only) | Use production app credentials |
| Connect refuses to start (503) | `WHOP_OAUTH_TOKEN_ENCRYPTION_KEY` missing | Set it, redeploy |
| Callback fails on state | Expired state / cookie lost / different browser | Creator retries from start |
| OAuth OK but no `whop_accounts` row | `POST /api/whop/connect` failed | Check Vercel logs for the reason; retry |
| 429 | 10/hour limit on `whop:connect` | Wait |

## Rules
- Never copy sandbox `whop_account_id` values into production rows.
- A row with `environment = 'sandbox'` is not usable in production. Creators create a fresh production account.
- Unlinking: `POST /api/whop/disconnect` as the creator.
