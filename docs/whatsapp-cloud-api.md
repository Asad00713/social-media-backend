# WhatsApp Cloud API — Inbox Integration (Phase 1)

Two-way WhatsApp messaging in the inbox via Meta's **WhatsApp Cloud API**. A
workspace connects its WhatsApp Business number; inbound customer messages
(including those started from **Click-to-WhatsApp ads**) land in the inbox as
DM conversations, and the team replies inside WhatsApp's 24-hour window.

## Architecture (Phase 1)

- **Platform:** `whatsapp` channel. `platformAccountId` = the WhatsApp
  **`phone_number_id`**. `metadata` holds `{ wabaId, displayPhoneNumber }`.
- **Inbound is push-only.** The Cloud API exposes **no read API** for past
  messages — history arrives only via webhooks. Flow:
  `POST /webhooks/whatsapp` → signature-verified → enqueued to the
  `whatsapp-ingest` BullMQ queue → `WhatsAppIngestService` → `InboxService.upsertDm`
  → realtime to the inbox UI.
- **Reply** goes through the generic DM path: `WhatsAppDmAdapter.sendDm` →
  `POST /{phone_number_id}/messages`. Blocked outside the 24h window
  (`getReplyWindowState`).
- **Click-to-WhatsApp** messages arrive on the same `messages` webhook with a
  `referral` block, stored in `inbox_items.metadata.referral`.

## Environment

| Var | Purpose |
|-----|---------|
| `META_WEBHOOK_VERIFY_TOKEN` | GET webhook verification challenge (shared with FB/IG/Threads). |
| `META_APP_SECRET` | **Required.** Verifies `X-Hub-Signature-256` on POST webhooks. Without it every WhatsApp webhook POST is rejected (fail-closed). |

## Meta setup

1. **Meta app** with the **WhatsApp** product added; a **WhatsApp Business
   Account (WABA)** and a registered **phone number** (note its
   `phone_number_id` and `waba_id`).
2. **Webhook**: set the callback URL to `https://<API_PUBLIC_URL>/webhooks/whatsapp`,
   the verify token to `META_WEBHOOK_VERIFY_TOKEN`, and **subscribe to the
   `messages` field** on the WABA.
3. **Connect in Schedura** (Phase-1 manual onboarding):
   `POST /channels/workspaces/:workspaceId/whatsapp/connect`
   ```json
   { "phoneNumberId": "<digits>", "wabaId": "<digits>", "accessToken": "<system-user or long-lived token>" }
   ```
   The endpoint validates the token against the Graph API before creating the channel.

## 🚩 Go-live dependency (App Review)

Production messaging to arbitrary customers requires **Meta Business
Verification** + **Advanced Access** for `whatsapp_business_messaging` /
`whatsapp_business_management` (**Meta App Review**) — the same review gate as
the Boost/Ads features. Until approved, test with a Meta **test number** +
system-user token. Multi-tenant self-serve onboarding (**Embedded Signup**) and
business-initiated **message templates** / notifications are **Phase 2**.

## Out of scope (Phase 2)

Message templates & business-initiated sends (and replying after 24h),
WhatsApp notifications, Embedded Signup + token refresh, media messages, and
linking the ad `referral` to the ads module's campaign rows.
