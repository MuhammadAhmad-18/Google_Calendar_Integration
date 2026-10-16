# Phase 2 — ChatBeds App OAuth: upgrade and setup

Phase 2 is implemented. Real ChatBeds App OAuth replaces the fixed sandbox key while preserving the reservation synchronization logic. Private-key mode remains available. First test the unlisted app with your own Sandbox Hotel; ChatBeds allows unlisted apps only within their developer's account.

The default private mode is a **trusted admin workspace**. Public hotel accounts and ownership authorization are implemented behind `APP_ACCESS_MODE=public`: one Google consent signs in and connects Calendar, followed by ChatBeds property authorization. See [PUBLIC_LAUNCH_GUIDE.md](PUBLIC_LAUNCH_GUIDE.md) for the third/fourth migrations, Supabase Google provider setup and safe migration of your existing property. No email OTP or SMTP is required. The instructions below cover Phase 2 private-admin OAuth setup. ChatBeds review, Google verification and your real operator identity remain external setup processes.

## Implemented behavior

- Authorization-code flow, PKCE S256, random state, encrypted browser state bound to the signed-in admin, ten-minute expiry and one-use state consumed in Postgres.
- Official authorize/token/revoke endpoints read from environment variables; server-side form requests use `client_secret_post`. Only `reservations:read` is requested. `/me` needs no scope.
- Encrypted `cbat_`/`cbrt_` credentials, installation ID, property ID, scopes and expiry per installation. Tokens never enter browser JSON, localStorage, query strings or logs.
- Separate durable leases for sync and rotating ChatBeds refresh. Both replacement tokens are saved before the new access token is used. Refresh POSTs are never automatically retried.
- A durable refresh-start marker survives crashes. An uncertain response/save requires reconnect instead of reusing a single-use token. Explicit HTTP 429 is the documented exception: ChatBeds says the request did nothing, so retry is safe after `Retry-After`.
- Expired access tokens refresh before use; a safe API read answering 401 triggers one refresh/retry. `invalid_grant`, uncertain refresh, or another 401 stops access. ChatBeds sends no uninstall webhook: a connection test/API read discovers hotel-side disconnection.
- Raw-body app webhook verification and installation routing by signed property ID; atomic delivery/job persistence and deduplication. Unknown properties are acknowledged without syncing. Disconnected properties retain late deliveries for reconnect.
- Property-scoped Google credentials, mappings, manual imports and history. Google OAuth state binds its target installation, so switching the selector during consent cannot put credentials under another property.
- Disconnect retains Calendar events/mappings. Reconnecting the same property preserves its internal ID and Google connection. Another property gets its own installation and Google connection.
- Database Partner API call budget below 120/minute, shared across invocations; 429/503 cooldowns and durable job backoff. Vercel recovery rotates across installations without a daemon.
- Google revocation removes that Google account's grant across this app's properties. The UI confirms it first. Google requests/account changes share a Postgres lease so another property's refresh cannot restore revoked credentials.

## Manual Setup I Need To Do

### 1. Supabase

1. Back up the existing database and save your current encryption key privately.
2. Open the existing project → **SQL Editor → New query**.
3. Copy the entire `supabase/migrations/202610110002_phase2.sql` file, paste it, and click **Run** once.
4. **Do not rerun Phase 1** on your working database. A fresh database needs `202610110001_phase1.sql` then `202610110002_phase2.sql` in order. The additive migration retains the existing sandbox row, Google tokens, mappings and jobs.
5. Keep `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `TOKEN_ENCRYPTION_KEY` unchanged. No new database/browser key is needed.

If using CLI migration history, run `npx supabase db push` against your linked project instead. Do not mix manual SQL Editor and CLI history without reconciling it first.

### 2. ChatBeds Sandbox / Developers

1. Open [ChatBeds Developers](https://app.chatbeds.app/developers) → **Your apps → New app**.
2. Name it, for example, **ChatBeds Calendar Sync**. Enable **only `reservations:read`**, unchecking default extra scopes. This integration never writes ChatBeds bookings.
3. Register `http://localhost:3000/api/chatbeds/callback` as a redirect address.
4. Copy the new `cba_…` client ID and shown-once `cbs_…` client secret into the ignored `.env.local` variables below.
5. Add the production redirect: `https://YOUR-VERCEL-DOMAIN/api/chatbeds/callback`.
6. Set the production **Install address** to `https://YOUR-VERCEL-DOMAIN/api/chatbeds/install`. A signed-in admin proceeds to consent; otherwise login happens first and continues to consent. For local testing use the dashboard **Connect ChatBeds** button.
7. In **Developers → your app → Webhook**, save `https://YOUR-VERCEL-DOMAIN/api/webhooks/chatbeds`. For local testing use a public HTTPS tunnel with that path.
8. Copy its new `whsec_…` into `CHATBEDS_WEBHOOK_SECRET` and update `CHATBEDS_WEBHOOK_URL`. This is the **app** secret, distinct from the private API key's secret. Saving the webhook URL again rotates it for all app connections.
9. Set `CHATBEDS_AUTH_MODE=oauth`, restart/redeploy, start from this app's Connect button/install address, choose your Sandbox Hotel and Allow.
10. The ChatBeds developer-console shortcut uses `state=test`; this app correctly rejects that unissued state. Start from the integration, and never weaken state validation.
11. After app webhooks work, disable the old private-key webhook in Sandbox **Settings → Partner API** to avoid independent duplicate deliveries. OAuth mode never falls back to that private key.
12. Complete the acceptance test below before submitting for review. No production hotel access is required.

### 3. Google Cloud Console

1. Keep your existing Cloud project, enabled Calendar API and Web Application OAuth client.
2. Keep local callback `http://localhost:3000/api/google/callback`; add production callback `https://YOUR-VERCEL-DOMAIN/api/google/callback` if needed.
3. Keep scopes `openid`, `email`, `https://www.googleapis.com/auth/calendar.events` and your account as a test user while publishing status is Testing.
4. Select the property, then connect Google if it is not already connected. Explicitly select Calendar event access on Google's consent screen.
5. The original Sandbox Google connection survives migration. Additional properties need their own saved Google connection. The same account can be used; disconnect revokes its grant across all those properties.

### 4. Vercel

1. Deploy the updated repository and apply the database migration before using it.
2. Add all variables in the local block below to Production, replacing the four URLs listed in the Vercel block.
3. Copy the public Vercel callback/install/webhook URLs back to Google Cloud and ChatBeds exactly.
4. Update the matching app webhook secret, then redeploy. Environment changes always require redeployment.
5. Ensure callbacks, install and webhook endpoints are publicly reachable through Deployment Protection. Admin actions remain session protected, callbacks validate state, and webhooks verify signatures.
6. Keep `CRON_SECRET` and the included daily recovery cron. Open the dashboard / click **Process pending / retry errors** for immediate continuation. Frequent unattended recovery requires a suitable Vercel plan and more frequent cron; the Hobby daily sweep is not a continuous worker.
7. Use separate database/provider credentials for previews and development where possible.

## Exact `.env.local` values for OAuth mode

Keep existing secrets, particularly your encryption key. Add/update these values privately; substitute placeholders:

```dotenv
CHATBEDS_AUTH_MODE=oauth
CHATBEDS_API_BASE_URL=https://app.chatbeds.app/partner/v1
CHATBEDS_CLIENT_ID=cba_YOUR_APP_CLIENT_ID
CHATBEDS_CLIENT_SECRET=cbs_YOUR_APP_CLIENT_SECRET
CHATBEDS_REDIRECT_URI=http://localhost:3000/api/chatbeds/callback
CHATBEDS_OAUTH_AUTHORIZE_URL=https://app.chatbeds.app/oauth/authorize
CHATBEDS_OAUTH_TOKEN_URL=https://app.chatbeds.app/oauth/token
CHATBEDS_OAUTH_REVOKE_URL=https://app.chatbeds.app/oauth/revoke
CHATBEDS_WEBHOOK_SECRET=whsec_YOUR_APP_WEBHOOK_SECRET
CHATBEDS_WEBHOOK_URL=https://YOUR-PUBLIC-TUNNEL/api/webhooks/chatbeds
GOOGLE_CLIENT_ID=YOUR_EXISTING_GOOGLE_WEB_CLIENT_ID
GOOGLE_CLIENT_SECRET=YOUR_EXISTING_GOOGLE_CLIENT_SECRET
GOOGLE_REDIRECT_URI=http://localhost:3000/api/google/callback
GOOGLE_CALENDAR_ID=primary
NEXT_PUBLIC_APP_URL=http://localhost:3000
SUPABASE_URL=https://YOUR-PROJECT.supabase.co
SUPABASE_SERVICE_ROLE_KEY=YOUR_EXISTING_SERVICE_ROLE_KEY
TOKEN_ENCRYPTION_KEY=YOUR_EXISTING_32_BYTE_BASE64_KEY
SESSION_SECRET=YOUR_EXISTING_SESSION_SECRET
ADMIN_PASSWORD=YOUR_EXISTING_ADMIN_PASSWORD
CRON_SECRET=YOUR_EXISTING_CRON_SECRET
```

`CHATBEDS_API_KEY` is **not required** in OAuth mode; a value left in your local file is never used as fallback. API URLs have no runtime hard-coded defaults. Run `npm ci`, then `npm run dev` and open the configured app origin. For a webhook-only tunnel keep browser callbacks/app origin on localhost. If browsing through the tunnel, register and configure matching tunnel callback URLs instead.

## Exact Vercel environment variables

Add **every variable in the local block** to Vercel Production; change only these URL values:

```dotenv
NEXT_PUBLIC_APP_URL=https://YOUR-VERCEL-DOMAIN
CHATBEDS_REDIRECT_URI=https://YOUR-VERCEL-DOMAIN/api/chatbeds/callback
GOOGLE_REDIRECT_URI=https://YOUR-VERCEL-DOMAIN/api/google/callback
CHATBEDS_WEBHOOK_URL=https://YOUR-VERCEL-DOMAIN/api/webhooks/chatbeds
```

Use the app webhook secret generated for the deployed address, and the same encryption key as existing database credentials. No install URL variable is needed; the route is `/api/chatbeds/install`. Never prefix secrets with `NEXT_PUBLIC_`. `NEXT_DIST_DIR` is an optional local QA output-directory override; omit it for normal development and Vercel.

## Sandbox acceptance test

1. Migrate, configure, restart, sign in and connect ChatBeds. Choose Sandbox Hotel and Allow; confirm property ID/name, OAuth installation and permission.
2. Confirm the original Google connection is retained, or connect Google for a new property.
3. Configure the app webhook and create a sandbox reservation. Confirm a successful delivery, processed job and exactly one all-day event.
4. Modify dates/guest/room. Confirm the **same Google event ID** updates.
5. Cancel and separately test no-show. Confirm events are removed.
6. Manually sync the same range twice. Confirm no duplicates and useful counts.
7. Disconnect ChatBeds from this app; syncing stops, events/mappings remain. Revocation may leave a connection entry on the hotel's Apps page; only hotel-side Disconnect removes the entry.
8. Reconnect the same property. Confirm its internal integration ID, Google connection and mappings survive; process pending work without duplicates.
9. Disconnect in **ChatBeds Sandbox → Apps**, then click **Test ChatBeds connection** here. Confirm 401/invalid-grant marks it disconnected; no uninstall webhook is expected. Reconnect again.
10. Wait for access expiry (about one hour), then test/sync. Confirm expiry advances and both encrypted token values rotate. Never copy decrypted tokens or manually reuse a refresh token.
11. If your developer account has another property, Add property, connect its Google calendar, switch the selector and verify separate jobs/logs/mappings and correct property credentials.
12. Test cancelled consent and state expiry. Automated tests cover concurrent refresh, uncertain outcomes and cross-property routing with mocks.

Run `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`. Tests do not call live providers. Passing mocks does not replace the real consent/webhook checks using your app registration.

## Troubleshooting / rollback

| Symptom | Fix |
|---|---|
| Database operation failed | Apply Phase 2 once to the database actually configured; never rerun Phase 1. |
| ChatBeds Connect disabled | Set OAuth mode and all six OAuth variables, plus Supabase/app/encryption/session settings. Webhook secret is not needed to connect. |
| State invalid / `state=test` | Start from this app, enable cookies, use its configured origin and finish within ten minutes. |
| Redirect refused | Register the exact callback, including scheme/path/slash; enable only the needed scope. |
| App unavailable | Unlisted apps connect only within their developer's account; check suspension/listing. |
| `invalid_client` | Check client ID/secret, secret rotation and suspension; update env and restart/redeploy. |
| Refresh uncertain or failed | Reconnect. Never retry the old rotating `cbrt_` token manually. |
| Another token/account change running | Retry after the current request finishes; interrupted leases expire after two minutes. |
| Signature failed after saving webhook | Use the current application webhook secret, update env, restart/redeploy. |
| Webhook 204 but no event | Inspect the selected property's jobs/errors, connect Google and process pending work. Disconnected ChatBeds properties intentionally pause. |
| 429/503 | Honor displayed delay. Jobs/cooldowns persist. Use smaller imports if needed. |
| Duplicate-looking events after migration | Check property/integration ID and Google account/calendar, and disable the old key webhook. Inspect mappings before deleting data. |
| Need private-key rollback | Use the Phase 1 database backup/deployment with API key mode and original key/webhook. A converted OAuth row remains OAuth-bound; no silent auth fallback is allowed. The additive migration need not be reversed for a separate unconverted sandbox setup. |

Sources checked October 11, 2026: [ChatBeds OAuth](https://dev.chatbeds.app/docs/apps/oauth), [register app](https://dev.chatbeds.app/docs/apps/register-an-app), [scopes](https://dev.chatbeds.app/docs/apps/scopes), [identity](https://dev.chatbeds.app/docs/api/identity), [webhooks](https://dev.chatbeds.app/docs/webhooks), [signatures](https://dev.chatbeds.app/docs/webhooks/verify-signatures), [rate limits](https://dev.chatbeds.app/docs/resources/rate-limits), [review/listing](https://dev.chatbeds.app/docs/apps/review-and-listing), [going live](https://dev.chatbeds.app/docs/apps/going-live-checklist), [Google OAuth](https://developers.google.com/identity/protocols/oauth2/web-server).
