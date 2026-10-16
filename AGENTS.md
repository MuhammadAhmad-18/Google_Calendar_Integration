# AGENTS.md — ChatBeds × Google Calendar Integration

## 1. Project goal
Build a working **ChatBeds Sandbox → Google Calendar** integration.

The first milestone is intentionally **sandbox-only**. Do NOT require ChatBeds App Store registration, ChatBeds OAuth client credentials, or production hotel access to complete Phase 1.

Phase 1 must use the ChatBeds Sandbox Hotel's private Partner API key (`cbk_...`) and synchronize ChatBeds reservations into a Google Calendar.

Later, Phase 2 will replace the fixed ChatBeds sandbox key with the official ChatBeds App OAuth flow (`cba_...` client ID, `cbs_...` client secret, `cbat_...` access token, `cbrt_...` refresh token) while preserving the same calendar-sync business logic.

The finished Phase 1 should demonstrate this flow:

```text
ChatBeds Sandbox Hotel
        |
        | Partner API key (cbk_...)
        v
Our integration backend
        |
        | Google OAuth / Calendar API
        v
Google Calendar
```

Behavior:
- A ChatBeds reservation is created -> create a Google Calendar event.
- A ChatBeds reservation is modified -> update the matching Google Calendar event.
- A ChatBeds reservation is cancelled or becomes `no_show` -> remove the matching calendar event (or mark it cancelled if deletion fails; document the behavior).
- A manual initial sync can import existing sandbox reservations for a chosen date range.

## 2. Mandatory source-of-truth rule
Before implementing or changing ChatBeds API behavior, read the official ChatBeds developer documentation at:

- https://dev.chatbeds.app/
- https://dev.chatbeds.app/docs/getting-started/quickstart
- https://dev.chatbeds.app/docs/api
- https://dev.chatbeds.app/docs/api/reservations
- https://dev.chatbeds.app/docs/webhooks
- https://dev.chatbeds.app/docs/webhooks/verify-signatures

Do **not invent ChatBeds endpoints, fields, event names, query parameters, scopes, token formats, or webhook behavior**.

If the repository's assumptions disagree with the live ChatBeds docs, follow the live docs and note the correction in `README.md`.

For Google Calendar behavior, use Google's official documentation as the source of truth. Do not invent Google OAuth or Calendar API behavior.

## 3. Current ChatBeds facts to preserve
Use these facts unless the official docs have changed:

- Partner API v1 is used for both private keys and app access tokens.
- Sandbox/private Partner API key format: `cbk_...`.
- Every ChatBeds credential acts for one property only.
- `GET /me` identifies the property associated with the key.
- Reservations can be read with the Partner API.
- Reservation webhook event names are:
  - `reservation.created`
  - `reservation.modified`
  - `reservation.cancelled`
- A `no_show` arrives as `reservation.cancelled` with reservation status `no_show`.
- Private-key webhook configuration is done on the Partner API key in ChatBeds Settings.
- The webhook address must be public HTTPS.
- ChatBeds webhook signing secret format: `whsec_...`.
- Verify `ChatBeds-Signature` against the **raw request body** using HMAC-SHA256.
- Signed text is `timestamp + "." + raw_body`.
- Reject webhook timestamps more than 5 minutes away from the server clock.
- Use constant-time signature comparison.
- `ChatBeds-Delivery` is the stable delivery ID; store it and ignore duplicate deliveries.
- Webhooks should return a 2xx response within 10 seconds.
- Reservation search does not provide a generic unfiltered "list everything" call. Follow the current docs when implementing initial sync; do not fake pagination or date-range query parameters that do not exist.

## 4. Phase 1 scope — build this now
Build a clean full-stack TypeScript application with:

- Next.js App Router
- TypeScript with strict mode
- Server-side API routes / route handlers
- Google Calendar API integration
- Google OAuth 2.0 web-server flow
- A small persistence layer for Google tokens, reservation-event mappings, webhook deduplication, and sync logs
- Simple, professional UI; functionality matters more than visual polish

Prefer the current stable package versions compatible with the environment. Do not pin obsolete versions just because an old tutorial uses them.

### Phase 1 authentication
ChatBeds:
- Use `CHATBEDS_API_BASE_URL` from environment variables.
- Use `CHATBEDS_API_KEY=cbk_...` from environment variables.
- Never expose this key to the browser.
- On startup/connection check, call `/me` and obtain the sandbox property's ID and name.
- Do not ask for ChatBeds client ID/client secret in Phase 1.

Google:
- Use Google OAuth 2.0.
- Ask only for permissions needed to create/update/delete calendar events.
- Prefer the user's primary calendar for the first version.
- Request offline access so a refresh token can be stored when Google provides one.
- Store Google refresh/access tokens only server-side.

### Phase 1 UI
Create a small dashboard with these states:

1. **ChatBeds Sandbox**
   - status: Connected / Error
   - property name and property ID from `/me`
   - button: `Test ChatBeds connection`

2. **Google Calendar**
   - status: Connected / Not connected
   - button: `Connect Google Calendar`
   - button: `Disconnect Google Calendar`
   - show the calendar being used (default `primary` is fine for v1)

3. **Manual sync**
   - date-from input
   - date-to input
   - button: `Sync reservations`
   - show created / updated / skipped / deleted / failed counts

4. **Recent activity**
   - webhook/event type
   - ChatBeds reservation reference
   - action performed in Google Calendar
   - timestamp
   - success/failure
   - concise error message when applicable

Do not display secrets or tokens anywhere in the UI.

## 5. Environment variables
Create `.env.example` with placeholders only. Never write real secrets into committed files.

Use names similar to:

```env
# ChatBeds sandbox
CHATBEDS_API_BASE_URL=https://YOUR_CHATBEDS_PARTNER_API_BASE/partner/v1
CHATBEDS_API_KEY=cbk_REPLACE_ME
CHATBEDS_WEBHOOK_SECRET=whsec_REPLACE_ME

# Google OAuth
GOOGLE_CLIENT_ID=REPLACE_ME
GOOGLE_CLIENT_SECRET=REPLACE_ME
GOOGLE_REDIRECT_URI=http://localhost:3000/api/google/callback
GOOGLE_CALENDAR_ID=primary

# App
APP_URL=http://localhost:3000
DATABASE_URL=REPLACE_ME
TOKEN_ENCRYPTION_KEY=REPLACE_WITH_A_STRONG_RANDOM_KEY
```

Do not use the user's real key in source code, tests, examples, logs, screenshots, fixtures, or README content.

## 6. Persistence/data model
Use a simple relational persistence layer. PostgreSQL is preferred so the same schema can be deployed later. Prisma is acceptable unless the existing repository already uses another ORM.

At minimum model:

### `IntegrationSettings`
For the current developer/sandbox installation only in Phase 1.
- id
- chatbedsPropertyId
- chatbedsPropertyName
- googleCalendarId
- encryptedGoogleAccessToken
- encryptedGoogleRefreshToken
- googleTokenExpiry
- createdAt
- updatedAt

### `ReservationCalendarMap`
- id
- chatbedsReservationId (unique)
- chatbedsReservationRef
- propertyId
- googleEventId
- arrival
- departure
- reservationStatus
- lastSyncedAt
- createdAt
- updatedAt

This table is essential. It tells us which Google event corresponds to a ChatBeds reservation.

### `WebhookDelivery`
- deliveryId (unique)
- eventType
- propertyId
- reservationId
- receivedAt
- processedAt nullable
- status (`received`, `processed`, `failed`, `duplicate`)
- error nullable

### `SyncLog`
- id
- source (`webhook`, `manual`)
- action (`create`, `update`, `delete`, `skip`)
- reservationId
- reservationRef nullable
- googleEventId nullable
- success boolean
- message
- createdAt

Encrypt Google tokens at rest using a server-only encryption key. Never expose decrypted tokens through a page/API response.

## 7. Code architecture
Keep external-service code out of UI components.

Suggested structure:

```text
src/
  app/
    page.tsx
    api/
      health/route.ts
      chatbeds/
        test/route.ts
        sync/route.ts
        webhook/route.ts
      google/
        connect/route.ts
        callback/route.ts
        disconnect/route.ts
  lib/
    chatbeds/
      client.ts
      types.ts
      reservations.ts
      webhook.ts
    google/
      oauth.ts
      calendar.ts
      event-builder.ts
    sync/
      sync-reservation.ts
      initial-sync.ts
    db/
      prisma.ts
    crypto/
      tokens.ts
  components/
  types/
prisma/
  schema.prisma
```

Names can differ if there is a better fit, but keep the same separation of responsibilities.

## 8. ChatBeds API client requirements
Create one server-only ChatBeds client module.

It must:
- Read base URL and key from env.
- Send `Authorization: Bearer <key>`.
- Never log the full key.
- Use typed response objects based on official docs.
- Throw useful typed errors for non-2xx responses.
- Include timeouts.
- Avoid retrying unsafe operations automatically.

Phase 1 primarily needs:
- `/me`
- reservation reads/search required for manual sync
- webhooks for real-time create/modify/cancel handling

Do not implement reservation writes unless they are specifically needed for a test helper. The Calendar integration is one-way: ChatBeds -> Google Calendar.

## 9. Google OAuth requirements
Implement server-side Google OAuth.

Flow:

```text
User clicks Connect Google Calendar
        -> server creates Google authorization URL
        -> Google consent screen
        -> Google redirects to /api/google/callback
        -> server exchanges code for tokens
        -> encrypted tokens are persisted
        -> dashboard shows Connected
```

Security:
- Use `state` and validate it on callback.
- Keep client secret server-side.
- Never put refresh/access tokens into query strings or browser localStorage.
- If Google does not return a new refresh token during a later authorization, preserve the existing refresh token rather than replacing it with null.
- Implement automatic access-token refresh through the Google client library.

## 10. Calendar event design
For each active reservation, create an all-day Google Calendar event.

Google all-day event rules must be followed: use date values rather than date-time values; departure should remain the exclusive end date if required by Google's Calendar API.

Suggested title:

```text
<Guest First Name> <Guest Last Name> — <Room Type or Unit>
```

Suggested description:

```text
ChatBeds reservation: <ref>
Status: <status>
Stay: <arrival> to <departure>
Guests: <adults> adult(s), <children> child(ren)
Room type: <room type>
Room: <unit name when assigned>
Source: <source>
```

Keep the default event description privacy-conscious:
- Do NOT include guest phone number by default.
- Do NOT include guest email by default.
- Do NOT include payment information by default.

Use Google Calendar extended properties if useful to store `chatbedsReservationId` and `propertyId`, but keep the local mapping table as the primary mapping.

## 11. Reservation synchronization rules
Implement one central function similar to:

```ts
syncReservation(reservation, source)
```

All manual sync and webhook handling must reuse this function.

### Active reservations
For `confirmed`, `checked_in`, and `checked_out`:
- If mapping does not exist -> create Google event and save mapping.
- If mapping exists -> update existing Google event and mapping.
- If the Google event no longer exists -> recreate it and update mapping.

### Cancelled / no-show
For `cancelled` or `no_show`:
- If mapping exists -> delete the Google event, then remove or mark mapping inactive.
- If mapping does not exist -> no-op and log `skip`.

### Idempotency
The same reservation state may be delivered more than once.
- Never create duplicate calendar events for the same ChatBeds reservation ID.
- Use the mapping table and webhook delivery ID.
- Make create/update/delete behavior safe to repeat.

## 12. ChatBeds webhook implementation
Endpoint:

```text
POST /api/chatbeds/webhook
```

Important:
- Read the body as raw text/bytes before parsing JSON.
- Verify `ChatBeds-Signature` using the official algorithm and `CHATBEDS_WEBHOOK_SECRET`.
- Check signature timestamp tolerance.
- Use constant-time comparison.
- Read `ChatBeds-Delivery` and de-duplicate it.
- Validate event shape before processing.
- Handle only supported event types.
- Ignore unknown future event types safely and return 2xx after logging.

Supported events:
- `reservation.created` -> sync/create
- `reservation.modified` -> sync/update
- `reservation.cancelled` -> delete or no-op based on mapping

Keep processing under ChatBeds' webhook timeout. For Phase 1, direct processing is acceptable if it reliably responds within the documented limit; structure the code so a queue can be introduced in Phase 2 without rewriting synchronization logic.

When Google is temporarily unavailable, return an appropriate failure so ChatBeds can retry, but ensure retries cannot create duplicates.

## 13. Configuring sandbox webhooks
Document this in `README.md`:

1. Run the integration locally.
2. Expose it through a public HTTPS development tunnel such as Cloudflare Tunnel or ngrok.
3. Set the public URL ending in `/api/chatbeds/webhook` on the Sandbox Hotel's private Partner API key in **Settings -> Partner API**.
4. Copy the newly generated `whsec_...` secret into `CHATBEDS_WEBHOOK_SECRET`.
5. Restart the app after changing env variables.
6. Trigger a reservation creation/change/cancellation in the Sandbox Hotel and verify the Calendar event changes.

Do not automate changes to ChatBeds settings unless an official API explicitly supports it.

## 14. Manual initial sync
Provide a date-range manual sync in the dashboard.

Important: follow the official reservation search semantics. If the current ChatBeds API only allows exact arrival/departure dates and no date ranges/pages, implement the requested range by iterating individual dates and querying valid documented parameters.

Requirements:
- Validate from/to dates.
- Put a reasonable maximum range on one request (for example 90 days) to avoid accidental API abuse.
- De-duplicate reservations by reservation ID.
- Upsert active reservations to Calendar.
- If cancelled/no-show reservations are returned, ensure their events are absent.
- Do not assume the search endpoint can list all bookings without a filter.
- Show sync totals in UI.

## 15. Error handling
UI errors should be understandable, for example:
- `ChatBeds key is invalid or expired.`
- `Google Calendar is not connected.`
- `Google authorization was cancelled.`
- `Webhook signature is invalid.`
- `The mapped Google event no longer exists; it was recreated.`

Server logs may contain reservation IDs and references but must never contain:
- ChatBeds API key
- webhook secret
- Google client secret
- Google access token
- Google refresh token
- token encryption key

## 16. Tests
Add meaningful tests for business-critical behavior.

At minimum:
- ChatBeds webhook signature verification using official ChatBeds test values if they remain documented.
- Reject old webhook timestamps.
- Deduplicate repeated `ChatBeds-Delivery` IDs.
- Event builder creates correct Google all-day start/end dates.
- `reservation.created` creates one event.
- repeated create does not create a duplicate.
- `reservation.modified` updates the existing mapped event.
- `reservation.cancelled` deletes the mapped event.
- `no_show` removes the event.
- missing Google event causes recreation on an active reservation.
- Google OAuth callback rejects invalid state.

Mock external HTTP calls in tests. Never call the real ChatBeds or Google API during unit tests.

## 17. README deliverable
Create a beginner-friendly `README.md` that contains:

### What this project does
Explain the integration in simple words.

### Architecture
Show:

```text
ChatBeds Sandbox -> webhook/API -> Integration -> Google Calendar API
```

### Prerequisites
- Node.js
- ChatBeds developer account and Sandbox Hotel
- Sandbox `cbk_...` key
- Google Cloud project
- Google Calendar API enabled
- Google OAuth Web Client credentials
- database
- public HTTPS tunnel for webhook testing

### ChatBeds sandbox setup
Explain where to get the key and how to test `/me`.

### Google setup
Explain how to:
- create/choose a Google Cloud project
- enable Google Calendar API
- configure OAuth consent
- create a Web Application OAuth client
- add `http://localhost:3000/api/google/callback` during local development

### Webhook setup
Explain public tunnel + Settings -> Partner API + webhook URL + `whsec_...`.

### Environment setup
Explain copying `.env.example` to `.env.local`.

### Database setup
Provide exact commands.

### Run locally
Provide exact commands.

### End-to-end sandbox test
1. Test ChatBeds connection.
2. Connect Google.
3. Create a reservation in Sandbox Hotel.
4. Confirm Calendar event appears.
5. Change reservation dates/guest/unit.
6. Confirm Calendar event updates.
7. Cancel reservation.
8. Confirm Calendar event is removed.

### Troubleshooting
Cover common OAuth, webhook, tunnel, signature, and Google refresh-token issues.

## 18. Phase 2 — prepare for later, do not make it required now
Design Phase 1 so ChatBeds authentication is behind an abstraction instead of spreading `CHATBEDS_API_KEY` throughout the code.

For example:

```ts
interface ChatBedsCredentialProvider {
  getAccessCredential(propertyId?: string): Promise<string>;
}
```

Phase 1 implementation:

```text
SandboxApiKeyCredentialProvider -> cbk_...
```

Later Phase 2 implementation:

```text
OAuthCredentialProvider -> cbat_... with cbrt_... refresh
```

Do NOT implement a fake OAuth flow now.

Add a `PHASE_2_APP_OAUTH.md` document describing the migration steps:

1. Register the app under ChatBeds Developers -> New app.
2. Receive ChatBeds `cba_...` client ID and `cbs_...` client secret.
3. Register install/callback addresses.
4. Request only required scope(s), especially `reservations:read` for this integration.
5. Implement ChatBeds authorization-code + PKCE flow.
6. Store `property_id`, `installation_id`, `cbat_...`, rotating `cbrt_...`, scope, and expiry per installation.
7. Refresh access tokens safely; a ChatBeds refresh token is single-use/rotating, so prevent concurrent refreshes for the same installation.
8. Replace fixed sandbox credential provider with per-installation OAuth credential provider.
9. Configure the app webhook in Developers -> app -> Webhook.
10. Connect the unlisted app to the developer's own Sandbox Hotel and test the complete one-click Connect flow.
11. Test disconnect/reconnect behavior.
12. Only after successful testing, prepare the app for ChatBeds review/listing.

The future multi-property schema should be anticipated, but Phase 1 can remain single-property.

## 19. Security requirements
- Never commit `.env`, `.env.local`, OAuth secrets, API keys, tokens, or webhook secrets.
- Add secret files to `.gitignore`.
- Keep all external credentials server-side.
- Encrypt persisted Google tokens.
- Validate OAuth state.
- Verify webhook signatures before parsing/trusting event contents.
- Do not use guest PII unless required for the Calendar event.
- Do not expose stack traces or secrets to browser responses.
- Sanitize logs.
- Use HTTPS for deployed callback and webhook addresses.

## 20. Definition of done for Phase 1
The task is complete only when all of these are true:

- App starts locally without TypeScript/lint errors.
- `/me` successfully validates a developer-provided sandbox key.
- Google Calendar OAuth connection works.
- A developer can configure the sandbox Partner API key's webhook URL and signing secret.
- A new ChatBeds sandbox reservation creates exactly one Google Calendar event.
- Modifying that reservation updates the same event rather than creating another.
- Cancelling/no-show removes the mapped event.
- Webhook signature verification is implemented and tested.
- Duplicate webhook deliveries are ignored safely.
- Manual date-range sync works using only documented ChatBeds reservation-search behavior.
- No secrets are committed or displayed.
- `README.md`, `.env.example`, database schema/migrations, and tests are included.
- `PHASE_2_APP_OAUTH.md` clearly explains how to later convert this sandbox/private-key prototype into a real ChatBeds App Directory application.

## 21. Working style for Codex
- Inspect the existing repository before adding dependencies or changing structure.
- If the repo is empty, scaffold the smallest clean Next.js TypeScript project that satisfies this spec.
- Prefer simple, maintainable code over unnecessary abstractions, except for the ChatBeds credential provider which must be swappable for OAuth later.
- Do not stop at pseudocode. Implement working code, migrations, tests, and documentation.
- Run install/build/lint/tests and fix failures before declaring completion.
- Do not silently skip a requirement. If a requirement cannot be completed because an external credential is missing, implement everything around it, leave a clear setup step, and provide an exact verification procedure.
- Do not fabricate successful API responses. Use mocks only in tests and mark them clearly.
- Never ask the user to paste secrets into source files. Tell them to put secrets into `.env.local`.
