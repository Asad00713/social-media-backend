# WhatsApp Message Templates — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mirror the customer's WhatsApp message templates from Meta into the Library with a live approval badge, and replace the inbox's closed-window dead end with a picker of approved templates.

**Architecture:** A new `whatsapp_message_templates` table mirrors templates that live on the customer's WABA at Meta. A sync service reconciles them (upsert + prune) on page load; a new webhook parser keeps status live between syncs. The Library reuses `TemplateCardGrid` but renders a distinct card variant so WhatsApp actions stay honest. `media_templates` is not modified — not one column.

**Tech Stack:** NestJS, Drizzle ORM, PostgreSQL, BullMQ, Jest (backend); React 19, TanStack Query v5, shadcn/ui, Vitest (frontend).

**Spec:** `docs/superpowers/specs/2026-08-26-whatsapp-templates-design.md`

## Global Constraints

- **Branch:** `feat/whatsapp-templates` in **both** repos. Backend was branched from `origin/main` (`1b9fb9f`), frontend from `main` (`0343eb9`).
- **Never modify `media_templates`** — no new columns, no shape changes.
- **Never modify `parseWhatsAppMessages`** — inbox ingest (`whatsapp-ingest.service.ts:20`) and the Maestro bridge (`maestro-bridge.processor.ts:218`) both depend on it. Add a separate function.
- **Store Meta's returned category**, never the user's requested one — Meta silently overrides `UTILITY` → `MARKETING`, and category drives pricing.
- **No soft delete** on WhatsApp templates. Meta deletion is permanent; a recycle bin would be a lie.
- **Only `APPROVED` is sendable.**
- **Unknown status → neutral badge, never blank.** Meta may add values.
- **Fan-out from the start:** one WABA can be connected to two workspaces.
- Graph API version: use the existing `WHATSAPP_GRAPH_BASE` constant in `whatsapp.service.ts`. Do not hardcode a version.
- Backend tests: Jest, `*.spec.ts` co-located. Frontend tests: Vitest, `*.test.ts`, **pure logic only — no DOM testing is configured**.
- Commit after every task. Backend and frontend commit separately.

### The 14 status values (verbatim from Meta)

`APPROVED, PENDING, REJECTED, PAUSED, DISABLED, FLAGGED, ARCHIVED, UNARCHIVED, DELETED, IN_APPEAL, LIMIT_EXCEEDED, LOCKED, REINSTATED, PENDING_DELETION`

### The 8 rejection reasons (verbatim from Meta)

`ABUSIVE_CONTENT, CATEGORY_NOT_AVAILABLE, INCORRECT_CATEGORY, INVALID_FORMAT, NONE, PROMOTIONAL, SCAM, TAG_CONTENT_MISMATCH` (or `null`)

---

## File Structure

**Backend (`socialmedia-workspace`)**

| File | Responsibility |
|---|---|
| `src/drizzle/schema/whatsapp-templates.schema.ts` | *Create* — table, types, status/category constants |
| `drizzle/migrations/00XX_whatsapp_templates.sql` | *Create* — hand-written (journal drift; `db:generate` unusable) |
| `src/channels/services/whatsapp-template.util.ts` | *Create* — pure: webhook parse + Meta-row → DB-row mapping |
| `src/channels/services/whatsapp-template.util.spec.ts` | *Create* — tests for the above |
| `src/channels/services/whatsapp.service.ts` | *Modify* — add `listMessageTemplates`, `deleteMessageTemplate`, `sendTemplate` |
| `src/whatsapp-templates/whatsapp-templates.service.ts` | *Create* — sync reconciliation, status updates, fan-out |
| `src/whatsapp-templates/whatsapp-templates.controller.ts` | *Create* — list / sync / delete endpoints |
| `src/whatsapp-templates/whatsapp-templates.module.ts` | *Create* — module wiring |
| `src/channels/webhooks.controller.ts` | *Modify* — route template events before the maestro/ingest branch |
| `src/inbox/adapters/whatsapp-dm.adapter.ts` | *Modify* — `sendTemplateDm`; drop the "coming soon" copy |

**Frontend (`socialmedia-frontend`)**

| File | Responsibility |
|---|---|
| `src/features/media-library/types/whatsapp-template.ts` | *Create* — types + status tone mapping |
| `src/features/media-library/types/whatsapp-template.test.ts` | *Create* — tone mapping tests |
| `src/features/media-library/api/whatsapp-templates.api.ts` | *Create* — typed apiClient wrappers |
| `src/features/media-library/hooks/use-whatsapp-templates.ts` | *Create* — list query + sync/delete mutations |
| `src/features/media-library/components/items/whatsapp-template-card.tsx` | *Create* — the WhatsApp card variant |
| `src/features/media-library/components/items/template-card-grid.tsx` | *Modify* — accept the union, dispatch to the right card |
| `src/features/media-library/components/type-view/type-view.tsx` | *Modify* — feed WhatsApp templates into the grid |
| `src/features/inbox/components/whatsapp-template-picker.tsx` | *Create* — approved-template picker |

---

## Task 1: Schema + migration

**Files:**
- Create: `src/drizzle/schema/whatsapp-templates.schema.ts`
- Create: `drizzle/migrations/00XX_whatsapp_templates.sql`
- Modify: `src/drizzle/schema/index.ts` (add the export)

**Interfaces:**
- Consumes: nothing.
- Produces: `whatsappMessageTemplates` table; `WHATSAPP_TEMPLATE_STATUS`, `WHATSAPP_TEMPLATE_CATEGORY`, `WHATSAPP_TEMPLATE_REJECTION_REASON` const arrays; types `WhatsAppTemplateStatus`, `WhatsAppTemplateCategory`, `WhatsAppTemplateComponent`, `WhatsAppMessageTemplate`, `NewWhatsAppMessageTemplate`.

- [ ] **Step 1: Read the sibling schema for house style**

Read `src/drizzle/schema/feedback.schema.ts`. Note: `desc` imports from `drizzle-orm`, **not** `drizzle-orm/pg-core`.

- [ ] **Step 2: Write the schema file**

```ts
import {
  bigint, index, jsonb, pgTable, timestamp, uniqueIndex, uuid, varchar,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { workspace } from './workspace.schema';
import { socialMediaChannels } from './channels.schema';

/** Meta's full status set. Stored verbatim — the UI groups these into tones.
 *  Meta may add values, so consumers must tolerate an unrecognized string. */
export const WHATSAPP_TEMPLATE_STATUS = [
  'APPROVED', 'PENDING', 'REJECTED', 'PAUSED', 'DISABLED', 'FLAGGED',
  'ARCHIVED', 'UNARCHIVED', 'DELETED', 'IN_APPEAL', 'LIMIT_EXCEEDED',
  'LOCKED', 'REINSTATED', 'PENDING_DELETION',
] as const;
export type WhatsAppTemplateStatus = (typeof WHATSAPP_TEMPLATE_STATUS)[number];

export const WHATSAPP_TEMPLATE_CATEGORY = [
  'MARKETING', 'UTILITY', 'AUTHENTICATION',
] as const;
export type WhatsAppTemplateCategory =
  (typeof WHATSAPP_TEMPLATE_CATEGORY)[number];

export const WHATSAPP_TEMPLATE_REJECTION_REASON = [
  'ABUSIVE_CONTENT', 'CATEGORY_NOT_AVAILABLE', 'INCORRECT_CATEGORY',
  'INVALID_FORMAT', 'NONE', 'PROMOTIONAL', 'SCAM', 'TAG_CONTENT_MISMATCH',
] as const;

/** One HEADER/BODY/FOOTER/BUTTONS block as Meta returns it. Kept loose on
 *  purpose: Phase 1 only renders these, and Meta's component shape varies by
 *  format far more than Phase 1 needs to model. */
export interface WhatsAppTemplateComponent {
  type: 'HEADER' | 'BODY' | 'FOOTER' | 'BUTTONS';
  format?: 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT' | 'LOCATION';
  text?: string;
  buttons?: Array<Record<string, any>>;
  example?: Record<string, any>;
}

export const whatsappMessageTemplates = pgTable(
  'whatsapp_message_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),

    /** The channel whose token synced this row. `social_media_channels.id` is
     *  a bigserial, so this is a bigint — NOT a uuid like the other FKs. */
    channelId: bigint('channel_id', { mode: 'number' })
      .notNull()
      .references(() => socialMediaChannels.id, { onDelete: 'cascade' }),

    /** Denormalized from channel.metadata.wabaId so webhook lookups, which
     *  arrive keyed by WABA, do not have to join through channels. */
    wabaId: varchar('waba_id', { length: 64 }).notNull(),

    /** Meta's own id. The upsert key. */
    metaTemplateId: varchar('meta_template_id', { length: 64 }).notNull(),

    name: varchar('name', { length: 512 }).notNull(),
    language: varchar('language', { length: 32 }).notNull(),

    /** Meta's RETURNED category, never the requested one — Meta silently
     *  overrides UTILITY to MARKETING, and category drives pricing. */
    category: varchar('category', { length: 32 })
      .$type<WhatsAppTemplateCategory>()
      .notNull(),

    status: varchar('status', { length: 32 })
      .$type<WhatsAppTemplateStatus>()
      .notNull(),

    rejectionReason: varchar('rejection_reason', { length: 64 }),

    components: jsonb('components')
      .$type<WhatsAppTemplateComponent[]>()
      .notNull()
      .default([]),

    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Meta's identity for a template is (name, language) within a WABA.
    uniqueIndex('whatsapp_templates_channel_name_lang_uq').on(
      table.channelId, table.name, table.language,
    ),
    index('whatsapp_templates_meta_id_idx').on(table.metaTemplateId),
    index('whatsapp_templates_waba_id_idx').on(table.wabaId),
    index('whatsapp_templates_workspace_id_idx').on(table.workspaceId),
    index('whatsapp_templates_channel_id_idx').on(table.channelId),
  ],
);

export const whatsappMessageTemplatesRelations = relations(
  whatsappMessageTemplates,
  ({ one }) => ({
    workspace: one(workspace, {
      fields: [whatsappMessageTemplates.workspaceId],
      references: [workspace.id],
    }),
    channel: one(socialMediaChannels, {
      fields: [whatsappMessageTemplates.channelId],
      references: [socialMediaChannels.id],
    }),
  }),
);

export type WhatsAppMessageTemplate =
  typeof whatsappMessageTemplates.$inferSelect;
export type NewWhatsAppMessageTemplate =
  typeof whatsappMessageTemplates.$inferInsert;
```

**Verified before writing this plan:** `workspace` is `pgTable('workspace', ...)` with a `uuid` PK; `socialMediaChannels` is `pgTable('social_media_channels', ...)` and its PK is `bigserial('id', { mode: 'number' })` — **a bigint, not a uuid**. `channelId` above is typed accordingly. Do not "correct" it to `uuid`: the FK would fail to create.

- [ ] **Step 3: Export from the schema barrel**

Add to `src/drizzle/schema/index.ts` following the existing export style.

- [ ] **Step 4: Write the migration by hand**

The journal has drifted (see the Evergreen and feedback efforts) — `npm run db:generate` is unusable. Find the highest-numbered file in `drizzle/migrations/` and use the next number.

```sql
CREATE TABLE IF NOT EXISTS "whatsapp_message_templates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "channel_id" bigint NOT NULL,
  "waba_id" varchar(64) NOT NULL,
  "meta_template_id" varchar(64) NOT NULL,
  "name" varchar(512) NOT NULL,
  "language" varchar(32) NOT NULL,
  "category" varchar(32) NOT NULL,
  "status" varchar(32) NOT NULL,
  "rejection_reason" varchar(64),
  "components" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "last_synced_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "whatsapp_message_templates_workspace_id_fk"
    FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE,
  CONSTRAINT "whatsapp_message_templates_channel_id_fk"
    FOREIGN KEY ("channel_id") REFERENCES "social_media_channels"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "whatsapp_templates_channel_name_lang_uq"
  ON "whatsapp_message_templates" ("channel_id","name","language");
CREATE INDEX IF NOT EXISTS "whatsapp_templates_meta_id_idx"
  ON "whatsapp_message_templates" ("meta_template_id");
CREATE INDEX IF NOT EXISTS "whatsapp_templates_waba_id_idx"
  ON "whatsapp_message_templates" ("waba_id");
CREATE INDEX IF NOT EXISTS "whatsapp_templates_workspace_id_idx"
  ON "whatsapp_message_templates" ("workspace_id");
CREATE INDEX IF NOT EXISTS "whatsapp_templates_channel_id_idx"
  ON "whatsapp_message_templates" ("channel_id");
```

Replace both `<...>` markers with the real table name and PK type found in Step 2.

- [ ] **Step 5: Verify it compiles**

Run: `npm run build`
Expected: PASS, no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add src/drizzle/schema/whatsapp-templates.schema.ts src/drizzle/schema/index.ts drizzle/migrations/
git commit -m "feat(whatsapp): whatsapp_message_templates schema + migration"
```

---

## Task 2: Pure utilities — webhook parser + Meta row mapper

**Files:**
- Create: `src/channels/services/whatsapp-template.util.ts`
- Create: `src/channels/services/whatsapp-template.util.spec.ts`

**Interfaces:**
- Consumes: `WhatsAppTemplateStatus`, `WhatsAppTemplateCategory`, `WhatsAppTemplateComponent` from Task 1.
- Produces:
  - `parseWhatsAppTemplateEvents(payload: any): ParsedTemplateEvent[]`
  - `interface ParsedTemplateEvent { wabaId: string; metaTemplateId: string; name: string; language: string; status: string; category?: string; reason?: string | null }`
  - `mapMetaTemplateRow(row: any): MappedMetaTemplate`
  - `interface MappedMetaTemplate { metaTemplateId: string; name: string; language: string; category: string; status: string; components: WhatsAppTemplateComponent[] }`

This task is pure functions only — no DB, no network. Everything testable in isolation.

- [ ] **Step 1: Write the failing tests**

```ts
import {
  parseWhatsAppTemplateEvents,
  mapMetaTemplateRow,
} from './whatsapp-template.util';
import { parseWhatsAppMessages } from './whatsapp-webhook.util';

const statusPayload = (event: string, reason: string | null = 'NONE') => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: '102290129340398',
      time: 1751247548,
      changes: [
        {
          field: 'message_template_status_update',
          value: {
            event,
            message_template_id: 1689556908129832,
            message_template_name: 'order_confirmation',
            message_template_language: 'en-US',
            reason,
            message_template_category: 'UTILITY',
          },
        },
      ],
    },
  ],
});

describe('parseWhatsAppTemplateEvents', () => {
  it('parses an APPROVED event', () => {
    const [ev] = parseWhatsAppTemplateEvents(statusPayload('APPROVED'));
    expect(ev).toEqual({
      wabaId: '102290129340398',
      metaTemplateId: '1689556908129832',
      name: 'order_confirmation',
      language: 'en-US',
      status: 'APPROVED',
      category: 'UTILITY',
      reason: 'NONE',
    });
  });

  it.each([
    'APPROVED', 'PENDING', 'REJECTED', 'PAUSED', 'DISABLED', 'FLAGGED',
    'ARCHIVED', 'UNARCHIVED', 'DELETED', 'IN_APPEAL', 'LIMIT_EXCEEDED',
    'LOCKED', 'REINSTATED', 'PENDING_DELETION',
  ])('parses the %s event', (event) => {
    const [ev] = parseWhatsAppTemplateEvents(statusPayload(event));
    expect(ev.status).toBe(event);
  });

  it('carries the rejection reason through', () => {
    const [ev] = parseWhatsAppTemplateEvents(
      statusPayload('REJECTED', 'INCORRECT_CATEGORY'),
    );
    expect(ev.reason).toBe('INCORRECT_CATEGORY');
  });

  it('tolerates a null reason', () => {
    const [ev] = parseWhatsAppTemplateEvents(
      statusPayload('PENDING_DELETION', null),
    );
    expect(ev.reason).toBeNull();
  });

  it('ignores message events', () => {
    const messagePayload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA_ID',
          changes: [
            { field: 'messages', value: { messages: [{ id: 'wamid.X' }] } },
          ],
        },
      ],
    };
    expect(parseWhatsAppTemplateEvents(messagePayload)).toEqual([]);
  });

  it.each([
    [null], [undefined], [{}], [{ object: 'page' }],
    [{ object: 'whatsapp_business_account' }],
    [{ object: 'whatsapp_business_account', entry: [{}] }],
    [{ object: 'whatsapp_business_account', entry: [{ changes: [{}] }] }],
  ])('returns [] for malformed payload %#', (payload) => {
    expect(parseWhatsAppTemplateEvents(payload as any)).toEqual([]);
  });

  it('leaves parseWhatsAppMessages untouched for message payloads', () => {
    // Regression guard: the two parsers must not interfere. Inbox ingest and
    // the Maestro bridge both depend on parseWhatsAppMessages.
    const messagePayload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA_ID',
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: '1010' },
                messages: [
                  {
                    from: '15551234567',
                    id: 'wamid.HBgL',
                    timestamp: '1719400000',
                    type: 'text',
                    text: { body: 'Hi' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    expect(parseWhatsAppMessages(messagePayload)).toHaveLength(1);
    expect(parseWhatsAppTemplateEvents(messagePayload)).toEqual([]);
  });
});

describe('mapMetaTemplateRow', () => {
  it('maps a Meta list row', () => {
    const row = {
      id: '1689556908129832',
      name: 'order_confirmation',
      language: 'en_US',
      category: 'UTILITY',
      status: 'APPROVED',
      components: [{ type: 'BODY', text: 'Your order {{1}} shipped.' }],
    };
    expect(mapMetaTemplateRow(row)).toEqual({
      metaTemplateId: '1689556908129832',
      name: 'order_confirmation',
      language: 'en_US',
      category: 'UTILITY',
      status: 'APPROVED',
      components: [{ type: 'BODY', text: 'Your order {{1}} shipped.' }],
    });
  });

  it('defaults components to [] when Meta omits them', () => {
    const row = {
      id: '1', name: 'n', language: 'en', category: 'MARKETING',
      status: 'PENDING',
    };
    expect(mapMetaTemplateRow(row).components).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/channels/services/whatsapp-template.util.spec.ts`
Expected: FAIL — cannot find module `./whatsapp-template.util`.

- [ ] **Step 3: Write the implementation**

```ts
import type { WhatsAppTemplateComponent } from '../../drizzle/schema/whatsapp-templates.schema';

export interface ParsedTemplateEvent {
  wabaId: string;
  metaTemplateId: string;
  name: string;
  language: string;
  status: string;
  category?: string;
  reason?: string | null;
}

/**
 * Flatten `message_template_status_update` webhooks into status rows.
 *
 * Deliberately separate from `parseWhatsAppMessages`: that parser feeds inbox
 * ingest and the Maestro bridge, and both filter on `field === 'messages'`.
 * Widening it would put template payloads through message code paths.
 */
export function parseWhatsAppTemplateEvents(
  payload: any,
): ParsedTemplateEvent[] {
  const out: ParsedTemplateEvent[] = [];
  if (payload?.object !== 'whatsapp_business_account') return out;
  for (const entry of payload?.entry ?? []) {
    const wabaId = entry?.id;
    if (!wabaId) continue;
    for (const change of entry?.changes ?? []) {
      if (change?.field !== 'message_template_status_update') continue;
      const v = change.value ?? {};
      if (!v?.message_template_id || !v?.event) continue;
      out.push({
        wabaId: String(wabaId),
        metaTemplateId: String(v.message_template_id),
        name: String(v.message_template_name ?? ''),
        language: String(v.message_template_language ?? ''),
        status: String(v.event),
        category: v.message_template_category
          ? String(v.message_template_category)
          : undefined,
        reason: v.reason === undefined ? undefined : v.reason,
      });
    }
  }
  return out;
}

export interface MappedMetaTemplate {
  metaTemplateId: string;
  name: string;
  language: string;
  category: string;
  status: string;
  components: WhatsAppTemplateComponent[];
}

/** Normalize one row of `GET /<waba>/message_templates` into our column shape. */
export function mapMetaTemplateRow(row: any): MappedMetaTemplate {
  return {
    metaTemplateId: String(row?.id ?? ''),
    name: String(row?.name ?? ''),
    language: String(row?.language ?? ''),
    category: String(row?.category ?? ''),
    status: String(row?.status ?? ''),
    components: Array.isArray(row?.components) ? row.components : [],
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/channels/services/whatsapp-template.util.spec.ts`
Expected: PASS, all tests green.

- [ ] **Step 5: Run the pre-existing webhook util tests**

Run: `npx jest src/channels/services/whatsapp-webhook.util.spec.ts`
Expected: PASS, unchanged. This proves the existing parser was not disturbed.

- [ ] **Step 6: Commit**

```bash
git add src/channels/services/whatsapp-template.util.ts src/channels/services/whatsapp-template.util.spec.ts
git commit -m "feat(whatsapp): template webhook parser + Meta row mapper"
```

---

## Task 3: Meta API calls on WhatsAppService

**Files:**
- Modify: `src/channels/services/whatsapp.service.ts`

**Interfaces:**
- Consumes: existing `WHATSAPP_GRAPH_BASE` constant in this file.
- Produces:
  - `listMessageTemplates(accessToken: string, wabaId: string): Promise<any[]>`
  - `deleteMessageTemplate(accessToken, wabaId, name, metaTemplateId): Promise<void>`
  - `sendTemplate(accessToken, phoneNumberId, toWaId, name, language, components?): Promise<{ messageId: string }>`

Follow the exact shape of the existing `sendText` (read it first): `fetch`, `await res.json().catch(() => ({}))`, throw `data?.error?.message` on `!res.ok`.

- [ ] **Step 1: Add the three methods**

```ts
  /**
   * List every template on a WABA. Meta paginates; follow `paging.next` so a
   * business with more than one page does not silently lose the tail.
   */
  async listMessageTemplates(
    accessToken: string,
    wabaId: string,
  ): Promise<any[]> {
    const out: any[] = [];
    let url =
      `${WHATSAPP_GRAPH_BASE}/${wabaId}/message_templates` +
      `?limit=100&fields=id,name,language,category,status,components`;
    // Bounded so a malformed paging cursor cannot spin forever.
    for (let page = 0; page < 20 && url; page++) {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg =
          data?.error?.message ||
          `WhatsApp template list failed (${res.status})`;
        throw new Error(msg);
      }
      out.push(...(data?.data ?? []));
      url = data?.paging?.next ?? '';
    }
    return out;
  }

  /**
   * Delete a template at Meta. Permanent — there is no recycle bin. Deleting
   * by name removes every language variant, so pass `hsm_id` to scope the
   * delete to the one row the user actually chose.
   */
  async deleteMessageTemplate(
    accessToken: string,
    wabaId: string,
    name: string,
    metaTemplateId: string,
  ): Promise<void> {
    const url =
      `${WHATSAPP_GRAPH_BASE}/${wabaId}/message_templates` +
      `?name=${encodeURIComponent(name)}` +
      `&hsm_id=${encodeURIComponent(metaTemplateId)}`;
    const res = await fetch(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg =
        data?.error?.message || `WhatsApp template delete failed (${res.status})`;
      throw new Error(msg);
    }
  }

  /**
   * Send an approved template. Unlike `sendText`, this is valid *outside* the
   * 24-hour customer window — that is the whole point of templates.
   */
  async sendTemplate(
    accessToken: string,
    phoneNumberId: string,
    toWaId: string,
    name: string,
    language: string,
    components?: Array<Record<string, any>>,
  ): Promise<{ messageId: string }> {
    const res = await fetch(`${WHATSAPP_GRAPH_BASE}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: toWaId,
        type: 'template',
        template: {
          name,
          language: { code: language },
          ...(components?.length ? { components } : {}),
        },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg =
        data?.error?.message || `WhatsApp template send failed (${res.status})`;
      throw new Error(msg);
    }
    return { messageId: data?.messages?.[0]?.id ?? '' };
  }
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Run the existing WhatsApp service tests**

Run: `npx jest src/channels/services/whatsapp.service.spec.ts`
Expected: PASS, unchanged.

- [ ] **Step 4: Commit**

```bash
git add src/channels/services/whatsapp.service.ts
git commit -m "feat(whatsapp): list/delete/send message template Graph calls"
```

---

## Task 4: Sync service (reconciliation + fan-out)

**Files:**
- Create: `src/whatsapp-templates/whatsapp-templates.service.ts`
- Create: `src/whatsapp-templates/whatsapp-templates.service.spec.ts`
- Create: `src/whatsapp-templates/whatsapp-templates.module.ts`

**Interfaces:**
- Consumes: `mapMetaTemplateRow` (Task 2), `listMessageTemplates` / `deleteMessageTemplate` (Task 3), `whatsappMessageTemplates` (Task 1).
- Produces:
  - `reconcile(existing: ExistingRow[], incoming: MappedMetaTemplate[]): ReconcileResult` — **exported standalone pure function**, not a method
  - `shouldSyncChannel(lastSyncedAt: Date | null, now: Date, force?: boolean): boolean` — exported pure function
  - `SYNC_MIN_INTERVAL_MS: number`
  - `interface ExistingRow { id: string; metaTemplateId: string; status: string }`
  - `interface ReconcileResult { toInsert: MappedMetaTemplate[]; toUpdate: Array<{ id: string; row: MappedMetaTemplate }>; toDeleteIds: string[] }`
  - `WhatsAppTemplatesService.syncWorkspace(workspaceId: string, opts?: { force?: boolean }): Promise<{ synced: number }>`
  - `WhatsAppTemplatesService.applyStatusEvents(events: ParsedTemplateEvent[]): Promise<void>`
  - `WhatsAppTemplatesService.listForWorkspace(workspaceId: string): Promise<WhatsAppMessageTemplate[]>`
  - `WhatsAppTemplatesService.deleteTemplate(workspaceId: string, id: string): Promise<void>`

`reconcile` is pure so it can be tested without a database — that is where the real logic risk lives.

- [ ] **Step 1: Write the failing tests for `reconcile`**

```ts
import {
  reconcile, shouldSyncChannel, SYNC_MIN_INTERVAL_MS,
} from './whatsapp-templates.service';

const meta = (id: string, status = 'APPROVED') => ({
  metaTemplateId: id,
  name: `t_${id}`,
  language: 'en_US',
  category: 'UTILITY',
  status,
  components: [],
});

describe('reconcile', () => {
  it('inserts templates Meta has and we do not', () => {
    const r = reconcile([], [meta('1'), meta('2')]);
    expect(r.toInsert.map((x) => x.metaTemplateId)).toEqual(['1', '2']);
    expect(r.toUpdate).toEqual([]);
    expect(r.toDeleteIds).toEqual([]);
  });

  it('updates templates both sides have', () => {
    const existing = [{ id: 'row-1', metaTemplateId: '1', status: 'PENDING' }];
    const r = reconcile(existing, [meta('1', 'APPROVED')]);
    expect(r.toInsert).toEqual([]);
    expect(r.toUpdate).toHaveLength(1);
    expect(r.toUpdate[0].id).toBe('row-1');
    expect(r.toUpdate[0].row.status).toBe('APPROVED');
    expect(r.toDeleteIds).toEqual([]);
  });

  it('prunes rows Meta no longer has', () => {
    const existing = [
      { id: 'row-1', metaTemplateId: '1', status: 'APPROVED' },
      { id: 'row-2', metaTemplateId: '2', status: 'APPROVED' },
    ];
    const r = reconcile(existing, [meta('1')]);
    expect(r.toDeleteIds).toEqual(['row-2']);
  });

  it('handles all three operations at once', () => {
    const existing = [
      { id: 'row-1', metaTemplateId: '1', status: 'PENDING' },
      { id: 'row-gone', metaTemplateId: '99', status: 'APPROVED' },
    ];
    const r = reconcile(existing, [meta('1', 'APPROVED'), meta('2')]);
    expect(r.toInsert.map((x) => x.metaTemplateId)).toEqual(['2']);
    expect(r.toUpdate.map((x) => x.id)).toEqual(['row-1']);
    expect(r.toDeleteIds).toEqual(['row-gone']);
  });

  it('prunes everything when Meta returns nothing', () => {
    const existing = [{ id: 'row-1', metaTemplateId: '1', status: 'APPROVED' }];
    const r = reconcile(existing, []);
    expect(r.toDeleteIds).toEqual(['row-1']);
    expect(r.toInsert).toEqual([]);
  });

  it('is a no-op when both sides already agree', () => {
    const existing = [{ id: 'row-1', metaTemplateId: '1', status: 'APPROVED' }];
    const r = reconcile(existing, [meta('1', 'APPROVED')]);
    expect(r.toInsert).toEqual([]);
    expect(r.toDeleteIds).toEqual([]);
    // Still emitted as an update: components or category may have changed even
    // when status did not, and re-writing is cheaper than diffing every field.
    expect(r.toUpdate).toHaveLength(1);
  });
});

describe('shouldSyncChannel', () => {
  const now = new Date('2026-08-26T12:00:00Z');

  it('syncs a channel that has never synced', () => {
    expect(shouldSyncChannel(null, now)).toBe(true);
  });

  it('skips a channel synced moments ago', () => {
    const justNow = new Date(now.getTime() - 30_000);
    expect(shouldSyncChannel(justNow, now)).toBe(false);
  });

  it('syncs again once the interval has passed', () => {
    const stale = new Date(now.getTime() - SYNC_MIN_INTERVAL_MS - 1);
    expect(shouldSyncChannel(stale, now)).toBe(true);
  });

  it('syncs at exactly the interval boundary', () => {
    const boundary = new Date(now.getTime() - SYNC_MIN_INTERVAL_MS);
    expect(shouldSyncChannel(boundary, now)).toBe(true);
  });

  it('force overrides a fresh sync', () => {
    const justNow = new Date(now.getTime() - 30_000);
    expect(shouldSyncChannel(justNow, now, true)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/whatsapp-templates/whatsapp-templates.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `reconcile` and the service**

```ts
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../drizzle/db';
import { whatsappMessageTemplates } from '../drizzle/schema/whatsapp-templates.schema';
import { WhatsAppService } from '../channels/services/whatsapp.service';
import { ChannelService } from '../channels/services/channel.service';
import {
  mapMetaTemplateRow,
  type MappedMetaTemplate,
  type ParsedTemplateEvent,
} from '../channels/services/whatsapp-template.util';

export interface ExistingRow {
  id: string;
  metaTemplateId: string;
  status: string;
}

export interface ReconcileResult {
  toInsert: MappedMetaTemplate[];
  toUpdate: Array<{ id: string; row: MappedMetaTemplate }>;
  toDeleteIds: string[];
}

/**
 * Diff what we have against what Meta returned.
 *
 * Pure and exported so the reconciliation rules — the part with real risk —
 * are testable without a database. Rows Meta no longer returns are deleted
 * outright rather than soft-deleted: Meta deletion is permanent, and keeping a
 * ghost row would offer a restore that cannot work.
 */
export function reconcile(
  existing: ExistingRow[],
  incoming: MappedMetaTemplate[],
): ReconcileResult {
  const byMetaId = new Map(existing.map((e) => [e.metaTemplateId, e]));
  const seen = new Set<string>();
  const toInsert: MappedMetaTemplate[] = [];
  const toUpdate: Array<{ id: string; row: MappedMetaTemplate }> = [];

  for (const row of incoming) {
    const match = byMetaId.get(row.metaTemplateId);
    if (match) {
      seen.add(match.id);
      toUpdate.push({ id: match.id, row });
    } else {
      toInsert.push(row);
    }
  }

  const toDeleteIds = existing.filter((e) => !seen.has(e.id)).map((e) => e.id);
  return { toInsert, toUpdate, toDeleteIds };
}

@Injectable()
export class WhatsAppTemplatesService {
  private readonly logger = new Logger(WhatsAppTemplatesService.name);

  constructor(
    private readonly whatsapp: WhatsAppService,
    private readonly channels: ChannelService,
  ) {}

  // syncWorkspace, applyStatusEvents, listForWorkspace, deleteTemplate below.
}
```

Then implement the four methods:

- **`listForWorkspace(workspaceId)`** — select all rows for the workspace, ordered by `name`.

- **`syncWorkspace(workspaceId, opts?: { force?: boolean })`** — find the workspace's active `whatsapp` channels; for each, read `metadata.wabaId` and the decrypted token; call `listMessageTemplates`; `mapMetaTemplateRow` each row; load existing rows for that `channelId`; `reconcile`; then apply inserts/updates/deletes in a transaction, stamping `lastSyncedAt: new Date()`. A channel whose Graph call throws is logged and skipped — one broken channel must not fail the whole sync.

  **Throttle.** The frontend syncs on every mount of the Library templates view, so a user clicking between views would hammer Meta. Skip a channel whose newest `lastSyncedAt` is under `SYNC_MIN_INTERVAL_MS` old unless `force` is set:

```ts
/** Fetch-on-load is a backstop for missed webhooks, not a live feed — once
 *  every few minutes per channel is ample, and Meta rate-limits per WABA. */
export const SYNC_MIN_INTERVAL_MS = 5 * 60 * 1000;

export function shouldSyncChannel(
  lastSyncedAt: Date | null,
  now: Date,
  force = false,
): boolean {
  if (force) return true;
  if (!lastSyncedAt) return true;
  return now.getTime() - lastSyncedAt.getTime() >= SYNC_MIN_INTERVAL_MS;
}
```

  Export `shouldSyncChannel` as a standalone pure function beside `reconcile` so it is testable without a clock. The explicit "Sync" button passes `force: true`; the automatic mount-time sync does not.

- **`applyStatusEvents(events)`** — for each event, update **every** row matching `(wabaId, metaTemplateId)` — plural on purpose: one WABA can be connected to two workspaces, and updating only the first is precisely the fan-out bug shipped before (`findChannelsByPlatformAccount`). Write `status`, `rejectionReason` (`reason === 'NONE' ? null : reason`), `category` when present, and `updatedAt`. An event matching no row is logged at debug and ignored — it may belong to a WABA we do not track.

- **`deleteTemplate(workspaceId, id)`** — load the row scoped to `workspaceId` (404 if absent), resolve the channel token, call `deleteMessageTemplate`, then delete the local row. Meta first: if Meta rejects, the local row must survive so the list does not lie.

Use the existing token-decryption helper on `ChannelService` — read `whatsapp-onboarding.service.ts` for how channels and tokens are resolved. Do not re-implement decryption.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/whatsapp-templates/whatsapp-templates.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Write the module**

```ts
import { Module } from '@nestjs/common';
import { ChannelsModule } from '../channels/channels.module';
import { WhatsAppTemplatesService } from './whatsapp-templates.service';
import { WhatsAppTemplatesController } from './whatsapp-templates.controller';

@Module({
  imports: [ChannelsModule],
  controllers: [WhatsAppTemplatesController],
  providers: [WhatsAppTemplatesService],
  exports: [WhatsAppTemplatesService],
})
export class WhatsAppTemplatesModule {}
```

The controller arrives in Task 5; create it as an empty class first if needed so this compiles, or write Task 5 before building.

**Watch for circular imports.** A 4-module cycle bit the team-invitations effort on cold boot. If `ChannelsModule` ends up importing this module back, use `forwardRef`.

- [ ] **Step 6: Commit**

```bash
git add src/whatsapp-templates/
git commit -m "feat(whatsapp): template sync service with reconcile + fan-out"
```

---

## Task 5: Endpoints

**Files:**
- Create: `src/whatsapp-templates/whatsapp-templates.controller.ts`
- Modify: `src/app.module.ts` (register `WhatsAppTemplatesModule`)

**Interfaces:**
- Consumes: `WhatsAppTemplatesService` (Task 4).
- Produces:
  - `GET  /workspaces/:workspaceId/whatsapp-templates` → `WhatsAppMessageTemplate[]`
  - `POST /workspaces/:workspaceId/whatsapp-templates/sync` → `{ synced: number }`
  - `DELETE /workspaces/:workspaceId/whatsapp-templates/:id` → 204

- [ ] **Step 1: Read an existing workspace-scoped controller**

Read the WhatsApp routes in `src/channels/channels.controller.ts` (around line 5925) for the exact guard and decorator stack: `@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)` plus `@RequireCapability(...)`.

- [ ] **Step 2: Write the controller**

```ts
import {
  Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { WorkspaceRoleGuard } from '../auth/guards/workspace-role.guard';
import { RequireCapability } from '../auth/decorators/require-capability.decorator';
import { WhatsAppTemplatesService } from './whatsapp-templates.service';

@Controller('workspaces/:workspaceId/whatsapp-templates')
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class WhatsAppTemplatesController {
  constructor(private readonly service: WhatsAppTemplatesService) {}

  @Get()
  @RequireCapability('channels:view')
  async list(@Param('workspaceId') workspaceId: string) {
    return this.service.listForWorkspace(workspaceId);
  }

  @Post('sync')
  @RequireCapability('channels:view')
  @HttpCode(HttpStatus.OK)
  async sync(@Param('workspaceId') workspaceId: string) {
    // Explicit user action — bypass the per-channel throttle.
    return this.service.syncWorkspace(workspaceId, { force: true });
  }

  @Delete(':id')
  @RequireCapability('channels:manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
  ) {
    await this.service.deleteTemplate(workspaceId, id);
  }
}
```

Verify `channels:view` and `channels:manage` exist in the capability map — read `src/auth/guards/workspace-role.guard.ts`. Use the real capability names; do not invent them.

**Do not bind a whole DTO object to `@Query()`.** The global `ValidationPipe` runs with `forbidNonWhitelisted: true`, and a whole-bag DTO makes every unlisted query key a 400. This exact bug shipped in the feedback effort. These endpoints take no query params — keep it that way.

- [ ] **Step 3: Register the module**

Add `WhatsAppTemplatesModule` to the `imports` array in `src/app.module.ts`.

- [ ] **Step 4: Verify it compiles and boots**

Run: `npm run build`
Expected: PASS.

Run: `npm run start:dev`
Expected: boots with no circular-dependency warning; the three routes appear in the route table. Stop the server after checking.

- [ ] **Step 5: Commit**

```bash
git add src/whatsapp-templates/ src/app.module.ts
git commit -m "feat(whatsapp): template list/sync/delete endpoints"
```

---

## Task 6: Webhook routing

**Files:**
- Modify: `src/channels/webhooks.controller.ts:176-222`

**Interfaces:**
- Consumes: `parseWhatsAppTemplateEvents` (Task 2), `WhatsAppTemplatesService.applyStatusEvents` (Task 4).
- Produces: nothing new.

**The ordering matters.** `POST /webhooks/whatsapp` currently checks for Maestro traffic and otherwise enqueues inbox ingest. Template events carry no `messages`, so they would fall through to inbox ingest and be silently dropped. Route them **first**.

- [ ] **Step 1: Add the template branch**

Inside the existing `try` block in `handleWhatsAppWebhook`, immediately after `res.status(200).send('EVENT_RECEIVED')` and **before** the `maestroPnid` check:

```ts
      // Template status updates carry no `messages`, so they would fall
      // through to inbox ingest and vanish. Handle them first and return.
      const templateEvents = parseWhatsAppTemplateEvents(req.body);
      if (templateEvents.length > 0) {
        try {
          await this.whatsappTemplates.applyStatusEvents(templateEvents);
        } catch (err) {
          this.logger.error(
            `WhatsApp template status update failed: ${(err as Error).message}`,
          );
        }
        return;
      }
```

Add the import and inject `WhatsAppTemplatesService` into the constructor.

- [ ] **Step 2: Verify it compiles and boots**

Run: `npm run build`
Expected: PASS.

Run: `npm run start:dev`
Expected: boots clean. If a circular dependency appears, wrap with `forwardRef`.

- [ ] **Step 3: Run the full backend suite**

Run: `npm test`
Expected: PASS. Inbox and Maestro tests must be unchanged — this is the guard on the shared webhook route.

- [ ] **Step 4: Commit**

```bash
git add src/channels/webhooks.controller.ts
git commit -m "feat(whatsapp): route template status webhooks before inbox ingest"
```

---

## Task 7: Inbox template send

**Files:**
- Modify: `src/inbox/adapters/whatsapp-dm.adapter.ts:130-152`

**Interfaces:**
- Consumes: `sendTemplate` (Task 3).
- Produces: `WhatsAppDmAdapter.sendTemplateDm(channel, conversationId, name, language, components?): Promise<CreatedDm>`

- [ ] **Step 1: Add the template send method**

Model it on the existing `sendDm` (same file, line 37) — same `phoneNumberId` and `toWaId` derivation:

```ts
  /**
   * Send an approved template. Valid outside the 24-hour window — this is what
   * reopens a conversation the customer has gone quiet on.
   */
  async sendTemplateDm(
    channel: ResolvedChannel,
    conversationId: string,
    name: string,
    language: string,
    components?: Array<Record<string, any>>,
  ): Promise<CreatedDm> {
    const phoneNumberId = String(
      channel.metadata?.phoneNumberId ?? channel.platformAccountId,
    );
    const toWaId = conversationId.slice(conversationId.lastIndexOf(':') + 1);
    const { messageId } = await this.whatsapp.sendTemplate(
      channel.accessToken,
      phoneNumberId,
      toWaId,
      name,
      language,
      components,
    );
    return {
      conversationId,
      platformItemId: messageId,
      text: `[template] ${name}`,
      platformCreatedAt: new Date(),
    };
  }
```

- [ ] **Step 2: Fix the dead-end copy**

In `getReplyWindowState`, replace:

```ts
          'The 24-hour reply window has closed. A pre-approved template is required (coming soon).',
```

with:

```ts
          'The 24-hour reply window has closed. Send an approved template to reopen the conversation.',
```

- [ ] **Step 3: Verify it compiles**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Run the inbox tests**

Run: `npx jest src/inbox`
Expected: PASS. If a test asserts the old "coming soon" string, update that assertion — the copy change is intentional.

- [ ] **Step 5: Commit**

```bash
git add src/inbox/adapters/whatsapp-dm.adapter.ts
git commit -m "feat(whatsapp): send approved templates from the inbox"
```

---

## Task 8: Frontend types + status tone mapping

**Files:**
- Create: `src/features/media-library/types/whatsapp-template.ts`
- Create: `src/features/media-library/types/whatsapp-template.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface WhatsAppTemplate { id: string; workspaceId: string; channelId: number; wabaId: string; metaTemplateId: string; name: string; language: string; category; status: string; rejectionReason: string | null; components; lastSyncedAt: string | null; createdAt: string; updatedAt: string }`
  - `type WhatsAppTemplateTone = 'approved' | 'pending' | 'blocked' | 'neutral'`
  - `toneForStatus(status: string): WhatsAppTemplateTone`
  - `isSendable(status: string): boolean`
  - `rejectionReasonLabel(reason: string | null): string | null`

- [ ] **Step 1: Write the failing tests**

```ts
import {
  toneForStatus, isSendable, rejectionReasonLabel,
} from './whatsapp-template'

describe('toneForStatus', () => {
  it.each(['APPROVED', 'REINSTATED'])('%s is approved', (s) => {
    expect(toneForStatus(s)).toBe('approved')
  })

  it.each(['PENDING', 'IN_APPEAL', 'PENDING_DELETION'])(
    '%s is pending', (s) => { expect(toneForStatus(s)).toBe('pending') },
  )

  it.each([
    'REJECTED', 'DISABLED', 'PAUSED', 'FLAGGED', 'LIMIT_EXCEEDED', 'LOCKED',
  ])('%s is blocked', (s) => { expect(toneForStatus(s)).toBe('blocked') })

  it.each(['ARCHIVED', 'UNARCHIVED', 'DELETED'])('%s is neutral', (s) => {
    expect(toneForStatus(s)).toBe('neutral')
  })

  it('falls back to neutral for a status Meta adds later', () => {
    // Never blank: an unknown status must still render a badge.
    expect(toneForStatus('SOME_FUTURE_STATUS')).toBe('neutral')
    expect(toneForStatus('')).toBe('neutral')
  })

  it('covers all 14 documented statuses', () => {
    const all = [
      'APPROVED', 'PENDING', 'REJECTED', 'PAUSED', 'DISABLED', 'FLAGGED',
      'ARCHIVED', 'UNARCHIVED', 'DELETED', 'IN_APPEAL', 'LIMIT_EXCEEDED',
      'LOCKED', 'REINSTATED', 'PENDING_DELETION',
    ]
    for (const s of all) {
      expect(['approved', 'pending', 'blocked', 'neutral'])
        .toContain(toneForStatus(s))
    }
  })
})

describe('isSendable', () => {
  it('allows only APPROVED', () => {
    expect(isSendable('APPROVED')).toBe(true)
  })

  it.each([
    'PENDING', 'REJECTED', 'PAUSED', 'DISABLED', 'FLAGGED', 'ARCHIVED',
    'UNARCHIVED', 'DELETED', 'IN_APPEAL', 'LIMIT_EXCEEDED', 'LOCKED',
    'REINSTATED', 'PENDING_DELETION', 'SOMETHING_NEW',
  ])('rejects %s', (s) => { expect(isSendable(s)).toBe(false) })
})

describe('rejectionReasonLabel', () => {
  it('humanizes a known reason', () => {
    expect(rejectionReasonLabel('INCORRECT_CATEGORY'))
      .toBe('Wrong category for this content')
  })

  it('returns null for NONE and null', () => {
    expect(rejectionReasonLabel('NONE')).toBeNull()
    expect(rejectionReasonLabel(null)).toBeNull()
  })

  it('falls back to the raw value for an unknown reason', () => {
    expect(rejectionReasonLabel('BRAND_NEW_REASON')).toBe('BRAND_NEW_REASON')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/features/media-library/types/whatsapp-template.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
export interface WhatsAppTemplateComponent {
  type: 'HEADER' | 'BODY' | 'FOOTER' | 'BUTTONS'
  format?: 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT' | 'LOCATION'
  text?: string
  buttons?: Array<Record<string, unknown>>
  example?: Record<string, unknown>
}

export interface WhatsAppTemplate {
  id: string
  workspaceId: string
  /** bigserial on the backend — arrives as a number, not a uuid string. */
  channelId: number
  wabaId: string
  metaTemplateId: string
  name: string
  language: string
  /** Meta's returned category — it can differ from what was requested. */
  category: 'MARKETING' | 'UTILITY' | 'AUTHENTICATION'
  status: string
  rejectionReason: string | null
  components: WhatsAppTemplateComponent[]
  lastSyncedAt: string | null
  createdAt: string
  updatedAt: string
}

export type WhatsAppTemplateTone =
  | 'approved' | 'pending' | 'blocked' | 'neutral'

const TONE_BY_STATUS: Record<string, WhatsAppTemplateTone> = {
  APPROVED: 'approved',
  REINSTATED: 'approved',
  PENDING: 'pending',
  IN_APPEAL: 'pending',
  PENDING_DELETION: 'pending',
  REJECTED: 'blocked',
  DISABLED: 'blocked',
  PAUSED: 'blocked',
  FLAGGED: 'blocked',
  LIMIT_EXCEEDED: 'blocked',
  LOCKED: 'blocked',
  ARCHIVED: 'neutral',
  UNARCHIVED: 'neutral',
  DELETED: 'neutral',
}

/** Meta documents 14 statuses and may add more, so an unrecognized value
 *  falls back to neutral rather than rendering an empty badge. */
export function toneForStatus(status: string): WhatsAppTemplateTone {
  return TONE_BY_STATUS[status] ?? 'neutral'
}

/** Only APPROVED templates can actually be sent. */
export function isSendable(status: string): boolean {
  return status === 'APPROVED'
}

const REASON_LABELS: Record<string, string> = {
  ABUSIVE_CONTENT: 'Content breaks WhatsApp policy',
  CATEGORY_NOT_AVAILABLE: 'That category is unavailable for this account',
  INCORRECT_CATEGORY: 'Wrong category for this content',
  INVALID_FORMAT: 'Formatting or variables are invalid',
  PROMOTIONAL: 'Too promotional for a utility template',
  SCAM: 'Flagged as a scam',
  TAG_CONTENT_MISMATCH: "Content does not match the template's tag",
}

export function rejectionReasonLabel(reason: string | null): string | null {
  if (!reason || reason === 'NONE') return null
  return REASON_LABELS[reason] ?? reason
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/features/media-library/types/whatsapp-template.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/media-library/types/whatsapp-template.ts src/features/media-library/types/whatsapp-template.test.ts
git commit -m "feat(whatsapp): template types + status tone mapping"
```

---

## Task 9: Frontend API + hooks

**Files:**
- Create: `src/features/media-library/api/whatsapp-templates.api.ts`
- Create: `src/features/media-library/hooks/use-whatsapp-templates.ts`

**Interfaces:**
- Consumes: `WhatsAppTemplate` (Task 8); backend endpoints (Task 5).
- Produces:
  - `whatsappTemplatesApi.list(workspaceId)`, `.sync(workspaceId)`, `.remove(workspaceId, id)`
  - `useWhatsAppTemplates(workspaceId)` → `{ templates, isLoading, isError }`
  - `useSyncWhatsAppTemplates(workspaceId)`, `useDeleteWhatsAppTemplate(workspaceId)`

- [ ] **Step 1: Write the API wrapper**

Follow `media-library.api.ts` exactly — same `apiClient` import, same `base()` shape.

```ts
import { apiClient } from '@/lib/api'
import type { WhatsAppTemplate } from '../types/whatsapp-template'

function base(workspaceId: string): string {
  return `/workspaces/${workspaceId}/whatsapp-templates`
}

export const whatsappTemplatesApi = {
  list: (workspaceId: string) =>
    apiClient.get<WhatsAppTemplate[]>(base(workspaceId)),

  /** Pull the latest from Meta. Returns how many templates were reconciled. */
  sync: (workspaceId: string) =>
    apiClient.post<{ synced: number }>(`${base(workspaceId)}/sync`),

  /** Permanent at Meta — there is no recycle bin. */
  remove: (workspaceId: string, id: string) =>
    apiClient.delete<void>(`${base(workspaceId)}/${id}`),
}
```

- [ ] **Step 2: Write the hooks**

Follow `use-template-mutations.ts` — same `LIBRARY_KEY` invalidation style, same toast usage.

```ts
import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { whatsappTemplatesApi } from '../api/whatsapp-templates.api'

const WA_TEMPLATES_KEY = ['whatsapp-templates'] as const

/**
 * List the workspace's WhatsApp templates, and reconcile with Meta once on
 * mount.
 *
 * The sync is the backstop, not the primary path: status changes normally
 * arrive by webhook. Meta's review can take up to 24 hours, so a user who
 * leaves the page open would otherwise never see PENDING turn APPROVED.
 */
export function useWhatsAppTemplates(workspaceId: string | undefined) {
  const queryClient = useQueryClient()

  const q = useQuery({
    queryKey: [...WA_TEMPLATES_KEY, workspaceId],
    queryFn: () => whatsappTemplatesApi.list(workspaceId as string),
    enabled: !!workspaceId,
  })

  useEffect(() => {
    if (!workspaceId) return
    let cancelled = false
    whatsappTemplatesApi
      .sync(workspaceId)
      .then(() => {
        if (cancelled) return
        void queryClient.invalidateQueries({
          queryKey: [...WA_TEMPLATES_KEY, workspaceId],
        })
      })
      // Silent: the cached list still renders, and a sync failure is not
      // something the user asked for or can act on.
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [workspaceId, queryClient])

  return {
    templates: q.data ?? [],
    isLoading: q.isLoading,
    isError: q.isError,
  }
}

export function useSyncWhatsAppTemplates(workspaceId: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => whatsappTemplatesApi.sync(workspaceId as string),
    onSuccess: async (res) => {
      await queryClient.invalidateQueries({
        queryKey: [...WA_TEMPLATES_KEY, workspaceId],
      })
      toast.success(`Synced ${res.synced} template${res.synced === 1 ? '' : 's'}`)
    },
    onError: (err: Error) => {
      toast.error(err.message || 'Could not sync templates')
    },
  })
}

export function useDeleteWhatsAppTemplate(workspaceId: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      whatsappTemplatesApi.remove(workspaceId as string, id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: [...WA_TEMPLATES_KEY, workspaceId],
      })
      toast.success('Template deleted from WhatsApp')
    },
    onError: (err: Error) => {
      toast.error(err.message || 'Could not delete the template')
    },
  })
}
```

Verify `apiClient` exposes `get`/`post`/`delete` with these signatures, and that `sonner`'s `toast` is the toast used in this codebase — read `use-template-mutations.ts` and copy its imports.

- [ ] **Step 3: Verify it compiles**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/features/media-library/api/whatsapp-templates.api.ts src/features/media-library/hooks/use-whatsapp-templates.ts
git commit -m "feat(whatsapp): template API wrappers + query hooks"
```

---

## Task 10: The WhatsApp card variant

**Files:**
- Create: `src/features/media-library/components/items/whatsapp-template-card.tsx`
- Modify: `src/features/media-library/components/items/template-card-grid.tsx`

**Interfaces:**
- Consumes: `WhatsAppTemplate`, `toneForStatus`, `isSendable`, `rejectionReasonLabel` (Task 8).
- Produces:
  - `WhatsAppTemplateCard` component
  - `TemplateCardGrid` accepting `whatsappTemplates?: WhatsAppTemplate[]` alongside `templates`

**Shadcn rule:** every visual element must come from shadcn. Use the MCP (`mcp__shadcn__*`) before reaching for any component — do not hand-roll a badge or dialog. `Badge`, `AlertDialog`, `DropdownMenu`, and `Button` are the likely set; confirm each is installed (`src/components/ui/`) and install via `mcp__shadcn__get_add_command_for_items` if not.

**Theme tokens only** — no `bg-green-500`. Use `bg-success`, `bg-warning`, `bg-destructive`, `bg-muted` and their `text-*` pairs. Confirm these tokens exist in `src/index.css`; `--warning` was verified during the feedback effort.

- [ ] **Step 1: Write the card**

Requirements:
- Name, language, and Meta's category
- Status badge tinted by `toneForStatus`. **Every status renders a badge** — unknown ones show the raw string in the neutral tone
- A `blocked` card with a `rejectionReason` shows `rejectionReasonLabel(...)` beneath the badge
- BODY component text as the preview
- Actions: **View** (dialog), **Send in inbox** (only when `isSendable`), **Delete**
- No Star, no Duplicate, no Use-in-post — those are meaningless here
- Delete opens an `AlertDialog` reading: *"Delete "{name}"? This removes it from WhatsApp permanently. It will not go to the recycle bin and cannot be restored."*

- [ ] **Step 2: Widen the grid**

`TemplateCardGrid` keeps its current props and gains one:

```tsx
interface TemplateCardGridProps {
  templates: MediaTemplate[]
  /** WhatsApp templates render as their own card variant: they live on the
   *  customer's WABA, so starring, duplicating, and "use in post" do not
   *  apply to them. */
  whatsappTemplates?: WhatsAppTemplate[]
  onOpen: (id: string) => void
  onToggleStar: (id: string) => void
  onDelete: (id: string) => void
  onDuplicate?: (id: string) => void
  onUseInPost?: (id: string) => void
  onDeleteWhatsApp?: (id: string) => void
  onSendWhatsApp?: (id: string) => void
}
```

Render existing `TemplateCard`s first, then `WhatsAppTemplateCard`s, in the same grid container. **Both existing call sites keep working untouched** — `whatsappTemplates` is optional.

Update the early return: `if (templates.length === 0 && !whatsappTemplates?.length) return null`.

- [ ] **Step 3: Verify both call sites still compile**

Run: `npm run build`
Expected: PASS. `starred-view.tsx:358` and `type-view.tsx:622` must compile without edits.

- [ ] **Step 4: Commit**

```bash
git add src/features/media-library/components/items/
git commit -m "feat(whatsapp): WhatsApp template card variant in the library grid"
```

---

## Task 11: Wire the Library view

**Files:**
- Modify: `src/features/media-library/components/type-view/type-view.tsx:615-645`

**Interfaces:**
- Consumes: `useWhatsAppTemplates`, `useDeleteWhatsAppTemplate` (Task 9); the widened grid (Task 10).
- Produces: nothing new.

- [ ] **Step 1: Feed WhatsApp templates into the grid**

In the `type === 'template'` branch, call `useWhatsAppTemplates(workspaceId)` and pass `whatsappTemplates` plus `onDeleteWhatsApp` to `TemplateCardGrid`.

- [ ] **Step 2: Fix the empty state**

The current copy is `'No templates yet.'`. It must not appear when only WhatsApp templates exist. Gate on both lists being empty.

- [ ] **Step 3: Loading state**

WhatsApp templates load independently. Reuse the existing `CardGridSkeleton` while either list is loading — do not let the grid flash empty.

- [ ] **Step 4: Verify**

Run: `npm run build`
Expected: PASS.

Run: `npm run dev`, open the Library → Templates. Expected: post templates render as before; WhatsApp templates render alongside with status badges. Check at 375px width — cards must not be cramped.

- [ ] **Step 5: Commit**

```bash
git add src/features/media-library/components/type-view/type-view.tsx
git commit -m "feat(whatsapp): show WhatsApp templates in the library"
```

---

## Task 12: Inbox picker

**Files:**
- Create: `src/features/inbox/components/whatsapp-template-picker.tsx`
- Modify: the inbox composer that renders the closed-window notice

**Interfaces:**
- Consumes: `useWhatsAppTemplates` (Task 9), `isSendable` (Task 8), the backend send path (Task 7).
- Produces: `WhatsAppTemplatePicker` component.

- [ ] **Step 1: Find the closed-window UI**

Search the inbox feature for where `canReply === false` and `reason` are rendered. That is the insertion point.

- [ ] **Step 2: Build the picker**

- Lists **only** templates where `isSendable(status)` — a `PENDING` template in a send list would fail at Meta
- Each row: name, language, BODY preview
- Empty state: *"No approved templates yet. Create one in the Library to reopen conversations after 24 hours."* with a link to the Library — never a bare "No data"
- Loading: skeleton. Error: inline message
- Uses shadcn (`Dialog` or `Popover` + `Command`), confirmed via MCP

- [ ] **Step 3: Wire the send**

On select, call the backend send path from Task 7 and refresh the conversation.

**Templates with variables are out of scope for Phase 1.** If the chosen template's BODY contains `{{1}}`, the send needs component parameters. Send only templates with no variables; disable the rest with a tooltip reading *"This template needs variables — coming with the builder."* This keeps Phase 1 honest instead of failing at Meta.

- [ ] **Step 4: Verify**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/inbox/
git commit -m "feat(whatsapp): approved-template picker in the inbox"
```

---

## Task 13: Full verification

**Files:** none.

- [ ] **Step 1: Backend suite**

Run: `npm test` in `socialmedia-workspace`
Expected: PASS, all green. Compare the count against `main` — no pre-existing test may have been weakened.

- [ ] **Step 2: Backend build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Frontend suite**

Run: `npm test` in `socialmedia-frontend`
Expected: PASS.

- [ ] **Step 4: Frontend build**

Run: `npm run build`
Expected: PASS (`tsc -b && vite build`).

- [ ] **Step 5: Confirm `media_templates` was never touched**

Run: `git diff main --stat -- src/drizzle/schema/media-library.schema.ts`
Expected: **empty output.** Any diff violates a global constraint.

- [ ] **Step 6: Confirm `parseWhatsAppMessages` was never touched**

Run: `git diff main -- src/channels/services/whatsapp-webhook.util.ts`
Expected: **empty output.**

- [ ] **Step 7: Migration SQL for production**

Print the migration for the user to run via Railway → Postgres → Console → `psql $DATABASE_URL`. Do **not** run it — the user applies production SQL themselves.

---

## Manual verification (user, after deploy)

Automated tests cannot reach Meta. These checks must be done by hand:

1. Library → Templates shows the real WhatsApp templates from WhatsApp Manager
2. A template `PENDING` at Meta shows an amber badge; when Meta approves it, the badge turns green **without a page reload** — this proves the webhook path
3. Delete shows the permanence warning, and the template is gone from WhatsApp Manager afterwards
4. A conversation older than 24 hours offers the template picker instead of the old "coming soon" text
5. Sending an approved template actually reaches the customer's phone
6. Only `APPROVED` templates appear in the picker
7. 375px viewport: cards and picker are not cramped

## Deferred to Phase 2

- Template builder (create/edit) with components and variables
- Templates with variables in the inbox picker (Task 12 disables them)
- Category selection and sample values
- Template analytics and quality rating
