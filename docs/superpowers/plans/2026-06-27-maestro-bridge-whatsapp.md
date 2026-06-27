# Maestro Bridge — WhatsApp (Plan C, chat only)

**Goal:** Talk to Maestro from WhatsApp, mirroring the Telegram bridge, using a **dedicated** central Maestro WhatsApp number. Chat round-trip + confirm/questions (as numbered replies, since WhatsApp Cloud API has no interactive-button send in this codebase) + `/switch`. **Notifications are NOT in scope** (deferred).

**Architecture:** The processor becomes channel-agnostic via a small `BridgeReplier` ({sendText, sendChoices}) + shared `runAndReply`/`renderResult`/`applyChoice`. Telegram keeps inline-keyboard buttons; WhatsApp renders choices as a numbered list and resolves the user's number/label reply. Inbound arrives at a dedicated `POST /webhooks/maestro/whatsapp` (Meta signature-verified), filtered to `MAESTRO_WHATSAPP_PHONE_NUMBER_ID`, enqueued to `MAESTRO_BRIDGE` with `{channel:'whatsapp', payload}`.

## Global Constraints
- Backend `socialmedia-workspace/`, `npm run build` green per task; frontend build green for the UI task.
- One WhatsApp number = one Meta-app webhook → the Maestro number should be in its own Meta app pointing at `/webhooks/maestro/whatsapp` (or that app's webhook points here). Inbound is filtered by `phone_number_id` so foreign messages are ignored.
- Reuse: `BridgeLinkService` (channel `'whatsapp'`), `runHeadlessTurn`, `parseWhatsAppMessages`, `verifyMetaSignature`, `WhatsAppService.sendText`.
- Link token reused from Telegram (HMAC) — WhatsApp connect deep link prefills `connect <token>`.

### Task C1: channel-agnostic processor + WhatsApp inbound
- Refactor `maestro-bridge.processor.ts`: `BridgeReplier` interface; `telegramReplier(chatId)` (inline keyboard) + `whatsappReplier(waId)` (numbered text); shared `runAndReply(replier, link, message)`, `renderResult(link, replier, result)`, `applyChoice(replier, link, pending, index)`, `showWorkspaceSwitch(replier, link)`.
- `process(job)` branches on `job.data.channel`. Telegram path = existing behaviour. WhatsApp path: `parseWhatsAppMessages(payload)` → for each text msg with `phoneNumberId === MAESTRO_WHATSAPP_PHONE_NUMBER_ID`: `connect <token>` → upsert link; else resolve link → `/switch` / pending-choice (number or label) / new turn.
- WhatsApp choice resolve: numeric `1..N` or case-insensitive label match against `metadata.pending`.

### Task C2: webhooks
- Telegram enqueue → `{channel:'telegram', update}` (processor defaults to telegram if absent).
- Add `GET /webhooks/maestro/whatsapp` (verify token w/ `MAESTRO_WHATSAPP_VERIFY_TOKEN` ?? `META_WEBHOOK_VERIFY_TOKEN`) + `POST` (signature via `MAESTRO_WHATSAPP_APP_SECRET` ?? `META_APP_SECRET`, `x-hub-signature-256`, rawBody) → enqueue `{channel:'whatsapp', payload}`.

### Task C3: link endpoint + module wiring
- `BridgeService.whatsappDeepLink(userId, workspaceId)` → `https://wa.me/<MAESTRO_WHATSAPP_NUMBER>?text=connect <token>`.
- Controller `POST /maestro/bridge/whatsapp/link-token` → `{ deepLink }`.
- Provide `WhatsAppService` in `MaestroModule` (dependency-free).

### Task C4: frontend Connect WhatsApp
- `maestro-bridge.api.ts`: `createWhatsAppLinkToken(workspaceId)`.
- `use-maestro-bridge.ts`: `whatsappLink` + `connectWhatsApp`.
- `connect-maestro.tsx`: WhatsApp row (connect button + connected state), small "Premium" badge (cosmetic); update footnote to "email coming soon".

## Env (user sets)
`MAESTRO_WHATSAPP_PHONE_NUMBER_ID`, `MAESTRO_WHATSAPP_TOKEN` (permanent), `MAESTRO_WHATSAPP_NUMBER` (e164 digits for wa.me), `MAESTRO_WHATSAPP_APP_SECRET` (?? META_APP_SECRET), `MAESTRO_WHATSAPP_VERIFY_TOKEN` (?? META_WEBHOOK_VERIFY_TOKEN).

## Limits (v1, acceptable)
Numbered-text choices (no native buttons); single-select; first question of a batch only; media as link previews. 24h window applies (user-initiated, so replies are fine).
