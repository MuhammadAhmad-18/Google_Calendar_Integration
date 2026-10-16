# Public launch — Chatbeds x Google Calendar

The public onboarding flow now uses **one Google authorization for both sign-in and Calendar**:

```text
ChatBeds Apps → Connect → Continue with Google
  → choose Google account and allow Calendar events
  → authorize ChatBeds property
  → dashboard: both connected to that Google account
  → optional initial import → automatic reservation updates
```

There is no application email OTP, SMTP setup, or second initial Connect Google Calendar step. Google and ChatBeds still control their own authentication/security checks and consent. Google Calendar permission is required, never silently assumed. The code is implemented; real configuration, deployment, live tests, Google verification and ChatBeds listing approval remain your setup tasks.

App name: **Chatbeds x Google Calendar**. Support: **mrmado835@gmail.com**. Set your real operator identity and review the public privacy policy before launch. Do not imply official endorsement by either service.

## 1. Preserve your existing installation

Back up Supabase and `.env.local`. Preserve `TOKEN_ENCRYPTION_KEY`; existing Google and ChatBeds credentials cannot be decrypted with a different key. Keep the existing Google Web Application client and stable production domain. Do not share `ADMIN_PASSWORD` with hotels.

## 2. Apply the missing migrations once

In Supabase SQL Editor, apply only files not already applied:

| Current database | Apply |
|---|---|
| Fresh | All four files below, in order |
| Phase 1 | Phase 2, public hotels, Google onboarding |
| Phase 2 | Public hotels, Google onboarding |
| Public hotels already applied | **Only Google onboarding** |

```text
202610110001_phase1.sql
202610110002_phase2.sql
202610120003_public_hotels.sql
202610150004_google_onboarding.sql
```

The fourth migration is additive. Do not edit/rerun migrations already applied. It adds encrypted short-lived Google setup grants and atomic completion functions, retaining existing connections/mappings. SQL Editor may warn about permissions/deletion statements: cleanup DELETE statements are function definitions, not immediate deletion of existing bookings/tokens. Back up and review the exact file before applying. Use CLI history instead if that is how your project manages migrations; do not apply the same migration through both methods.

## 3. Configure Supabase Google sign-in — no email delivery

1. Authentication → Sign In / Providers → **Google** → enable it.
2. Enter the **same Google Web Application client ID** used as `GOOGLE_CLIENT_ID` in this app. Enter its Google client secret where required by the provider configuration.
3. Keep nonce verification enabled. Do not enable Skip nonce check or bypass audience verification.
4. Allow new user signup so hotels can create accounts through Google.
5. Set Authentication → URL Configuration → Site URL to your deployed app origin.
6. Copy the project URL, publishable key (legacy anon key also works for Auth), and separate service-role key into the environment below.
7. Email OTP and custom SMTP are no longer required for this app. Its old request-code/verify-code routes return 410 with instructions to use Google.

**This implementation uses direct Google authorization-code exchange, then Supabase `signInWithIdToken` on the server.** Register the application's `/api/google/callback` with Google. Do not replace it with Supabase's `/auth/v1/callback`; that belongs to a different sign-in flow and is not used here. No extra application auth callback is needed.

Only the verified Google ID token and nonce go to Supabase. Google Calendar access/refresh tokens are encrypted in Postgres; they are not placed into the browser's Supabase session. Supabase Auth cookies are HttpOnly and verified with `getUser()`, plus an eight-hour user-bound signed session. No auth tokens are stored in localStorage.

Existing verified email-OTP accounts can be linked by Supabase to a matching verified Google identity under its identity-linking rules. Ownership uses the verified Supabase user ID, not a user-supplied email. If your Google account differs from your previous login, use operator-verified membership migration rather than bypassing ownership checks.

[Supabase Google sign-in](https://supabase.com/docs/guides/auth/social-login/auth-google), [signInWithIdToken](https://supabase.com/docs/reference/javascript/auth-signinwithidtoken), [identity linking](https://supabase.com/docs/guides/auth/auth-identity-linking).

## 4. Configure Google Cloud

1. Keep/create a Google Cloud project and enable **Google Calendar API**.
2. Configure Google Auth Platform branding with the app name, support contact, real homepage/privacy addresses and owned domain.
3. Create/keep an OAuth **Web application** client. Its credentials are used by both this app and the Supabase Google provider.
4. Add authorized redirect URIs:

```text
http://localhost:3000/api/google/callback
https://YOUR-DOMAIN/api/google/callback
```

5. Declare only `openid`, email (`https://www.googleapis.com/auth/userinfo.email` in the console), and `https://www.googleapis.com/auth/calendar.events`.
6. While testing, add participating Google accounts under Audience → Test users.
7. Before general public use, configure External production access, verify domain/branding and complete the applicable Calendar scope verification. Prepare a video showing the combined consent flow and reservation create/update/delete behavior. Production publishing status alone does not mean approval.

The app requests offline access and consent. A hotel must allow Calendar event permission. If unchecked, the app shows an actionable error and does not falsely mark Calendar connected. Default destination is `primary` for the chosen account. Testing-mode refresh tokens generally expire after seven days for these scopes.

[Google web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server), [OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect), [verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification).

## 5. Configure ChatBeds App OAuth

Developers → Your apps → New app. Name it **Chatbeds x Google Calendar**, enable only `reservations:read`, uncheck extra default scopes and save the shown-once `cba_…` client ID / `cbs_…` secret privately.

| ChatBeds setting | Production value |
|---|---|
| Install address | `https://YOUR-DOMAIN/api/chatbeds/install` |
| Redirect address | `https://YOUR-DOMAIN/api/chatbeds/callback` |
| Application webhook | `https://YOUR-DOMAIN/api/webhooks/chatbeds` |
| Scope | `reservations:read` |
| Support | `mrmado835@gmail.com` |
| Privacy | `https://YOUR-DOMAIN/privacy` |
| Website | `https://YOUR-DOMAIN` |

Add local redirect `http://localhost:3000/api/chatbeds/callback` for development. Save the **app webhook** and use its generated `whsec_…` secret. Saving its address again rotates the secret for all app installations. Do not use the old private-key webhook secret. Disable the old key webhook once app webhooks work.

Start from this app's install/Connect flow. The developer-console shortcut uses `state=test`, which the integration correctly rejects. An unlisted app can connect only within its developer account; listed apps require hotels to have eligible Partner API access in their plans.

[ChatBeds registration](https://dev.chatbeds.app/docs/apps/register-an-app), [OAuth](https://dev.chatbeds.app/docs/apps/oauth), [review/listing](https://dev.chatbeds.app/docs/apps/review-and-listing).

## 6. Exact local environment

Edit the ignored `.env.local`, preserving existing credentials and encryption key:

```dotenv
APP_ACCESS_MODE=public
APP_NAME="Chatbeds x Google Calendar"
PUBLIC_SUPPORT_EMAIL=mrmado835@gmail.com
PUBLIC_OPERATOR_NAME="REPLACE_ME_WITH_YOUR_REAL_BUSINESS_OR_OPERATOR_NAME"
DATA_RETENTION_DAYS=90

CHATBEDS_AUTH_MODE=oauth
CHATBEDS_API_BASE_URL=https://app.chatbeds.app/partner/v1
CHATBEDS_CLIENT_ID=cba_YOUR_APP_CLIENT_ID
CHATBEDS_CLIENT_SECRET=cbs_YOUR_APP_CLIENT_SECRET
CHATBEDS_REDIRECT_URI=http://localhost:3000/api/chatbeds/callback
CHATBEDS_OAUTH_AUTHORIZE_URL=https://app.chatbeds.app/oauth/authorize
CHATBEDS_OAUTH_TOKEN_URL=https://app.chatbeds.app/oauth/token
CHATBEDS_OAUTH_REVOKE_URL=https://app.chatbeds.app/oauth/revoke
CHATBEDS_WEBHOOK_SECRET=whsec_YOUR_APP_WEBHOOK_SECRET
CHATBEDS_WEBHOOK_URL=https://YOUR-DOMAIN/api/webhooks/chatbeds

GOOGLE_CLIENT_ID=YOUR_EXISTING_GOOGLE_WEB_CLIENT_ID
GOOGLE_CLIENT_SECRET=YOUR_EXISTING_GOOGLE_CLIENT_SECRET
GOOGLE_REDIRECT_URI=http://localhost:3000/api/google/callback
GOOGLE_CALENDAR_ID=primary

NEXT_PUBLIC_APP_URL=http://localhost:3000
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_SERVICE_ROLE_KEY=YOUR_EXISTING_SERVICE_ROLE_KEY
SUPABASE_PUBLISHABLE_KEY=YOUR_SUPABASE_PUBLISHABLE_OR_ANON_KEY
TOKEN_ENCRYPTION_KEY=YOUR_EXISTING_32_BYTE_BASE64_KEY
SESSION_SECRET=YOUR_EXISTING_LONG_RANDOM_SESSION_SECRET
CRON_SECRET=YOUR_EXISTING_LONG_RANDOM_CRON_SECRET
```

No new Google environment variables are required. No `ADMIN_PASSWORD`, `CHATBEDS_API_KEY`, SMTP variables or email template are needed in public mode. Private mode retains the original admin/sandbox behavior. Keep all credentials server-only, and the same encryption key for deployments sharing a database. Separate development/preview database/provider configuration is preferable.

```powershell
Set-Location -LiteralPath "D:\Chatbeds Project\Google Calendar Integration"
npm ci
npm run lint
npm run typecheck
npm test
npm run build
npm run dev
```

Open localhost:3000 → Connect your hotel → Continue with Google. Choose the Calendar account, allow event access, then authorize your own Sandbox Hotel in ChatBeds. The dashboard should show both connected without a separate initial Calendar step. Use the deployed app for first public webhook tests; local webhook testing needs a separate public HTTPS tunnel/app configuration. Avoid running competing local workers against production data.

## 7. Attach an existing legacy property safely

Unowned legacy connections are not automatically assigned to the first Google signup. After signing in with Google, find your verified user UUID in Supabase Authentication → Users. Check that it belongs to you.

For an unowned existing `sandbox` installation, replace the placeholder and run:

```sql
insert into public.integration_members(integration_id,user_id,role)
select 'sandbox',id,'owner' from auth.users
where id='YOUR_VERIFIED_USER_UUID'::uuid
  and email_confirmed_at is not null
on conflict(integration_id,user_id) do nothing;
```

Use the actual integration ID if different. If another owner already exists, do not overwrite it: verify the account/identity link or perform an operator-verified ownership transfer. Sign out/in and restart setup after assigning your legacy property. Reconnecting preserves its internal ID and mappings. Selecting another Google account/calendar intentionally uses that destination's mappings; old events remain in the previous calendar.

## 8. Deploy to Vercel

Publish source to a private Git repository excluding secret files and QA output. Import into Vercel as Next.js, Node 24.x, project root containing package.json, install `npm ci`, build `npm run build`, automatic output directory.

Add **every variable in section 6** to Production. Change these four URLs:

```dotenv
NEXT_PUBLIC_APP_URL=https://YOUR-DOMAIN
CHATBEDS_REDIRECT_URI=https://YOUR-DOMAIN/api/chatbeds/callback
GOOGLE_REDIRECT_URI=https://YOUR-DOMAIN/api/google/callback
CHATBEDS_WEBHOOK_URL=https://YOUR-DOMAIN/api/webhooks/chatbeds
```

For a first deployment, obtain the stable Vercel domain, configure/register the final URLs and app webhook secret, then redeploy. Environment changes require a new deployment. Update Supabase Site URL too. The Google client configured in Supabase must match the deployed `GOOGLE_CLIENT_ID`. Production install/callback/webhook endpoints must be reachable without Vercel Deployment Protection login. Admin/browser operations still require sessions; callbacks check state and webhooks verify signatures.

Use the exact `NEXT_PUBLIC_APP_URL` in the browser. `/api/health` confirms the application responds, not provider/database readiness. Keep previews isolated.

The included daily cron is a recovery sweep. For unattended public operation, use an eligible Vercel plan and set `/api/jobs/process` to `*/5 * * * *` (five-minute recovery), keep `CRON_SECRET` and redeploy. Hobby cron is daily. [Vercel cron limits](https://vercel.com/docs/cron-jobs/usage-and-pricing).

## 9. Acceptance tests

1. Signed-out directory install → Continue with Google → choose account A and allow Calendar → authorize Sandbox Hotel → dashboard shows correct property plus account A / primary connected. Confirm there was only **one Google consent**.
2. Import the same arrival range twice (max 90 dates per request); no duplicate events. Review API saturation warnings.
3. Create, modify, cancel and mark no-show in Sandbox; confirm one event is created, updated and removed appropriately.
4. Cancel Google consent and retry. Uncheck Calendar permission once; the app must request explicit permission rather than show connected.
5. Cancel ChatBeds consent; retry within fifteen minutes can reuse the encrypted pending Google setup. After expiry, Continue with Google again.
6. Sign out, then choose account B. A's properties/logs/credentials must not appear. Selecting A's integration ID must return 404. An attempted cross-owner property reconnect must not replace either provider's stored credentials.
7. Add another property from the public dashboard. It starts Google-first setup again so the chosen account/calendar is explicitly authorized for the new property. Existing property connections remain separate.
8. Test provider token expiry, refresh, disconnect/reconnect, queued recovery and wrong/expired OAuth state. Google grant revocation affects properties sharing that Google account and removes unused staged grants for it. Events remain on disconnect.
9. Verify support/privacy/operator details, mobile/desktop and email-free signup with a real account. Google may still require its own password/MFA/security checks.

Automated tests and isolated browser QA mock all providers. They do not establish that your real Supabase Google provider, Google review or ChatBeds registration works. Run the real consent and webhook tests before listing.

## 10. Submit for listing

Publish your real homepage/privacy policy, verify branding/domain and complete Google's applicable Calendar scope review. In ChatBeds Developers → Listing, set name, **Operations** category, support email, install/privacy addresses, honest description and tagline **Keep ChatBeds reservations synchronized with Google Calendar**. Describe one-way sync, guest data copied to Calendar, chosen-account primary-calendar default, initial import and disconnect behavior.

After live Sandbox checks pass, choose Get listed → Submit for review. Respond to reviewer feedback. Only advertise directory availability after ChatBeds marks it **Listed**. Other hotels' plan eligibility and Google Workspace policies may still restrict installation.

Hotels need no API key, Google Cloud project, Supabase account or Vercel account. They choose their Google account, allow Calendar access and authorize the ChatBeds property they manage.

## Security and operations

Google sign-in uses one-use state, PKCE S256, verified issuer/audience/expiry/email and hashed OIDC nonce. Supabase separately verifies the Google ID token. Only then is a user-bound app session issued. Google credentials are staged encrypted for fifteen minutes, bound to that user and consumed once. ChatBeds consent is bound to the same session and staged grant. A single database transaction enforces property membership and saves both provider credentials; failed ownership/permission/expiry checks roll back credential changes.

Global Google-grant and per-property leases serialize credential changes with synchronization/revocation. Old Google refresh tokens are preserved only from the same Google account in properties owned by the verified user. API calls and token refresh remain server-side. Sign-in starts are throttled to 30 per IP per ten minutes; provider limits also apply.

Expired staged grants are deleted on the next successful cron cleanup. Completed jobs and activity logs become eligible after DATA_RETENTION_DAYS; unfinished work, mappings and delivery IDs remain for recovery/idempotency. Monitor queued jobs, database size, missed recovery, provider quotas and support requests.

Account deletion and ownership transfer remain support-assisted. Verify requester identity/ownership, revoke access with the providers and stop processing, then remove only the verified property's credentials/jobs/deliveries/logs/mappings/memberships/settings in a transaction when no lease is active. Delete a Supabase Auth user only when no other memberships remain. Calendar events stay in the user's account unless removed there. Never revoke a shared Google grant without explaining its effect.

Multiple properties are supported. Billing, a calendar picker, self-service team invitations and automatic account deletion are not included. Staff access can be provisioned through operator-verified membership records; do not share authentication sessions.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Old email-code UI | Deploy updated source; ensure APP_ACCESS_MODE=public and CHATBEDS_AUTH_MODE=oauth. |
| Google sign-in failed | Enable Supabase Google provider with the same Google client ID; keep nonce checks enabled; inspect sanitized app/provider configuration. |
| Redirect mismatch | Register exact app `/api/google/callback`; do not substitute Supabase's callback URL. |
| Calendar permission missing | Continue again and explicitly approve Calendar event access. |
| Offline access missing | Retry consent; if persistent, remove the app grant in Google permissions and reconnect, understanding other properties may be affected. |
| Setup expired | Start Continue with Google again, then finish ChatBeds consent promptly. |
| Existing property unavailable | Use the original verified account or operator-assisted membership migration. |
| Unknown database function/table | Apply fourth migration once after third, without rerunning older files. |
| Invalid state | Start from the app, same browser, finish within ten minutes; never use console `state=test`. |
| Other hotels cannot connect | Await ChatBeds listing; check owner/admin permission and Partner API plan eligibility. |
| Action must come from configured address | Browse exact NEXT_PUBLIC_APP_URL and register matching callback origins. |
| Connection needs attention | Operator checks environment, webhook signing secret and real legal/business identity. |
