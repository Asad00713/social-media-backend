# WhatsApp Message Templates — Design

**Date:** 2026-08-26
**Branch:** `feat/whatsapp-templates` (both repos)
**Status:** Approved, ready for planning

## Problem

Two problems, one solution.

**1. The inbox has a dead end.** `whatsapp-dm.adapter.ts:147` tells the user:

> "The 24-hour reply window has closed. A pre-approved template is required (coming soon)."

WhatsApp only allows free-form replies within 24 hours of the customer's last
message. After that, the only way to reach the customer is an approved template.
Today Schedura has no template surface, so the conversation simply stops. The
copy promises a feature that does not exist.

**2. The Library has no WhatsApp templates.** Users manage post templates in the
Library but must leave Schedura and use WhatsApp Manager to manage WhatsApp
templates.

## What makes this non-trivial

WhatsApp templates are not our data. They live on the customer's WhatsApp
Business Account (WABA) at Meta. We mirror them; we do not own them. Every
design decision below follows from that.

- Creation is **asynchronous**. Meta reviews each template — the docs say up to
  24 hours. A template is unusable until `APPROVED`.
- Deletion is **permanent**. There is no recycle bin at Meta.
- **Meta can override the category.** If you submit `UTILITY` and Meta decides
  it is `MARKETING`, it is approved as `MARKETING`. Category drives pricing, so
  we must display Meta's category, never the user's requested one.

## Permission status (verified 2026-08-26)

`whatsapp_business_management` gates both reading and writing templates.

| App | Status |
|---|---|
| `1498206521956735` | **live, Advanced Access, approved** |
| `1645427979885306` (Threads) | not present |

`channels.schema.ts:819` already requests both `whatsapp_business_messaging`
and `whatsapp_business_management`. The user has reconnected channels and
confirmed messaging works, so tokens carry the scope.

**No App Review blocker.** This differs from other WhatsApp work that is
waiting on review.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Data model | Separate `whatsapp_message_templates` table | Shape shares nothing with `media_templates` beyond the word "template" |
| Library placement | Same grid, two card variants | User gets one place; actions stay honest per variant |
| Status freshness | Webhook **and** fetch-on-load | Webhook for real-time; fetch as backstop for missed webhooks |
| Delete | Confirm dialog + hard delete | Meta has no recycle bin — the UI must not imply one |
| Phasing | Phase 1 sync, Phase 2 builder | Unblocks the inbox first; teaches us Meta's real payloads before we build a creator |

### Why not extend `media_templates`

They overlap in name only:

| | `media_templates` | WhatsApp template |
|---|---|---|
| Lives | our DB | customer's WABA at Meta |
| Type | `post/story/reel/carousel` | `MARKETING/UTILITY/AUTHENTICATION` |
| Body | `text + mediaSlots + hashtags` | `components[]` — HEADER/BODY/FOOTER/BUTTONS |
| Variables | `{{placeholder}}` free-form | `{{1}}`, `{{2}}` positional, strict rules |
| Edit | anytime | re-enters review |
| Delete | soft, recycle bin | permanent at Meta |
| On create | ready | `PENDING` |

Merging them would put `if (platform === 'whatsapp')` into the schema, builder,
picker, and composer. `media_templates` is not modified by this work — not one
column.

### Why the grid is shared but the card is not

`TemplateCardGrid` exposes five actions. Four are wrong for WhatsApp:

| Action | On a WhatsApp template |
|---|---|
| `onToggleStar` | needs our own column (Meta has no star) |
| `onDelete` | soft-delete promise is false — Meta deletes permanently |
| `onDuplicate` | the copy re-enters review; not an instant clone |
| `onUseInPost` | templates go to the **inbox**, not the composer |

Keeping one grid with shared actions would either break the recycle-bin promise
or ship buttons that lie. Splitting at the **card** keeps both call sites
(`starred-view.tsx:358`, `type-view.tsx:622`) unchanged while each variant keeps
honest actions.

## Architecture

### Data model (backend)

New table `whatsapp_message_templates`:

```
id                uuid pk
workspaceId       uuid → workspace (cascade)
channelId         uuid → channels (cascade)
wabaId            varchar          -- denormalized; sync key
metaTemplateId    varchar          -- Meta's id; upsert key
name              varchar
language          varchar          -- (name, language) is Meta's unique pair
category           varchar          -- Meta's RETURNED category, not requested
status            varchar          -- 14 values, see below
rejectionReason   varchar null     -- when REJECTED
components        jsonb            -- HEADER/BODY/FOOTER/BUTTONS
lastSyncedAt      timestamptz
createdAt / updatedAt
```

- **No soft delete.** Deletion is permanent at Meta; a recycle bin would be a
  lie. Rows disappear when they disappear from Meta.
- Unique index on `(channelId, name, language)`; index on `metaTemplateId`.

### Status values

Meta's `event` has 14 values, not 3:

`APPROVED, PENDING, REJECTED, PAUSED, DISABLED, FLAGGED, ARCHIVED,
UNARCHIVED, DELETED, IN_APPEAL, LIMIT_EXCEEDED, LOCKED, REINSTATED,
PENDING_DELETION`

`reason`: `ABUSIVE_CONTENT, CATEGORY_NOT_AVAILABLE, INCORRECT_CATEGORY,
INVALID_FORMAT, NONE, PROMOTIONAL, SCAM, TAG_CONTENT_MISMATCH`, or null.

Stored verbatim. The UI groups them into four tones (below). An unrecognized
value must render as neutral, never blank — Meta may add values.

Only `APPROVED` is sendable.

### Sync

`GET /<wabaId>/message_templates` using the channel's token.

- Upsert on `metaTemplateId`
- Delete local rows absent from Meta's response
- Triggered on: Library templates page load, and channel connect

**Fan-out:** one WABA can be connected to two workspaces. We have shipped this
bug before (`findChannelsByPlatformAccount`). Sync and webhook handling resolve
**all** matching channels from the start.

### Webhook

`parseWhatsAppMessages` hard-filters `change.field !== 'messages'`, so template
events are **dropped today**. The route exists; the event does not flow.

Add a **separate** `parseWhatsAppTemplateEvents()` in
`whatsapp-webhook.util.ts` and route to it from `webhooks.controller.ts`.
`parseWhatsAppMessages` is untouched — inbox ingest and the Maestro bridge both
depend on it.

Payload:

```json
{
  "object": "whatsapp_business_account",
  "entry": [{ "id": "<WABA_ID>", "changes": [{
    "field": "message_template_status_update",
    "value": {
      "event": "APPROVED",
      "message_template_id": 1689556908129832,
      "message_template_name": "order_confirmation",
      "message_template_language": "en-US",
      "reason": "NONE",
      "message_template_category": "UTILITY"
    }
  }]}]
}
```

A webhook for an unknown `message_template_id` is ignored, not an error — it
may belong to a WABA we do not track.

### Sending

`whatsapp.service.ts` has `sendText` and `sendMedia`; add `sendTemplate` on the
same seam. `whatsapp-dm.adapter.ts` gains a template send path.

### Frontend

- `WhatsAppTemplate` type in `media-library/types/`
- `TemplateCardGrid` takes a discriminated union; renders `TemplateCard` or
  `WhatsAppTemplateCard`
- WhatsApp card actions: **View**, **Delete** (confirm + hard), **Send in inbox**
- Status badge tones:
  - green — `APPROVED`, `REINSTATED`
  - amber — `PENDING`, `IN_APPEAL`, `PENDING_DELETION`
  - red — `REJECTED`, `DISABLED`, `PAUSED`, `FLAGGED`, `LIMIT_EXCEEDED`, `LOCKED`
  - muted — `ARCHIVED`, `UNARCHIVED`, `DELETED`, anything unrecognized
- Rejected cards surface `rejectionReason` in human words
- **Inbox**: when the 24-hour window is closed, replace the "coming soon" copy
  with a picker of `APPROVED` templates

## Scope

### Phase 1 (this effort)

- Table + migration
- Sync service (list, upsert, prune) with fan-out
- Webhook parser + routing + status updates
- Read endpoints
- Library grid: WhatsApp cards, status badges
- Delete (confirm + hard)
- Inbox: approved-template picker replacing the dead end

### Phase 2 (not now)

- Template builder (create/edit) with components and variables
- Category selection, variable samples, button config

### Explicitly out

- Template analytics / quality rating
- Media-header uploads for template creation
- Marketing Messages API
- Bulk template campaigns

## Testing

Pure functions, unit-testable without network or DOM:

- **Sync reconciliation** — upsert existing, insert new, prune missing; and the
  fan-out case (one WABA, two workspaces)
- **Webhook parser** — all 14 events; malformed payloads; the `field` filter
  keeps `messages` events flowing to the existing parser untouched
- **Status→tone mapping** — every known status, plus an unknown value rendering
  neutral rather than blank
- **Sendability** — only `APPROVED` is offered in the inbox picker

Regression guard: an existing `parseWhatsAppMessages` test must still pass
unchanged, proving inbox ingest was not disturbed.

## Risks

| Risk | Mitigation |
|---|---|
| Webhook missed | fetch-on-load reconciles |
| Meta adds a status value | unknown → neutral badge, never blank |
| Meta overrides category | store and display Meta's returned category |
| Same WABA in two workspaces | fan-out from the start |
| Touching the shared webhook parser | new function; existing one untouched + regression test |
| Sync on every page load is chatty | `lastSyncedAt` throttle |

## References

- [Templates overview](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview)
- [message_template_status_update](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/message_template_status_update)
- [Template categorization](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-categorization)
- [Graph API: WABA message_templates](https://developers.facebook.com/docs/graph-api/reference/whats-app-business-account/message_templates/)
