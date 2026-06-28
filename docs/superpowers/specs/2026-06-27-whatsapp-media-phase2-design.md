# WhatsApp Phase-2 — Media Messages — Design

**Date:** 2026-06-27
**Status:** Approved (brainstorming) → ready for implementation plan
**Scope:** Inbound + outbound media (image / voice / audio / video / document) for the WhatsApp inbox, plus a small connect-flow gap fix (auto-subscribe the WABA to the app).

---

## Goal

Let WhatsApp customers send media (images, voice notes, audio, video, documents) into the unified inbox, and let the team reply with **image + voice** — reusing the inbox media infrastructure that already exists for Slack / Telegram / Facebook. Also close the Phase-1 gap where connecting a number does not auto-subscribe the WABA to the app.

## Non-Goals (out of scope for this phase)

- Outbound **video / document** sending (composer stays image + voice). Inbound video/document are still received and rendered.
- Message **templates** / business-initiated sends (separate Phase-2 item).
- Sending **stickers / location / contacts** outbound.
- Upload-then-send for outbound media (we send by public link; upload-media is a documented fallback only).

---

## Architecture

No new inbox infrastructure. WhatsApp adds platform-specific glue on top of the existing, proven pipeline:

- **Storage:** `CloudflareR2Service.uploadBuffer()` (server-side rehost) and the public-URL convention — already used by the Slack ingest.
- **Persistence:** `InboxService.upsertDm({ attachments })` stores `metadata.attachments = [{ kind, url, contentType, thumbnailUrl? }]`.
- **Outbound contract:** `PlatformDmAdapter.sendDmWithAttachments?()` (optional method; WhatsApp implements it).
- **Frontend:** `dm-message-bubble`'s `AttachmentRender` already renders image / video / voice / audio / file; `VoicePlayer`, the composer attachment tray, the upload hook, and list-preview icons are all generic.

The Slack ingest (`slack-ingest.processor.ts`) is the reference model for inbound: download from the platform → classify by MIME → `uploadBuffer` to R2 → `upsertDm` with attachments.

---

## Inbound flow

```
POST /webhooks/whatsapp
  → parseWhatsAppMessages()           // now also captures media descriptors
  → WhatsAppIngestService.ingest():
      for each message:
        - text                → upsertDm({ text })                       (unchanged)
        - media (img/aud/vid/doc/sticker):
            WhatsAppService.downloadMedia(mediaId, token)  // 2-step
            → R2.uploadBuffer({ kind, workspaceId, buffer, contentType, filename })
            → upsertDm({ text: caption ?? '', attachments: [{ kind, url, contentType }] })
        - location / contacts / unknown → upsertDm({ text: '📍 Location' | '👤 Contact' })  (no attachment)
```

### `downloadMedia(mediaId, accessToken)` — 2-step (Cloud API)

1. `GET https://graph.facebook.com/v21.0/{mediaId}` with `Authorization: Bearer <token>` → JSON `{ url, mime_type, file_size, sha256 }`.
2. `GET <url>` with `Authorization: Bearer <token>` → binary body. (WhatsApp media URLs require the bearer token; they are not public.)

Returns `{ buffer, contentType, fileSize }`.

### Type mapping (WhatsApp message type → `DmAttachmentKind` + R2 kind)

| WhatsApp type | condition | DmAttachmentKind | R2 kind | caption? |
|---|---|---|---|---|
| `image` | — | `image` | `image` | yes |
| `video` | — | `video` | `video` | yes |
| `audio` | `audio.voice === true` | `voice` | `voice` | no |
| `audio` | otherwise | `audio` | `voice` | no |
| `document` | — | `file` | `file` | yes |
| `sticker` | — | `image` | `image` | no |
| `location` / `contacts` / unknown | — | _(none)_ | — | stored as a short text note, no attachment |

Caption: for `image` / `video` / `document`, `msg.<type>.caption` becomes the inbox-item `text`. For audio/voice/sticker there is no caption.

### Parser extension (`whatsapp-webhook.util.ts`)

`ParsedWhatsAppMessage` gains an optional media descriptor instead of the boolean-only `isText`:

```ts
interface ParsedWhatsAppMedia {
  mediaId: string;
  kind: 'image' | 'video' | 'audio' | 'voice' | 'file';
  mimeType?: string;
  caption?: string;
  filename?: string;   // documents
}
// ParsedWhatsAppMessage:
//   text: string
//   media?: ParsedWhatsAppMedia
//   note?: string      // location/contacts placeholder text
//   (keep isText for back-compat or derive)
```

The parser reads `msg.image | msg.video | msg.audio | msg.document | msg.sticker` (each has `id`, `mime_type`; image/video/document have `caption`; audio has `voice: boolean`; document has `filename`) and `msg.location | msg.contacts` → `note`.

---

## Outbound flow (image + voice)

```
composer (image/voice staged)  → R2 upload (existing)
  → POST /inbox/.../dms/:threadKey/messages { text, attachments:[{kind,url,contentType}] }
  → InboxService.sendDm() (existing: 24h window check, then dispatch)
  → WhatsAppDmAdapter.sendDmWithAttachments(channel, conversationId, text, attachments)
      for each attachment:
        WhatsAppService.sendMedia(token, phoneNumberId, toWaId, { kind, link, caption? })
        → POST /{phone_number_id}/messages
             { messaging_product:'whatsapp', to, type, <type>: { link, caption? } }
  → upsertDm({ fromMe:true, attachments }) (existing)
```

- **Send by link:** the R2 public URL is passed as `link` in the media object — WhatsApp fetches it. No download/re-upload (unlike Telegram/Slack). Mirrors the Facebook adapter's URL-passing pattern.
- **Caption rules:** `image` supports `caption` → attach the reply text to the (first/only) image. `audio`/`voice` have **no** caption → if there is text alongside a voice note, send the text as a separate `sendText` message (match the FB adapter's "first attachment carries caption, rest separate" shape).
- The adapter should map all `DmAttachmentKind`s (so future video/document outbound is a small extension), but the composer only stages image + voice this phase.
- 24h reply-window enforcement is already applied generically in `InboxService.sendDm` via `getReplyWindowState`.

### `sendMedia(token, phoneNumberId, toWaId, { kind, link, caption? })`

Builds the Cloud API payload per type:
- `image` → `{ type:'image', image:{ link, caption? } }`
- `audio` / `voice` → `{ type:'audio', audio:{ link } }` (no caption)
- `video` → `{ type:'video', video:{ link, caption? } }`
- `file` → `{ type:'document', document:{ link, caption?, filename? } }`

Returns `{ messageId }`.

---

## Connect gap fix (bundled)

`WhatsAppService.subscribeWaba(accessToken, wabaId)` → `POST https://graph.facebook.com/v21.0/{wabaId}/subscribed_apps` (Bearer). Called from `ChannelsController.connectWhatsApp` **after** `createChannel`, **best-effort** (catch + log; never block the connect response) — same shape as `facebookService.subscribePageToWebhooks`. This makes inbound delivery work on first connect without the manual `subscribed_apps` step.

---

## Error handling

- **downloadMedia / R2 upload failure:** catch per-message; persist the message with its caption/text plus a `[media unavailable]` note (no attachment). Never drop the whole webhook batch.
- **Inbound document > R2 `file` limit (25 MB):** `uploadBuffer` throws → caught → store a text note (`📎 <filename> (too large to preview)`); message still appears.
- **sendMedia failure:** throw (surfaced to the user as a toast), consistent with other adapters.
- **24h window closed:** existing `sendDm` path returns the window `reason` (403) before dispatch.
- **subscribeWaba failure:** logged, non-blocking.

---

## Components / files

**Backend**
- `src/channels/services/whatsapp.service.ts` — add `downloadMedia`, `sendMedia`, `subscribeWaba`.
- `src/channels/services/whatsapp-webhook.util.ts` — parser captures media descriptors + location/contacts notes.
- `src/inbox/services/whatsapp-ingest.service.ts` — inject `WhatsAppService` + `CloudflareR2Service`; download → rehost → `upsertDm` with attachments; map types; handle notes + graceful fallback. (Needs channel access token — resolve via channel service like other ingest paths.)
- `src/inbox/adapters/whatsapp-dm.adapter.ts` — implement `sendDmWithAttachments`.
- `src/channels/channels.controller.ts` — `connectWhatsApp` calls `subscribeWaba` (best-effort).
- Module DI: ensure `CloudflareR2Service` (and token resolution) are available to the ingest service / its module.

**Frontend**
- `src/features/inbox/components/dm-thread.tsx` — remove `whatsapp` from the `platformSupportsAttachments` exclusion (enables image + voice composer). Inbound rendering, voice player, and list-preview icons already work.

---

## Testing (TDD)

**Unit**
- Parser: each media type (image/video/audio/voice/document/sticker) → correct kind + mediaId + mimeType + caption + filename; `audio.voice` → `voice`; location/contacts → `note`; text unchanged.
- `WhatsAppService.sendMedia`: correct payload per type (caption only where allowed).
- `WhatsAppService.downloadMedia`: 2-step fetch (id→url→bytes), bearer on both.
- `WhatsAppDmAdapter.sendDmWithAttachments`: kind mapping; image caption attached; voice + text → separate text message.
- Ingest: media message → `downloadMedia` + `uploadBuffer` + `upsertDm({ attachments })` (mock R2 + service); download failure → text-note fallback; oversized document → note.

**Manual (Meta test number)**
- Send image / voice / video / document from a phone → each appears in the inbox correctly rendered; caption shows as text.
- Reply with an image (with caption) and a voice note → received on the phone.
- Fresh connect (new number) → inbound works without manual `subscribed_apps` (verifies the gap fix).

---

## Rollout notes

- All changes land on `feat/maestro-agent-sdk` (same branch as Phase-1). No DB migration (attachments live in existing `metadata` JSONB).
- WhatsApp App Review is **not** required for this phase (media inside the customer-initiated 24h window works with a test number, like Phase-1).
