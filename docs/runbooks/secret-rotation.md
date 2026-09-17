# Runbook: Secret Rotation

## When to rotate
- Suspected credential leak (repo exposure, team member departure, phishing)
- Scheduled rotation policy (recommended: every 90 days for webhook secrets and API keys)
- Before: never rotate just because it is convenient — rotation has operational risk

## Secrets inventory

| Secret | Var name | Scope | Rotation impact |
|---|---|---|---|
| Whop API key | `WHOP_API_KEY` | Server only | API calls fail until new key is active |
| Whop OAuth client secret | `WHOP_CLIENT_SECRET` | Server only | In-flight OAuth flows fail; completed links are unaffected |
| Whop webhook signing secret | `WHOP_WEBHOOK_SECRET` | Server only | All deliveries rejected until updated; Whop retries within its retry window |
| Whop OAuth token encryption key | `WHOP_OAUTH_TOKEN_ENCRYPTION_KEY` | Server only | **All stored tokens become unreadable** — creators must re-link |
| Google Calendar OAuth secret | `GOOGLE_CALENDAR_CLIENT_SECRET` | Server only | Calendar connection must be re-authorized after rotation |
| Google token encryption key | `GOOGLE_TOKEN_ENCRYPTION_KEY` | Server only | Stored Google token becomes unreadable — must re-connect calendar |
| Firebase Admin private key | `FIREBASE_ADMIN_PRIVATE_KEY` | Server only | Admin sessions fail until new key is deployed |
| Database URL / password | `DATABASE_URL` | Server only | All DB operations fail until updated |

## Rotation procedure

### Step 1: Generate the new secret
- For encryption keys: `openssl rand -base64 32`
- For Whop keys: generate in Whop dashboard and keep both old and new available
- For Google: regenerate in Google Cloud Console

### Step 2: Deploy the new value (zero-downtime)
For secrets that require a matching update on the provider side (webhook secret, OAuth secret):

1. Update Vercel env var with the **new** value
2. Update the provider dashboard to use the **new** value simultaneously
3. Redeploy — there is a brief window where requests may use the old secret against the new provider value (or vice versa). For webhook secrets: Whop retries failed deliveries, so a brief rejection window recovers automatically.

### Step 3: Revoke the old secret
Do not revoke until the new value is confirmed working in production.

### Special case: encryption keys
`WHOP_OAUTH_TOKEN_ENCRYPTION_KEY` and `GOOGLE_TOKEN_ENCRYPTION_KEY` protect data at rest. Rotating them requires:
1. Decrypt all stored tokens with the old key
2. Re-encrypt with the new key
3. Replace the env var

**No migration script exists for this today.** If rotation is needed urgently:
- Set the new key
- Redeploy (all future tokens use the new key; old ones are now unreadable)
- Inform all affected creators to re-link their accounts
- For Google Calendar: re-connect the calendar account via `/api/google/calendar/connect`

### Step 4: Verify
- Check Vercel function logs for auth errors after rotation
- Send a test webhook from Whop dashboard and confirm `accepted` status
- Run an admin action and confirm no `firebase-admin` errors

### Step 5: Document
Write an `admin_audit_log` entry: which secret, reason for rotation, who performed it, date.
