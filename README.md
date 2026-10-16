# ChatBeds × Google Calendar — Phases 1 and 2

Documentation correction (checked 15 October 2026): the live [ChatBeds conventions](https://dev.chatbeds.app/docs/getting-started/conventions) and [App OAuth reference](https://dev.chatbeds.app/docs/apps/oauth) document `https://app.chatbeds.app/partner/v1`, `https://app.chatbeds.app/oauth/token`, and `https://app.chatbeds.app/oauth/revoke`. Earlier project examples used the `api.chatbeds.app` host. Update those three environment values locally and in Vercel, then restart/redeploy. Runtime endpoints remain environment-configured; existing secret files have not been changed.

This app copies reservations from **your ChatBeds Sandbox Hotel** to Google Calendar. Create a booking in ChatBeds and an all-day event appears. Change the booking and the same event updates. Cancel it or mark it no-show and its event is deleted. You can also import bookings whose **arrival dates** fall in a selected range (1–90 inclusive dates).

**Phase 2 is implemented:** ChatBeds App OAuth with PKCE, encrypted per-property access/refresh tokens, single-use refresh rotation protected by Postgres leases, revocation, reconnect, app-wide webhook routing, and independent Google connections and sync history for each property. The dashboard uses ChatBeds blue/navy and Google Calendar colors.

The existing private-key integration remains available with `CHATBEDS_AUTH_MODE=api_key` (the default). Switch to `oauth` only after completing the additive database migration and ChatBeds app registration. **Existing installations: start with [the Phase 2 upgrade guide](PHASE_2_APP_OAUTH.md).** Do not overwrite your existing `.env.local` or encryption key.

The application has two access modes. The default `APP_ACCESS_MODE=private` retains the original trusted admin workspace; do not share that password with customers. **Public mode is implemented:** `APP_ACCESS_MODE=public` uses **Continue with Google** to sign in and authorize Calendar in one Google flow, followed by ChatBeds property consent. The same Google account's Calendar is connected automatically. No emailed OTP, SMTP or separate initial Google connection step is required. Start with [PUBLIC_LAUNCH_GUIDE.md](PUBLIC_LAUNCH_GUIDE.md) to apply the third/fourth additive migrations, enable Supabase's Google provider, attach your existing property safely, and prepare the listing. ChatBeds listing approval, Google verification and live provider testing remain external setup processes.

## Architecture

```text
ChatBeds Sandbox Hotel
    ├── signed webhook → Next.js /api/webhooks/chatbeds → Supabase durable job
    └── documented reservation reads ← Next.js job processor
                                           ↓
                              encrypted Google OAuth credentials
                                           ↓
                               Google Calendar API → all-day events

Admin browser → password-protected Next.js dashboard
Next.js App Router + TypeScript → Vercel Node.js functions
All persistent configuration, credentials, mappings, deliveries, jobs and logs → Supabase Postgres
```

There is no SQLite database, local persistent storage, long-running server or background daemon. Next.js `after()` starts bounded work after the response on Vercel. Every processing run uses a Postgres lease; unfinished work is saved in Supabase. Dashboard polling starts further bounded runs while it is open. The included daily Vercel cron is a recovery sweep. Retries, reconnects and manual imports reuse the same synchronization module.

## Before you start

- Install Node.js **24 LTS** and npm (Node 22+ is supported).
- Have a ChatBeds developer account with a Sandbox Hotel and its private API key.
- Create a Google Cloud project and a Google account you will use for testing.
- Create a Supabase cloud project. Local development also uses that cloud Postgres database.
- Have a Vercel account. A GitHub/GitLab/Bitbucket repository makes deployment easy.
- For local webhook testing only, use a public HTTPS tunnel (Cloudflare Tunnel or ngrok).

Read the project instructions in `AGENTS.md` (originally supplied as `AGENTS (1).md`). No real credentials are included in this repository.

## 1. Install the project locally

In PowerShell, from the project folder:

```powershell
npm ci
Copy-Item .env.example .env.local
```

Edit `.env.local` in your editor. Never put secret values in source files, screenshots, browser code or Git. `.env.local`, other `.env` files, downloaded credential JSON, `.vercel` and build outputs are ignored.

## 2. Create the Supabase database

1. Go to [Supabase](https://supabase.com/dashboard), create a project, choose a region close to your Vercel functions, and save the database password privately.
2. Wait for the database to become ready.
3. Open **SQL Editor → New query**.
4. On a **new database**, run `supabase/migrations/202610110001_phase1.sql`, then run `supabase/migrations/202610110002_phase2.sql` in a separate query. On an **existing working Phase 1 database**, run **only** `202610110002_phase2.sql`. Each migration is transactional and runs once; never rerun Phase 1 against an existing schema.
5. Under project API/connect settings copy the project URL to `SUPABASE_URL` and the **legacy service_role** key to `SUPABASE_SERVICE_ROLE_KEY`. This server-only key bypasses RLS. Do not use the `anon` key and do not prefix this variable with `NEXT_PUBLIC_`.
6. These migrations create integration settings, encrypted Google and ChatBeds credentials, reservation mappings, webhook deliveries, durable jobs/logs, OAuth states, admin throttling and database leases. Phase 2 preserves the existing sandbox row and Google credentials/mappings. RLS denies browser/anonymous access. Webhook delivery and job recording occur in **one transaction**.

If you prefer reproducible CLI deployment instead of SQL Editor:

```powershell
npx supabase login
npx supabase init
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase db push
```

Use **one** migration method. If you already applied SQL in the editor, do not `db push` it again without reconciling migration history. No local Supabase/Docker instance is needed for the editor method. The application uses Supabase's server-side HTTPS client; no `DATABASE_URL` or direct connection pool setup is needed.

## 3. Obtain the ChatBeds values

For **App OAuth**, follow [PHASE_2_APP_OAUTH.md](PHASE_2_APP_OAUTH.md): create an app in Developers with `reservations:read`, configure its callback and application webhook, add the six OAuth variables, and set `CHATBEDS_AUTH_MODE=oauth`. You do not need a `cbk_` key in this mode. Click **Connect ChatBeds**, choose your Sandbox Hotel and Allow. Add more properties with **Add property**; each has its own Google connection, jobs and history.

The following instructions apply to **private API key mode** (`CHATBEDS_AUTH_MODE=api_key`):

1. Open [ChatBeds Developers](https://app.chatbeds.app/developers). If needed, create your developer account via the [official quickstart](https://dev.chatbeds.app/docs/getting-started/quickstart).
2. Find **Your sandbox**. Copy the Sandbox Partner API key into `CHATBEDS_API_KEY` in `.env.local`. It begins with `cbk_` and is shown once. If lost, generate another key in the Sandbox Hotel's **Settings → Partner API** and revoke the old one.
3. Copy the API address shown in the panel into `CHATBEDS_API_BASE_URL`. The official Partner v1 address currently documented is `https://app.chatbeds.app/partner/v1`. The app reads it from the environment; it has no code fallback.
4. Later, sign in to the integration and click **Test ChatBeds connection**. This calls documented `GET /me`, stores the property ID/name, and binds this installation to that property. The key itself is never sent to your browser or stored in Postgres.
5. The fixed private key must keep using the same sandbox property. App OAuth supports multiple properties in the same database. Connecting OAuth for the existing sandbox property preserves its integration ID and Calendar mappings.

## 4. Configure Google Cloud

1. Open [Google Cloud Console](https://console.cloud.google.com/), create/select a project.
2. In **APIs & Services → Library**, find **Google Calendar API** and enable it.
3. Configure **Google Auth Platform / OAuth consent screen**: set app name, support/developer email, and audience. For a personal sandbox app, use External / Testing and add your Google account as a **test user**. If using a Workspace Internal app, your account must belong to that organization.
4. Configure these permissions: `openid`, `email`, and `https://www.googleapis.com/auth/calendar.events`. The first two identify the connected account; the last allows reading/creating/updating/deleting events. This app does not ask for broad Calendar management or guest contact permissions.
5. Create an OAuth client of type **Web application**.
6. Add this exact authorized redirect URI for local development:
   `http://localhost:3000/api/google/callback`.
7. Copy its Client ID and Client Secret into `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env.local`. Set `GOOGLE_REDIRECT_URI` to that same local URI.
8. Use `GOOGLE_CALENDAR_ID=primary` initially. You may specify a calendar ID where the account can edit events. Changing this environment value takes effect on the **next Google connection**; existing mappings are scoped to property, account and calendar. Select the property in the dashboard before connecting Google.
9. The app requests offline access and consent, uses state plus PKCE, validates Google ID tokens, and encrypts access/refresh tokens before storing them. OAuth state is bound to your admin session and consumed once in Postgres. The Google client library refreshes expired access tokens; refreshed tokens are persisted.

Google's Testing audience can make refresh tokens expire after seven days when Calendar scopes are used. If synchronization later reports an authorization problem, reconnect. See [Google's official web-server OAuth guide](https://developers.google.com/identity/protocols/oauth2/web-server).

## 5. Complete `.env.local`

All of the following are needed. Use placeholders only in `.env.example`; put actual values in ignored `.env.local`:

| Variable | Local value / where it comes from |
|---|---|
| `CHATBEDS_AUTH_MODE` | `api_key` for the existing private-key flow; `oauth` for Phase 2 |
| `CHATBEDS_CLIENT_ID` | OAuth mode only: `cba_…` from ChatBeds Developers → your app |
| `CHATBEDS_CLIENT_SECRET` | OAuth mode only: `cbs_…` shown once when registering the app |
| `CHATBEDS_REDIRECT_URI` | OAuth mode only: `http://localhost:3000/api/chatbeds/callback` |
| `CHATBEDS_OAUTH_AUTHORIZE_URL` | OAuth mode only: `https://app.chatbeds.app/oauth/authorize` |
| `CHATBEDS_OAUTH_TOKEN_URL` | OAuth mode only: `https://app.chatbeds.app/oauth/token` |
| `CHATBEDS_OAUTH_REVOKE_URL` | OAuth mode only: `https://app.chatbeds.app/oauth/revoke` |
| `CHATBEDS_API_BASE_URL` | API address from ChatBeds Developers; currently `https://app.chatbeds.app/partner/v1` |
| `CHATBEDS_API_KEY` | API key mode only: Sandbox Hotel private `cbk_…` key |
| `CHATBEDS_WEBHOOK_SECRET` | OAuth: Developers → app → Webhook `whsec_…`; API key: secret from Settings → Partner API |
| `CHATBEDS_WEBHOOK_URL` | Your public HTTPS tunnel URL + `/api/webhooks/chatbeds`; before configuring webhooks the example local address is only a placeholder |
| `GOOGLE_CLIENT_ID` | Google Cloud Web Application OAuth Client ID |
| `GOOGLE_CLIENT_SECRET` | Google Cloud OAuth Client Secret |
| `GOOGLE_REDIRECT_URI` | `http://localhost:3000/api/google/callback` |
| `GOOGLE_CALENDAR_ID` | `primary` |
| `NEXT_PUBLIC_APP_URL` | `http://localhost:3000` (use this exact origin in the browser) |
| `SUPABASE_URL` | Your cloud Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase server-only service_role key |
| `TOKEN_ENCRYPTION_KEY` | Generate exactly 32 random bytes encoded as base64; command below |
| `SESSION_SECRET` | A separately generated random secret, at least 32 characters |
| `ADMIN_PASSWORD` | A separately generated random password, at least 24 characters; use it to sign into the dashboard |
| `CRON_SECRET` | A separately generated random secret for Vercel cron authentication |

Run this command **four separate times**, using a different output for encryption key, session secret, admin password and cron secret:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Keep `TOKEN_ENCRYPTION_KEY` stable and backed up privately: changing it makes previously stored Google tokens unreadable. Changing `ADMIN_PASSWORD` or `SESSION_SECRET` invalidates existing admin sessions. These values are never rendered to the dashboard. The only public variable is the app origin.

## 6. Run locally and connect

```powershell
npm run dev
```

1. Open `http://localhost:3000` using the same hostname/port configured above.
2. Sign in with your `ADMIN_PASSWORD`. Sign-in requires working Supabase and the migration, because throttling is persisted there (10 attempts per 15-minute window for this single-admin installation).
3. OAuth mode: click **Connect ChatBeds**, choose the Sandbox Hotel and Allow. API key mode: click **Test ChatBeds connection**. Confirm the property name and ID. Select the property to configure when multiple are connected.
4. Click **Connect Google Calendar** and approve the account and event permission. On Google's consent screen, explicitly select **View and edit events on all your calendars**, then continue. Adding the scope in Google Cloud does not grant it to the app; the connecting account must approve it too.
5. Return to the dashboard and check the account/calendar status.
6. Select arrival dates and click **Sync Reservations Now**. Counts and recent activity update through polling. Keep the dashboard open for large imports; polling invokes additional bounded serverless processing runs.

You can connect Google and run manual sync before configuring ChatBeds webhooks. A missing webhook secret/address or cron secret appears as a setup warning; it does not disable Google Connect or manual sync. Automatic webhook updates require the real signing secret, and scheduled recovery requires `CRON_SECRET`.

## 7. Configure a local webhook tunnel (optional before deployment)

1. Keep the local app running and expose port 3000 through a public HTTPS tunnel.
2. Set `CHATBEDS_WEBHOOK_URL=https://YOUR-TUNNEL-HOST/api/webhooks/chatbeds` in `.env.local`. Keep `NEXT_PUBLIC_APP_URL` and Google callback on localhost if you access the dashboard locally.
3. OAuth mode: save the public HTTPS address in **Developers → your app → Webhook**. API key mode: save it on **Sandbox Hotel → Settings → Partner API → the configured private key**. The app and key have different signing secrets; use the one belonging to your active mode.
4. Copy the newly generated `whsec_…` secret into `CHATBEDS_WEBHOOK_SECRET` and restart `npm run dev`.
5. Trigger bookings in the Sandbox Hotel. Watch delivery status in ChatBeds and recent activity in the integration.

Use the canonical `/api/webhooks/chatbeds` address. `/api/chatbeds/webhook` is an equivalent compatibility route for the supplied project instructions; it directly processes requests and does not redirect. Saving the ChatBeds webhook address again rotates the signing secret immediately, so update the environment and restart/redeploy each time.

## 8. Deploy to Vercel (recommended workflow)

```text
Local development → Supabase cloud schema → deploy Next.js to Vercel
    → obtain public Vercel URL → register Google redirect URI
    → configure ChatBeds Sandbox webhook → test the entire flow
```

1. Put the project source and `package-lock.json` in a private Git repository. Check `.gitignore` before committing. Use `git status --short`; `.env.local` must not appear.
2. In Vercel, import the repository. Select **Next.js**, project root as root directory, `npm run build` as build command, and the supported Node.js **24.x** runtime. Keep Next.js output settings automatic.
3. Add **every variable in the table below** to Production (and local Development if you use Vercel tooling). Use your Supabase cloud project. Avoid connecting preview deployments to the live sandbox installation; give previews separate credentials/database or leave the integration disabled there.
4. For the first deployment, URL variables can use a chosen final custom domain or an HTTPS placeholder. The build does not need credentials or contact external APIs. After Vercel assigns the domain, replace all URL variables with the actual public origin and redeploy.
5. Add `https://YOUR-VERCEL-DOMAIN/api/google/callback` to **Google Cloud → Web Application OAuth client → Authorized redirect URIs**. Copy it exactly, including the path, without a trailing slash.
6. Open the public app, sign in, and test ChatBeds. Connect Google from this public app.
7. OAuth mode: register `https://YOUR-VERCEL-DOMAIN/api/chatbeds/callback` as the app redirect, set install address to `https://YOUR-VERCEL-DOMAIN/api/chatbeds/install`, and save the application webhook address `https://YOUR-VERCEL-DOMAIN/api/webhooks/chatbeds` in **Developers → your app → Webhook**. API key mode: configure that webhook on your key in **Settings → Partner API**. Put the matching newly generated secret in Vercel and redeploy.
8. Webhook and Google callback paths must be publicly accessible: if Vercel Deployment Protection is enabled, disable it for this production deployment or configure path exceptions for these addresses. The app already protects admin operations, validates callback state, and verifies webhooks.
9. Confirm the daily cron exists in your Vercel project and that `CRON_SECRET` is set. The checked-in `vercel.json` is needed for this recovery cron only. It uses `0 0 * * *` (midnight UTC, **05:00 Asia/Karachi**); Hobby cron timing may be approximate. Normal webhooks process immediately after acknowledgment. An interrupted job/temporary outage can wait until the dashboard is opened or the next cron run. For frequent unattended recovery, use a Vercel plan supporting more frequent cron and change the schedule to `* * * * *` (once per minute).
10. All processing routes have Node.js runtime and `maxDuration=60`. They stop starting work after 35 seconds and enforce an approximately 40-second external-request budget, saving cursors for continuation. Use a region close to Supabase. Check Vercel function logs only for platform failures; application errors are sanitized in recent activity.

### Exact Vercel environment variable checklist

Use all local variables, with these values/changes:

```dotenv
CHATBEDS_API_BASE_URL=https://app.chatbeds.app/partner/v1
CHATBEDS_AUTH_MODE=oauth
CHATBEDS_CLIENT_ID=<your cba client ID>
CHATBEDS_CLIENT_SECRET=<your cbs client secret>
CHATBEDS_REDIRECT_URI=https://YOUR-VERCEL-DOMAIN/api/chatbeds/callback
CHATBEDS_OAUTH_AUTHORIZE_URL=https://app.chatbeds.app/oauth/authorize
CHATBEDS_OAUTH_TOKEN_URL=https://app.chatbeds.app/oauth/token
CHATBEDS_OAUTH_REVOKE_URL=https://app.chatbeds.app/oauth/revoke
CHATBEDS_API_KEY=<your sandbox cbk key>
CHATBEDS_WEBHOOK_SECRET=<secret generated for this deployed webhook>
CHATBEDS_WEBHOOK_URL=https://YOUR-VERCEL-DOMAIN/api/webhooks/chatbeds
GOOGLE_CLIENT_ID=<your Google web client ID>
GOOGLE_CLIENT_SECRET=<your Google web client secret>
GOOGLE_REDIRECT_URI=https://YOUR-VERCEL-DOMAIN/api/google/callback
GOOGLE_CALENDAR_ID=primary
NEXT_PUBLIC_APP_URL=https://YOUR-VERCEL-DOMAIN
SUPABASE_URL=https://YOUR-PROJECT.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<your server-only service_role key>
TOKEN_ENCRYPTION_KEY=<32 random bytes in base64>
SESSION_SECRET=<independently generated random secret>
ADMIN_PASSWORD=<independently generated admin password>
CRON_SECRET=<independently generated random cron secret>
```

In the checklist above, **omit `CHATBEDS_API_KEY` in OAuth mode**. For API key mode, set `CHATBEDS_AUTH_MODE=api_key` and omit the six OAuth-only variables. Environment changes require redeployment. Local and deployed apps sharing a database must keep the **same encryption key**. Prefer isolated Supabase projects for development and previews. Saving a new app/key webhook address replaces the old address and rotates its secret. Never configure a local filesystem database.

## End-to-end acceptance test

Use the Sandbox Hotel dashboard for these actions; this app intentionally never writes reservations to ChatBeds.

1. Test the ChatBeds connection. Confirm the sandbox property ID/name from `/me`.
2. Connect your Google test account. Confirm `primary` (or your chosen calendar).
3. Create a sandbox reservation with a clear test guest name and arrival/departure dates. In ChatBeds, confirm webhook delivery succeeded. In this app, see `reservation.created` and a successful create. In Google Calendar, find one all-day event. Departure is an **exclusive** end date: a stay Oct 31–Nov 2 covers Oct 31 and Nov 1.
4. Modify the guest name, dates, room assignment or check-in/out status. Confirm the original event updates; inspect the same `google_event_id` in Supabase mappings if needed.
5. Cancel the booking. Confirm the event disappears and mapping is retained inactive. Retry a delivery in ChatBeds if the UI supports it; no extra event should appear.
6. Create another booking and mark it no-show. Its `reservation.cancelled` delivery contains `status=no_show`; its event disappears.
7. Create bookings before setting the webhook, then manually sync their arrival range. Repeat the same range and confirm no duplicate events. Review created/updated/skipped/deleted/failed counts.
8. Delete an active booking's event by hand in Google Calendar, then manually sync its arrival range. The app recreates one event and repairs the mapping. Google tombstones are handled with a persisted event-ID generation.
9. Disconnect Google Calendar. Revocation applies to the app grant for that Google account and removes saved Google credentials for **all properties using that account**. The UI confirms this first. Existing events/mappings remain; jobs wait. Reconnect the same account/calendar and process pending work. A different account/calendar gets separate mappings.
10. Submit an unsigned POST to the webhook URL: it must return 400, store no delivery, and create no event.

## API behavior and limits verified against live docs

Sources were checked on **October 11, 2026**:

- [ChatBeds developer home](https://dev.chatbeds.app/), [quickstart](https://dev.chatbeds.app/docs/getting-started/quickstart), [API](https://dev.chatbeds.app/docs/api), [reservations](https://dev.chatbeds.app/docs/api/reservations), [webhooks](https://dev.chatbeds.app/docs/webhooks), [signature verification](https://dev.chatbeds.app/docs/webhooks/verify-signatures), [retries/delivery](https://dev.chatbeds.app/docs/webhooks/retries-and-delivery).
- [Google web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server), [Google event resource](https://developers.google.com/workspace/calendar/api/v3/reference/events), [event insert/custom IDs](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert).
- [Next.js after](https://nextjs.org/docs/app/api-reference/functions/after), [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security).

Corrections/clarifications from the initial instructions:

- The official reservation object also allows **`pending`** bookings from other sources. These hold rooms, so they are synchronized as active bookings.
- Search has **exact** `arrival`/`departure`, at least one documented primary filter, `limit` at most 100, and **no date-range/pagination fields**. This app queries one arrival date at a time and de-duplicates IDs throughout the import job. If a date returns 100 results, it additionally queries the five documented status filters. A status query reaching 100 is flagged as possibly incomplete. Pending cannot be used as a documented status search filter, so a saturated day's pending bookings may be incomplete. The app reports these limitations; it cannot guarantee importing more results than the documented API exposes.
- The webhook body is `{id,type,created_at,property_id,data:{reservation},…}`. `ChatBeds-Delivery`/`ChatBeds-Event` must match the signed body. HMAC uses the literal `whsec_…` secret and raw bytes, lowercase hex, with ±300-second timestamp tolerance and constant-time comparison. Unknown signature header parts are ignored. Automated tests include the official signature test vector.
- Deliveries can arrive out of order. The processor uses the webhook as a nudge and fetches **current** `GET /reservations/{id}` under the installation lease. Mappings also reject older `updated_at` values.
- Webhook receipt returns 204 only after its atomic durable database enqueue. Duplicate delivery IDs enqueue no new job. If persistence fails, it returns non-2xx so ChatBeds retries. Google outages happen after acknowledgment and are retried by the persistent job processor, dashboard or cron. This follows ChatBeds' recommendation to acknowledge first and process later.
- Cancellation deletes the event. HTTP 404/410 means it is already absent. Other deletion failures retain the active mapping and retry; the app never reports a failed delete as successful or silently creates a replacement event for a cancelled booking.
- Stable SHA-256 event IDs plus a mapping saved **before** Google insertion protect retries when Google succeeds but its response or a later DB write fails. Google 409 conflicts are recovered by reading/updating the existing ID.

## Automated checks

```powershell
npm run typecheck
npm run lint
npm test
npm run build
```

Tests use mocked ChatBeds/Google HTTP and mocked credentials. Postgres migration tests run in an **in-memory test database only**; production/local app persistence is always Supabase. Tests never contact your real ChatBeds/Google accounts. Tests cover the documented signature vector/timestamp/raw-byte rules, duplicate delivery queueing, Postgres permissions/locks, all-day events, token encryption/tampering, OAuth state rejection, refresh-token retention, create/update/cancel/no-show, stale versions, deleted events and partial-failure recovery.

At implementation time, `npm audit --omit=dev` reports zero production vulnerabilities. The full audit reports five development-only findings stemming from ESLint's `fast-glob` → `micromatch` → `braces` dependency. The latest published `braces` is still 3.0.3; no patched release is available. Do not apply npm's proposed obsolete Next.js lint-config downgrade or a forced breaking fix. These packages process repository lint patterns, not incoming web requests; check for an upstream fix when updating dependencies.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Sign-in fails / database operation failed | Confirm the Supabase project is active, URL/service_role key are correct, and migration ran. Sign-in uses Supabase throttling, so database setup comes first. |
| Too many sign-in attempts | Wait 15 minutes from the current attempt window; use the configured admin password. |
| ChatBeds key invalid/revoked | Check the sandbox `cbk_…` key, exact Partner API base URL and property; test connection again. Never paste the key into an issue or log. |
| OAuth `redirect_uri_mismatch` | Copy the full configured GOOGLE_REDIRECT_URI into Google's Web Application client. Check scheme, hostname, path and trailing slash. Restart/redeploy after changes. |
| OAuth access blocked / denied | Add your account as a test user, enable Calendar API and approve event scope. Workspace admins may restrict it. |
| Google Calendar event permission was not granted | Click Connect again. On Google's consent screen, select the permission to view and edit Calendar events before continuing. Declaring the scope in Google Cloud is separate from granting permission as a user. If the permission prompt does not appear, remove this app's existing connection at https://myaccount.google.com/connections and reconnect. |
| Google Connect button disabled | Test ChatBeds first, then complete the Google, Supabase, app URL, encryption and admin-session settings shown as missing. A webhook secret is not required for Google connection or manual sync. |
| OAuth state invalid | Start Connect again from the signed-in dashboard. Use the configured app origin, allow cookies, and complete consent within ten minutes. An expired/rotated session cannot finish an earlier connection. |
| Google Connect says the action must come from the configured app address | Use the exact origin in `NEXT_PUBLIC_APP_URL` (localhost and 127.0.0.1 are different). Restart/redeploy and reload the dashboard after updates. The app uses `Referrer-Policy: strict-origin`: `no-referrer` makes native form POSTs send `Origin: null`, which is intentionally rejected. |
| No refresh token / invalid grant | Disconnect, remove this app's access in Google Account → Security / third-party connections, then reconnect with consent. Testing tokens may expire after seven days. |
| Tokens cannot decrypt | Restore the original TOKEN_ENCRYPTION_KEY. If lost, disconnect and reconnect Google to store new encrypted tokens. |
| Webhook signature invalid | Use the signing `whsec_…` secret for **that key/address**, not the API key. Saving the URL rotates it. Check deployed env, restart/redeploy, and ensure the host clock is accurate. |
| Webhook never reaches the app | It must be public HTTPS. Check tunnel lifetime, correct route, deployment protection, ChatBeds delivery UI and the sandbox key used. |
| Webhook 204 but no event | Inspect persistent jobs/recent activity. Google may be disconnected, permissions revoked, or work queued behind a lease. Open the dashboard and use Process pending / retry errors. |
| Another synchronization is running | The installation lease serializes operations. Wait up to two minutes after a interrupted function; stale leases expire automatically. |
| Google 403/404 | Ensure the connected account can edit the configured calendar; enable Calendar API. Do not delete/change the calendar being used. Reconnect after changing GOOGLE_CALENDAR_ID. |
| ChatBeds 429/503 | The documented limit is 120 calls/minute. Work remains resumable; wait before retrying. Run smaller arrival ranges if necessary. |
| Manual job appears incomplete | Keep the dashboard open or process pending jobs; each serverless run is bounded. The daily cron is fallback, not a continuous worker. Saturated search results carry an explicit warning. |
| Deployed POST says wrong origin | NEXT_PUBLIC_APP_URL must equal the actual dashboard origin (no path). Visit that domain and redeploy after changing it. |
| Vercel cron unauthorized | Set CRON_SECRET in Production and redeploy. Vercel supplies `Authorization: Bearer <CRON_SECRET>`. |
| Preview deployment affects existing events | Use isolated Supabase and OAuth setup for previews; do not run multiple sandbox installations against the same database. |

## Operational notes

- Guest names and room names appear in Calendar events; guest phone/email, notes and payments do not. Sync logs contain reservation references/IDs and controlled error messages, never tokens or provider response bodies. Webhook payloads containing contact/payment information are validated then discarded; durable jobs store reservation IDs only.
- Dashboard cookies are HttpOnly, SameSite=Lax, secure on HTTPS, and expire after eight hours. Every browser mutation validates its Origin. OAuth cookies expire after ten minutes; state is one-use. Secrets and the Supabase service role key live only in server modules.
- Keep Google account/calendar configuration stable. Disconnect retains events for easy reconnect. If switching accounts/calendars, remove previous-target events manually if desired; the app intentionally cannot erase events after access is revoked.
- Jobs/logs/delivery IDs are retained for audit in Phase 1. Monitor Supabase storage. Periodically delete **completed** jobs/logs and consumed/expired OAuth states after a retention period; retain mappings and uncompleted jobs. Keep webhook delivery IDs at least one week (ChatBeds retries for about two days). Back up the database and encryption key.
- An empty `GET /api/health` response only proves the app is running, not provider connectivity. Dashboard statuses show the last successful/error connection test and persisted Google connection. Live account verification requires your credentials and the end-to-end procedure above.

See [PHASE_2_APP_OAUTH.md](PHASE_2_APP_OAUTH.md) for the implemented Phase 2 upgrade, exact environment settings, disconnect/reconnect behavior, and acceptance checks. The code can be tested without real provider credentials; the live OAuth and webhook flow requires your registered app and the manual setup there.
