# WhatsApp Embedded Signup — Design Spec

**Date:** 2026-07-09
**Branch:** `feat/whatsapp-embedded-signup` (both repos)
**Status:** Approved for planning

## Goal

Replace the manual-token WhatsApp connect with **Meta Embedded Signup v4**
(Facebook Login for Business) so that connecting a WhatsApp Business Account
happens through *our* app's Facebook consent dialog. This makes the
`whatsapp_business_messaging` + `whatsapp_business_management` permissions
**demo-able for Meta App Review** (the manual token-paste flow has no consent
screen to screencast → guaranteed rejection). Keep the manual flow available as
a hidden "Advanced" fallback until App Review grants Advanced Access.

## Architecture (one paragraph)

The browser loads the Facebook JS SDK on demand and calls `FB.login` with our
Facebook-Login-for-Business `config_id`. When the business finishes the dialog,
a `message` event of type `WA_EMBEDDED_SIGNUP` delivers `waba_id`,
`phone_number_id`, and `business_id`; the `FB.login` callback delivers a
short-lived (30s) `code`. The frontend immediately POSTs `{ code, wabaId,
phoneNumberId }` to a new backend endpoint, which performs three server-to-server
Graph calls (exchange code → register phone number → subscribe app to the WABA)
and then persists the channel through the existing `createChannel` path (which
already fires the analytics/backfill lifecycle hook).

## Tech Stack

- Backend: NestJS (`socialmedia-workspace`) — `whatsapp.service.ts`,
  `channels.controller.ts`, existing `createChannel` / channel schema.
- Frontend: Vite + React 19 + shadcn (`socialmedia-frontend`) — new connect
  component + restructured connect dialog. Facebook JS SDK loaded lazily.

## Global Constraints

- **Graph API version:** introduce a single `GRAPH_API_VERSION` constant
  (currently drifts v18 in `facebook.service.ts` / dead `OAUTH_CONFIGS.whatsapp`
  vs v21 in `whatsapp.service.ts`). Use **v21.0** as the pinned value.
- **Token at rest:** access token MUST be encrypted via the existing
  `encrypt()` util (`common/utils/encryption.util.ts`) exactly as `createChannel`
  already does. Never log the token or the exchange `code`.
- **shadcn-only** on the frontend (Collapsible, Button, Dialog, Form, etc. via
  the shadcn registry); theme tokens only.
- **No secrets client-side** beyond the public `META_APP_ID` and the
  `config_id` (both are safe to expose — they appear in the OAuth dialog URL).
- **Webhook signature** stays fail-closed (`META_APP_SECRET`); do not weaken it.

## Meta requirements (researched 2026-07-09, official docs)

- Embedded Signup **v2 deprecates 2026-10-15** → build **v4**.
- `FB.login(cb, { config_id, response_type: 'code', override_default_response_type: true, extras: { setup: {} } })`.
  `config_id` replaces `scope`; `response_type` must be `code`.
- Success `message` event `WA_EMBEDDED_SIGNUP` → `waba_id`, `phone_number_id`,
  `business_id` (+ optional asset ids). Abandonment → `current_step`. Error →
  `error_message`, `error_code`, `session_id`.
- Callback `code` is valid **~30 seconds** → exchange immediately server-side.
- **Prerequisite:** app must be a **Tech Provider** with a Facebook-Login-for-
  Business configuration (`config_id`). Business Verification is **already done**.
- **Dev-mode testable:** anyone added as **admin/developer/tester** on the app
  can complete the flow with their own Meta credentials — this is how we test +
  record the App Review screencast before Advanced Access is granted.
- Tech Provider model uses **business tokens** exclusively; onboarded customers
  must add their **own payment method** to their WABA before sending at scale.

### Server-to-server calls (Tech Provider)

1. **Exchange code → business token**
   `GET /v21.0/oauth/access_token?client_id={META_APP_ID}&client_secret={META_APP_SECRET}&code={code}`
   → returns the customer-scoped business access token.
2. **Register the phone number for Cloud API**
   `POST /v21.0/{phoneNumberId}/register`
   body `{ messaging_product: 'whatsapp', pin: '<6-digit>' }` (bearer business token).
   Treat "already registered" as success (idempotent).
3. **Subscribe our app to the customer's WABA webhooks**
   `POST /v21.0/{wabaId}/subscribed_apps` (bearer business token). Already exists
   as `whatsappService.subscribeWaba`; make it **blocking** in this flow.

Fallback discovery (if the `message` event omits ids): `GET /v21.0/{wabaId}/phone_numbers`
to resolve the phone number id from the WABA.

---

## Components

### Backend

**`whatsapp.service.ts` — new methods** (also move the Meta verify currently
inlined at `channels.controller.ts:5380` into the service):
- `exchangeCodeForBusinessToken(code): Promise<{ accessToken: string; expiresIn: number | null }>`
- `registerPhoneNumber(accessToken, phoneNumberId, pin): Promise<void>` —
  swallow the "already registered" error path.
- `getWabaPhoneNumbers(accessToken, wabaId): Promise<Array<{ id; displayPhoneNumber; verifiedName }>>` —
  fallback discovery + to read `verified_name` / `display_phone_number`.
- Reuse existing `subscribeWaba(accessToken, wabaId)` (make blocking here).
- Add a shared `GRAPH_API_VERSION` constant used by all methods.

**`channels.controller.ts` — new endpoint**
`POST /channels/workspaces/:workspaceId/whatsapp/embedded-signup`
body DTO `EmbeddedSignupWhatsAppDto { code: string; wabaId: numeric-string; phoneNumberId: numeric-string; pin?: 6-digit-string }`.
Steps: assert workspace access → `exchangeCodeForBusinessToken` → (ids missing?
`getWabaPhoneNumbers`) → read `verified_name`/`display_phone_number` →
`registerPhoneNumber` → `subscribeWaba` (blocking) → **cross-workspace guard**
→ `createChannel(... platform:'whatsapp', platformAccountId: phoneNumberId,
metadata:{ wabaId, businessId?, displayPhoneNumber, connectMethod:'embedded_signup' },
accessToken (encrypted by createChannel), tokenExpiresAt from expiresIn if present)`.
The existing manual `connectWhatsApp` endpoint stays.

**Cross-workspace security guard (required for self-serve):**
Before `createChannel`, reject with `409` + clear message if the same
`phone_number_id` is already connected in **any other workspace**. Also make
`inbox.service.ts:findChannelByPlatformAccount` deterministic (it currently does
an unscoped `findFirst` on `(platform, platformAccountId)`) — order the lookup
and log a warning if more than one row matches, so webhook routing never lands a
message in the wrong tenant.

**Env:** `META_APP_ID` (new — currently only `META_APP_SECRET` exists),
`META_APP_SECRET` (exists), pinned `GRAPH_API_VERSION`. Document in `.env.example`.

### Frontend

**`whatsapp-embedded-signup-button.tsx` (new)** — lazily injects the Facebook
JS SDK (`connect.facebook.net/en_US/sdk.js`) on first use, `FB.init({ appId:
VITE_META_APP_ID, version: 'v21.0' })`, calls `FB.login(...)` with
`VITE_WHATSAPP_ES_CONFIG_ID`. A `message` listener (verify `event.origin`
endsWith `facebook.com`) captures `WA_EMBEDDED_SIGNUP` ids; on the `FB.login`
callback `authResponse.code`, POSTs to the new endpoint via a
`use-whatsapp-embedded-signup.ts` hook. Handles loading / abandoned
(`current_step`) / error (`error_message`) states.

**`whatsapp-connect-dialog.tsx` (restructure)** — primary CTA becomes
"Connect with Facebook" (the ES button). The existing manual form
(phoneNumberId/wabaId/accessToken) moves behind a shadcn `Collapsible`:
"Advanced: use your own token". No behavior change to the manual path.

**`whatsapp.api.ts` / hook** — add `embeddedSignup(workspaceId, payload)` →
`POST /channels/workspaces/${workspaceId}/whatsapp/embedded-signup`.

**Env:** `VITE_META_APP_ID`, `VITE_WHATSAPP_ES_CONFIG_ID`.

## Data flow

1. User clicks "Connect with Facebook" → SDK loads → `FB.login` dialog.
2. Business selects/creates WABA + phone number, grants our app access.
3. `WA_EMBEDDED_SIGNUP` message → `{ waba_id, phone_number_id, business_id }`;
   callback → `code`.
4. Frontend POST `{ code, wabaId, phoneNumberId }` → backend.
5. Backend: exchange code → register phone (pin) → subscribe app to WABA →
   cross-workspace guard → `createChannel` (encrypts token, fires
   `onChannelConnected` backfill).
6. Response → frontend invalidates `queryKeys.channels.list(workspaceId)`; the
   new WhatsApp channel appears. Inbound messages already route via the existing
   webhook → `phone_number_id` → channel.

## Error handling

- `code` expired (>30s): 400 → "Took too long, please try again."
- User abandoned (`current_step`): friendly inline message, no error toast.
- `register` "already registered": treat as success (idempotent).
- 2FA PIN mismatch on `register`: 400 → "This number has two-step verification
  enabled; disable it in WhatsApp Manager and retry."
- Re-running ES for an already-connected number **in the same workspace**:
  a **healthy** duplicate (connected, active, token not expired) returns 409
  early — before any Meta call — consistent with every other platform's
  connect path. A **broken/expired** same-workspace channel falls through and
  is reconnected in place by `createChannel`'s existing reconnect branch.
- Same number in a **different** workspace: 409 with a clear tenancy message.
- `subscribeWaba` failure: **fail the connect** (blocking) with a retry-able
  error — a channel that never receives messages is worse than a visible error.

## Testing

- Unit: new `whatsapp.service` methods (mock `fetch`) — exchange/register/
  discovery, including the "already registered" branch.
- Unit: the ES controller endpoint (happy path + expired code + cross-workspace
  409 + subscribe failure).
- Unit: `findChannelByPlatformAccount` determinism + multi-row warning.
- Frontend: ES button states (loading/success/abandoned/error) with the SDK
  mocked; dialog renders primary CTA + collapsible manual form.
- Update existing specs: `whatsapp.service.spec.ts`,
  `whatsapp-webhook.util.spec.ts`, `whatsapp-dm.adapter.spec.ts`.
- Build both repos (`npm run build`).

## Out of scope (separate efforts)

- **Maestro batched-webhook `.some()` bug** (`webhooks.controller.ts:199`) — a
  real defect (a batch mixing the maestro number and a customer number diverts
  everything to the bridge), but independent of this flow. Its own small fix.
- Template-message sending (outside the 24h window) — already stubbed
  ("template required (coming soon)"); not part of connect.
- Removing the manual flow entirely — deferred until App Review grants Advanced
  Access.
- **Business-token refresh** — only needed if the chosen `config_id` issues
  60-day tokens (not a never-expiring one). If so, a follow-up adds a refresh
  path for whatsapp (today `supportsRefreshToken:false`, so tokens would silently
  expire at 60 days). Prefer a never-expiring config to avoid this entirely.

## Prerequisites / Meta console setup (user actions, documented alongside)

1. Register the app as a **Tech Provider** (WhatsApp → Tech Provider).
2. Create a **Facebook Login for Business** configuration → get `config_id`,
   requesting `whatsapp_business_messaging` + `whatsapp_business_management`.
   **Prefer a never-expiring token configuration** if the app offers one — it
   matches the current channel model (`supportsRefreshToken:false`,
   `tokenExpiresAt:null`) and needs no refresh. If only the 60-day template is
   available, tokens expire in 60 days → the token-refresh follow-up below applies.
3. Add the WhatsApp product + configure the webhook (already wired) and the
   `account_update` webhook field.
4. Set env: backend `META_APP_ID`; frontend `VITE_META_APP_ID`,
   `VITE_WHATSAPP_ES_CONFIG_ID`.
5. Test in dev mode as an app admin/developer, then record the App Review
   screencast (login → consent showing the two whatsapp scopes → connected
   channel + a sent/received message).

## Decisions locked

- Approach: **Facebook JS SDK `FB.login`** (not server redirect) — Meta
  documents ES as the JS-SDK flow; reviewers expect it; the SDK `message` event
  is the only clean source of `waba_id`/`phone_number_id`.
- Manual connect: **kept, demoted to "Advanced"** collapsible.
- Business token: store as-is with `tokenExpiresAt` from `expires_in` when the
  config issues a 60-day token; the channel's `supportsRefreshToken` stays
  false, so a future refresh mechanism is a follow-up if 60-day tokens are used
  (a never-expiring config avoids it).
