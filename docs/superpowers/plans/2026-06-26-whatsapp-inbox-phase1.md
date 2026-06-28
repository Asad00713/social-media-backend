# WhatsApp Inbox (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a workspace connect a WhatsApp Business (Cloud API) number so customer messages — including those started from Click-to-WhatsApp ads — land in the existing inbox as DM conversations, with two-way free-form reply inside WhatsApp's 24-hour service window.

**Architecture:** WhatsApp is added as a new `platform = 'whatsapp'` DM channel. Ingestion is **push-only via Meta webhooks** (the Cloud API exposes no read API for past messages), normalized and persisted through the existing `InboxService.upsertDm()` + realtime emitter — identical to the Meta Messenger/IG-Direct path. Outbound replies go through a thin `WhatsAppService` (Graph API `POST /{phone_number_id}/messages`) wrapped in a `WhatsAppDmAdapter` that implements the existing `PlatformDmAdapter`. Onboarding in Phase 1 is **manual** (paste `phone_number_id` + `waba_id` + a long-lived/system-user token); Embedded Signup is Phase 2.

**Tech Stack:** NestJS, Drizzle (node-postgres), BullMQ (Redis), Meta WhatsApp Cloud API v21.0, Jest.

## Global Constraints

- Graph API base: `https://graph.facebook.com/v21.0` (match existing `meta-ads.client.ts`).
- Meta requires webhook endpoints to **200 within ~5s**; all heavy work is async (mirror `processMetaWebhook` — ACK first, then process).
- Webhook auth: GET verification via `META_WEBHOOK_VERIFY_TOKEN` (existing) **plus** POST body signature via `X-Hub-Signature-256` (HMAC-SHA256 keyed by the Meta **App Secret**, env `META_APP_SECRET`). Never disable signature verification.
- 24-hour rule: free-form replies are only allowed within 24h of the customer's last inbound message; outside it requires an approved template (Phase 2). Phase 1 must **block** out-of-window free-form sends with a clear error, not silently fail.
- Tokens stored encrypted via the existing channel token columns (`ChannelService` handles crypto); `phone_number_id` / `waba_id` / `display_phone_number` live in `socialMediaChannels.metadata` jsonb.
- No DB migration for `platform` (it is `varchar`, not a PG enum) — adding `'whatsapp'` is a TypeScript-union + config change only.
- Phase 1 scope: **text messages only**, inbound + outbound, manual connect. OUT OF SCOPE (Phase 2): media messages, message templates / business-initiated sends, Embedded Signup, WhatsApp notifications.

---

### Task 1: Register the `whatsapp` platform + queue

**Files:**
- Modify: `src/drizzle/schema/channels.schema.ts` (the `SupportedPlatform` union ~lines 19-42, and `PLATFORM_CONFIG` ~lines 560-580)
- Modify: `src/drizzle/schema/inbox.schema.ts` (the platform doc/union ~lines 1-40 — wherever the comment enumerates supported platforms; the column is `varchar` so only the TS `SupportedPlatform` reference matters)
- Modify: `src/queue/queue.module.ts:7-20` and `:58-71`

**Interfaces:**
- Produces: `'whatsapp'` is a valid `SupportedPlatform`; `QUEUES.WHATSAPP_INGEST = 'whatsapp-ingest'` registered.

- [ ] **Step 1: Add `'whatsapp'` to the platform union.** In `channels.schema.ts`, add `| 'whatsapp'` to the `SupportedPlatform` union (place it next to `'telegram'`/`'discord'`).

- [ ] **Step 2: Add the `whatsapp` PLATFORM_CONFIG entry.** Mirror the existing `reddit`/`telegram` entry shape:

```typescript
whatsapp: {
  name: 'WhatsApp',
  accountTypes: ['business_account'],
  supportsRefreshToken: false, // long-lived / system-user token; no OAuth refresh in Phase 1
  tokenExpirationDays: null,
  refreshTokenTtlDays: null,
  maxMediaPerPost: 0,          // not a publishing channel
  maxTextLength: 4096,         // WhatsApp text body limit
  supportedMediaTypes: [],
  oauthScopes: ['whatsapp_business_messaging', 'whatsapp_business_management'],
},
```

- [ ] **Step 3: Register the queue.** In `queue.module.ts`, add `WHATSAPP_INGEST: 'whatsapp-ingest',` to the `QUEUES` object and `{ name: QUEUES.WHATSAPP_INGEST },` to `BullModule.registerQueue(...)`.

- [ ] **Step 4: Verify it compiles.**

Run: `npm run build`
Expected: PASS (no TS errors from the new union member).

- [ ] **Step 5: Commit.**

```bash
git add src/drizzle/schema/channels.schema.ts src/drizzle/schema/inbox.schema.ts src/queue/queue.module.ts
git commit -m "feat(whatsapp): register whatsapp platform + ingest queue"
```

---

### Task 2: Meta `X-Hub-Signature-256` verifier

**Files:**
- Modify: `src/common/utils/webhook-signature.util.ts`
- Test: `src/common/utils/webhook-signature.util.spec.ts` (create if absent)

**Interfaces:**
- Produces: `verifyMetaSignature({ appSecret: string, signatureHeader: string | undefined, rawBody: string | Buffer }): boolean`

- [ ] **Step 1: Write the failing test.**

```typescript
import { createHmac } from 'node:crypto';
import { verifyMetaSignature } from './webhook-signature.util';

describe('verifyMetaSignature', () => {
  const appSecret = 'test_app_secret';
  const rawBody = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
  const goodSig =
    'sha256=' + createHmac('sha256', appSecret).update(rawBody).digest('hex');

  it('accepts a valid signature', () => {
    expect(verifyMetaSignature({ appSecret, signatureHeader: goodSig, rawBody })).toBe(true);
  });
  it('rejects a tampered body', () => {
    expect(
      verifyMetaSignature({ appSecret, signatureHeader: goodSig, rawBody: rawBody + 'x' }),
    ).toBe(false);
  });
  it('rejects a missing/garbage header', () => {
    expect(verifyMetaSignature({ appSecret, signatureHeader: undefined, rawBody })).toBe(false);
    expect(verifyMetaSignature({ appSecret, signatureHeader: 'nope', rawBody })).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails.**

Run: `npm run test -- webhook-signature`
Expected: FAIL with "verifyMetaSignature is not a function".

- [ ] **Step 3: Implement `verifyMetaSignature`.** Append to `webhook-signature.util.ts`:

```typescript
/**
 * Meta webhook signature verification (WhatsApp / Messenger / IG).
 * Meta signs the raw request body with HMAC-SHA256 keyed by the App Secret and
 * sends `X-Hub-Signature-256: sha256=<hex>`. Uses timing-safe comparison.
 */
export function verifyMetaSignature(opts: {
  appSecret: string;
  signatureHeader: string | undefined;
  rawBody: string | Buffer;
}): boolean {
  const { appSecret, signatureHeader, rawBody } = opts;
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;

  const expected =
    'sha256=' + createHmac('sha256', appSecret).update(rawBody).digest('hex');

  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
```

- [ ] **Step 4: Run the test to confirm it passes.**

Run: `npm run test -- webhook-signature`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit.**

```bash
git add src/common/utils/webhook-signature.util.ts src/common/utils/webhook-signature.util.spec.ts
git commit -m "feat(whatsapp): add Meta X-Hub-Signature-256 verifier"
```

---

### Task 3: `WhatsAppService` — Cloud API send + helpers

**Files:**
- Create: `src/channels/services/whatsapp.service.ts`
- Test: `src/channels/services/whatsapp.service.spec.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `WhatsAppService.sendText(accessToken: string, phoneNumberId: string, toWaId: string, text: string): Promise<{ messageId: string }>`
  - `WhatsAppService.markRead(accessToken: string, phoneNumberId: string, messageId: string): Promise<void>` (best-effort; swallows errors)
  - Constant `WHATSAPP_GRAPH_BASE = 'https://graph.facebook.com/v21.0'`

- [ ] **Step 1: Write the failing test** (mock `fetch`):

```typescript
import { WhatsAppService } from './whatsapp.service';

describe('WhatsAppService.sendText', () => {
  const svc = new WhatsAppService();
  afterEach(() => jest.restoreAllMocks());

  it('POSTs a text message and returns the message id', async () => {
    const fetchMock = jest.spyOn(global, 'fetch' as any).mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [{ id: 'wamid.ABC' }] }),
    } as any);

    const res = await svc.sendText('tok', '1010', '15551234567', 'hi');

    expect(res).toEqual({ messageId: 'wamid.ABC' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://graph.facebook.com/v21.0/1010/messages');
    expect((init as any).method).toBe('POST');
    expect(JSON.parse((init as any).body)).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '15551234567',
      type: 'text',
      text: { body: 'hi', preview_url: false },
    });
    expect((init as any).headers.Authorization).toBe('Bearer tok');
  });

  it('throws with the Graph error message on failure', async () => {
    jest.spyOn(global, 'fetch' as any).mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'Recipient not in allowed list' } }),
    } as any);
    await expect(svc.sendText('tok', '1010', '999', 'hi')).rejects.toThrow(
      'Recipient not in allowed list',
    );
  });
});
```

- [ ] **Step 2: Run it to confirm it fails.**

Run: `npm run test -- whatsapp.service`
Expected: FAIL ("Cannot find module './whatsapp.service'").

- [ ] **Step 3: Implement `WhatsAppService`.**

```typescript
import { Injectable, Logger } from '@nestjs/common';

export const WHATSAPP_GRAPH_BASE = 'https://graph.facebook.com/v21.0';

@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);

  /** Send a plain text message. Only valid inside the 24h customer window. */
  async sendText(
    accessToken: string,
    phoneNumberId: string,
    toWaId: string,
    text: string,
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
        type: 'text',
        text: { body: text, preview_url: false },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data?.error?.message || `WhatsApp send failed (${res.status})`;
      throw new Error(msg);
    }
    return { messageId: data?.messages?.[0]?.id ?? '' };
  }

  /** Mark an inbound message read (blue ticks). Best-effort. */
  async markRead(
    accessToken: string,
    phoneNumberId: string,
    messageId: string,
  ): Promise<void> {
    try {
      await fetch(`${WHATSAPP_GRAPH_BASE}/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          status: 'read',
          message_id: messageId,
        }),
      });
    } catch (err) {
      this.logger.warn(`markRead failed: ${(err as Error).message}`);
    }
  }
}
```

- [ ] **Step 4: Run the test to confirm it passes.**

Run: `npm run test -- whatsapp.service`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit.**

```bash
git add src/channels/services/whatsapp.service.ts src/channels/services/whatsapp.service.spec.ts
git commit -m "feat(whatsapp): WhatsAppService Cloud API send + markRead"
```

---

### Task 4: `WhatsAppDmAdapter` (implements `PlatformDmAdapter`)

**Files:**
- Create: `src/inbox/adapters/whatsapp-dm.adapter.ts`
- Test: `src/inbox/adapters/whatsapp-dm.adapter.spec.ts`

**Interfaces:**
- Consumes: `WhatsAppService` (Task 3); `PlatformDmAdapter`, `ResolvedChannel`, `CreatedDm`, `DmConversationSummary`, `FetchedDm` from `inbox-adapter.interface.ts`.
- Produces: `WhatsAppDmAdapter` with `platform = 'whatsapp'`. `conversationId` convention = `<phoneNumberId>:<customerWaId>`. The customer wa_id is parsed as the part after the last `:`.

**Design notes:**
- WhatsApp Cloud API has **no read API** for history → `listConversations()` and `fetchConversationMessages()` return `[]` (ingestion is webhook-only).
- `getReplyWindowState()` enforces the 24h window from `lastIncomingAt`.
- `sendDm()` parses the recipient wa_id from `conversationId` and calls `WhatsAppService.sendText`. `phoneNumberId` comes from `channel.metadata.phoneNumberId`.

- [ ] **Step 1: Write the failing test.**

```typescript
import { WhatsAppDmAdapter } from './whatsapp-dm.adapter';
import type { ResolvedChannel } from './inbox-adapter.interface';

const channel = (): ResolvedChannel => ({
  id: 1,
  workspaceId: 'ws',
  platform: 'whatsapp',
  platformAccountId: '1010',
  accessToken: 'tok',
  metadata: { phoneNumberId: '1010' },
  username: null,
  accountName: 'My Biz',
  profilePictureUrl: null,
});

describe('WhatsAppDmAdapter', () => {
  it('sends to the wa_id parsed from conversationId', async () => {
    const wa = { sendText: jest.fn().mockResolvedValue({ messageId: 'wamid.X' }) } as any;
    const adapter = new WhatsAppDmAdapter(wa);
    const res = await adapter.sendDm(channel(), '1010:15551234567', 'hello');
    expect(wa.sendText).toHaveBeenCalledWith('tok', '1010', '15551234567', 'hello');
    expect(res.conversationId).toBe('1010:15551234567');
    expect(res.platformItemId).toBe('wamid.X');
  });

  it('reports the 24h window closed when last inbound > 24h ago', async () => {
    const adapter = new WhatsAppDmAdapter({} as any);
    const old = new Date(Date.now() - 25 * 3600 * 1000);
    const state = await adapter.getReplyWindowState(channel(), '1010:999', old);
    expect(state.canReply).toBe(false);
  });

  it('reports the window open within 24h', async () => {
    const adapter = new WhatsAppDmAdapter({} as any);
    const recent = new Date(Date.now() - 1000);
    const state = await adapter.getReplyWindowState(channel(), '1010:999', recent);
    expect(state.canReply).toBe(true);
  });

  it('has no readable history (push-only)', async () => {
    const adapter = new WhatsAppDmAdapter({} as any);
    expect(await adapter.listConversations(channel())).toEqual([]);
    expect(await adapter.fetchConversationMessages(channel(), '1010:999')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails.**

Run: `npm run test -- whatsapp-dm.adapter`
Expected: FAIL ("Cannot find module './whatsapp-dm.adapter'").

- [ ] **Step 3: Implement the adapter.**

```typescript
import { Injectable } from '@nestjs/common';
import { WhatsAppService } from '../../channels/services/whatsapp.service';
import type {
  PlatformDmAdapter,
  ResolvedChannel,
  DmConversationSummary,
  FetchedDm,
  CreatedDm,
} from './inbox-adapter.interface';

const WINDOW_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class WhatsAppDmAdapter implements PlatformDmAdapter {
  readonly platform = 'whatsapp' as const;

  constructor(private readonly whatsapp: WhatsAppService) {}

  /** No read API — WhatsApp history is delivered by webhook only. */
  async listConversations(): Promise<DmConversationSummary[]> {
    return [];
  }

  /** No read API — see listConversations. */
  async fetchConversationMessages(): Promise<FetchedDm[]> {
    return [];
  }

  async sendDm(
    channel: ResolvedChannel,
    conversationId: string,
    text: string,
  ): Promise<CreatedDm> {
    const phoneNumberId = String(channel.metadata?.phoneNumberId ?? channel.platformAccountId);
    const toWaId = conversationId.slice(conversationId.lastIndexOf(':') + 1);
    const { messageId } = await this.whatsapp.sendText(
      channel.accessToken,
      phoneNumberId,
      toWaId,
      text,
    );
    return {
      conversationId,
      platformItemId: messageId,
      text,
      platformCreatedAt: new Date(),
    };
  }

  async getReplyWindowState(
    _channel: ResolvedChannel,
    _conversationId: string,
    lastIncomingAt: Date | null,
  ): Promise<{ canReply: boolean; reason?: string; windowExpiresAt?: Date }> {
    if (!lastIncomingAt) {
      return {
        canReply: false,
        reason:
          'WhatsApp lets you reply only after the customer messages first (24h window).',
      };
    }
    const expires = new Date(lastIncomingAt.getTime() + WINDOW_MS);
    if (Date.now() > expires.getTime()) {
      return {
        canReply: false,
        reason:
          'The 24-hour reply window has closed. A pre-approved template is required (coming soon).',
        windowExpiresAt: expires,
      };
    }
    return { canReply: true, windowExpiresAt: expires };
  }
}
```

- [ ] **Step 4: Run the test to confirm it passes.**

Run: `npm run test -- whatsapp-dm.adapter`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit.**

```bash
git add src/inbox/adapters/whatsapp-dm.adapter.ts src/inbox/adapters/whatsapp-dm.adapter.spec.ts
git commit -m "feat(whatsapp): WhatsAppDmAdapter (send + 24h window, push-only history)"
```

---

### Task 5: Webhook payload normalizer (pure function)

**Files:**
- Create: `src/channels/services/whatsapp-webhook.util.ts`
- Test: `src/channels/services/whatsapp-webhook.util.spec.ts`

**Interfaces:**
- Produces: `parseWhatsAppMessages(payload: any): ParsedWhatsAppMessage[]` where

```typescript
export interface ParsedWhatsAppMessage {
  phoneNumberId: string;     // entry.changes[].value.metadata.phone_number_id (our number)
  fromWaId: string;          // customer's wa_id (messages[].from)
  messageId: string;         // messages[].id (wamid...)
  text: string;              // messages[].text.body ('' for non-text in Phase 1)
  timestamp: Date;           // from messages[].timestamp (unix seconds)
  authorName?: string;       // contacts[].profile.name
  isText: boolean;           // false for media/system/status events (skip in Phase 1)
  referral?: Record<string, any>; // messages[].referral (Click-to-WhatsApp ad context)
}
```

- [ ] **Step 1: Write the failing test** with a real WhatsApp inbound text payload:

```typescript
import { parseWhatsAppMessages } from './whatsapp-webhook.util';

const payload = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'WABA_ID',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '15550000000', phone_number_id: '1010' },
            contacts: [{ profile: { name: 'Asad' }, wa_id: '15551234567' }],
            messages: [
              {
                from: '15551234567',
                id: 'wamid.HBgL',
                timestamp: '1719400000',
                type: 'text',
                text: { body: 'Hi, is this available?' },
                referral: { source_type: 'ad', source_id: 'AD123' },
              },
            ],
          },
        },
      ],
    },
  ],
};

describe('parseWhatsAppMessages', () => {
  it('extracts a text message with author + ad referral', () => {
    const [m] = parseWhatsAppMessages(payload);
    expect(m.phoneNumberId).toBe('1010');
    expect(m.fromWaId).toBe('15551234567');
    expect(m.messageId).toBe('wamid.HBgL');
    expect(m.text).toBe('Hi, is this available?');
    expect(m.authorName).toBe('Asad');
    expect(m.isText).toBe(true);
    expect(m.timestamp.getTime()).toBe(1719400000 * 1000);
    expect(m.referral?.source_id).toBe('AD123');
  });

  it('marks non-text (e.g. image) as isText=false', () => {
    const img = JSON.parse(JSON.stringify(payload));
    img.entry[0].changes[0].value.messages[0] = {
      from: '15551234567', id: 'wamid.IMG', timestamp: '1719400001', type: 'image',
      image: { id: 'media123' },
    };
    const [m] = parseWhatsAppMessages(img);
    expect(m.isText).toBe(false);
    expect(m.text).toBe('');
  });

  it('returns [] for status-only callbacks (delivery/read receipts)', () => {
    const status = {
      object: 'whatsapp_business_account',
      entry: [{ id: 'X', changes: [{ field: 'messages', value: {
        metadata: { phone_number_id: '1010' },
        statuses: [{ id: 'wamid.X', status: 'delivered' }],
      } }] }],
    };
    expect(parseWhatsAppMessages(status)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails.**

Run: `npm run test -- whatsapp-webhook.util`
Expected: FAIL ("Cannot find module './whatsapp-webhook.util'").

- [ ] **Step 3: Implement the normalizer.**

```typescript
export interface ParsedWhatsAppMessage {
  phoneNumberId: string;
  fromWaId: string;
  messageId: string;
  text: string;
  timestamp: Date;
  authorName?: string;
  isText: boolean;
  referral?: Record<string, any>;
}

/** Flatten a WhatsApp Cloud API webhook into inbound message rows. Ignores
 *  status callbacks (delivery/read) and keeps non-text as isText=false. */
export function parseWhatsAppMessages(payload: any): ParsedWhatsAppMessage[] {
  const out: ParsedWhatsAppMessage[] = [];
  if (payload?.object !== 'whatsapp_business_account') return out;
  for (const entry of payload?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      if (change?.field !== 'messages') continue;
      const value = change.value ?? {};
      const phoneNumberId = value?.metadata?.phone_number_id;
      const messages = value?.messages ?? [];
      if (!phoneNumberId || messages.length === 0) continue; // status-only → skip
      const nameByWaId = new Map<string, string>();
      for (const c of value?.contacts ?? []) {
        if (c?.wa_id && c?.profile?.name) nameByWaId.set(c.wa_id, c.profile.name);
      }
      for (const msg of messages) {
        const isText = msg?.type === 'text' && typeof msg?.text?.body === 'string';
        out.push({
          phoneNumberId: String(phoneNumberId),
          fromWaId: String(msg?.from ?? ''),
          messageId: String(msg?.id ?? ''),
          text: isText ? String(msg.text.body) : '',
          timestamp: msg?.timestamp
            ? new Date(Number(msg.timestamp) * 1000)
            : new Date(),
          authorName: nameByWaId.get(String(msg?.from ?? '')),
          isText,
          referral: msg?.referral,
        });
      }
    }
  }
  return out;
}
```

- [ ] **Step 4: Run the test to confirm it passes.**

Run: `npm run test -- whatsapp-webhook.util`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit.**

```bash
git add src/channels/services/whatsapp-webhook.util.ts src/channels/services/whatsapp-webhook.util.spec.ts
git commit -m "feat(whatsapp): pure webhook payload normalizer"
```

---

### Task 6: Ingest service — persist inbound WhatsApp messages

**Files:**
- Create: `src/inbox/services/whatsapp-ingest.service.ts`
- Test: `src/inbox/services/whatsapp-ingest.service.spec.ts`

**Interfaces:**
- Consumes: `parseWhatsAppMessages` (Task 5); `InboxService.upsertDm` (existing, signature in `inbox.service.ts:2251`); `ChannelService` to resolve the channel by `(platform='whatsapp', platformAccountId=phoneNumberId)`.
- Produces: `WhatsAppIngestService.ingest(payload: any): Promise<void>` — resolves each message's channel, then calls `upsertDm` with `conversationId = '<phoneNumberId>:<fromWaId>'`, `fromMe: false`, author from `authorName`, and `metadata.referral` when present. Skips non-text (Phase 1) and unknown channels.

**Note for implementer:** Read `ChannelService` for the exact lookup method that finds a channel by platform + platformAccountId within any workspace (the Meta DM path in `webhooks.controller.ts:278-394` does the same resolution — mirror it). The channel row provides `workspaceId` and `id`. Do NOT decrypt the token here (ingest is inbound-only).

- [ ] **Step 1: Write the failing test** (mock `InboxService` + channel lookup):

```typescript
import { WhatsAppIngestService } from './whatsapp-ingest.service';

const textPayload = {
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA', changes: [{ field: 'messages', value: {
    metadata: { phone_number_id: '1010' },
    contacts: [{ profile: { name: 'Asad' }, wa_id: '15551234567' }],
    messages: [{ from: '15551234567', id: 'wamid.A', timestamp: '1719400000', type: 'text', text: { body: 'hi' } }],
  } }] }],
};

describe('WhatsAppIngestService.ingest', () => {
  it('upserts a DM for a known channel', async () => {
    const inbox = { upsertDm: jest.fn().mockResolvedValue({ id: 'row1' }) } as any;
    const channels = {
      findByPlatformAccount: jest.fn().mockResolvedValue({ id: 7, workspaceId: 'ws' }),
    } as any;
    const svc = new WhatsAppIngestService(inbox, channels);

    await svc.ingest(textPayload);

    expect(channels.findByPlatformAccount).toHaveBeenCalledWith('whatsapp', '1010');
    expect(inbox.upsertDm).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws',
        channelId: 7,
        platform: 'whatsapp',
        conversationId: '1010:15551234567',
        platformItemId: 'wamid.A',
        text: 'hi',
        fromMe: false,
        authorDisplayName: 'Asad',
        authorPlatformId: '15551234567',
      }),
    );
  });

  it('skips when no channel matches the phone_number_id', async () => {
    const inbox = { upsertDm: jest.fn() } as any;
    const channels = { findByPlatformAccount: jest.fn().mockResolvedValue(null) } as any;
    await new WhatsAppIngestService(inbox, channels).ingest(textPayload);
    expect(inbox.upsertDm).not.toHaveBeenCalled();
  });

  it('skips non-text messages in Phase 1', async () => {
    const inbox = { upsertDm: jest.fn() } as any;
    const channels = { findByPlatformAccount: jest.fn().mockResolvedValue({ id: 7, workspaceId: 'ws' }) } as any;
    const img = JSON.parse(JSON.stringify(textPayload));
    img.entry[0].changes[0].value.messages[0] = { from: '1', id: 'wamid.I', timestamp: '1719400000', type: 'image', image: { id: 'm' } };
    await new WhatsAppIngestService(inbox, channels).ingest(img);
    expect(inbox.upsertDm).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails.**

Run: `npm run test -- whatsapp-ingest.service`
Expected: FAIL ("Cannot find module './whatsapp-ingest.service'").

- [ ] **Step 3: Implement the ingest service.** (Use the real `ChannelService` lookup method name discovered above in place of `findByPlatformAccount` if it differs; keep the test's mock name in sync.)

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { InboxService } from '../inbox.service';
import { ChannelService } from '../../channels/services/channel.service';
import { parseWhatsAppMessages } from '../../channels/services/whatsapp-webhook.util';

@Injectable()
export class WhatsAppIngestService {
  private readonly logger = new Logger(WhatsAppIngestService.name);

  constructor(
    private readonly inbox: InboxService,
    private readonly channels: ChannelService,
  ) {}

  async ingest(payload: any): Promise<void> {
    for (const m of parseWhatsAppMessages(payload)) {
      if (!m.isText) continue; // Phase 1: text only
      const channel = await this.channels.findByPlatformAccount(
        'whatsapp',
        m.phoneNumberId,
      );
      if (!channel) {
        this.logger.warn(
          `No whatsapp channel for phone_number_id=${m.phoneNumberId}; dropping message ${m.messageId}`,
        );
        continue;
      }
      await this.inbox.upsertDm({
        workspaceId: channel.workspaceId,
        channelId: channel.id,
        platform: 'whatsapp',
        conversationId: `${m.phoneNumberId}:${m.fromWaId}`,
        platformItemId: m.messageId,
        authorPlatformId: m.fromWaId,
        authorDisplayName: m.authorName ?? m.fromWaId,
        text: m.text,
        fromMe: false,
        platformCreatedAt: m.timestamp,
        metadata: m.referral ? { referral: m.referral } : undefined,
      });
    }
  }
}
```

- [ ] **Step 4: Run the test to confirm it passes.**

Run: `npm run test -- whatsapp-ingest.service`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit.**

```bash
git add src/inbox/services/whatsapp-ingest.service.ts src/inbox/services/whatsapp-ingest.service.spec.ts
git commit -m "feat(whatsapp): inbound ingest -> upsertDm"
```

---

### Task 7: BullMQ processor for async ingest

**Files:**
- Create: `src/inbox/processors/whatsapp-ingest.processor.ts`
- Modify: the inbox module file that registers processors (find it: `src/inbox/inbox.module.ts`)

**Interfaces:**
- Consumes: `QUEUES.WHATSAPP_INGEST` (Task 1), `WhatsAppIngestService.ingest` (Task 6).
- Produces: a `@Processor(QUEUES.WHATSAPP_INGEST)` worker that runs `ingest(job.data.payload)`.

**Note:** Mirror `src/ads/processors/lead-intake.processor.ts` exactly for the `WorkerHost`/`@Processor` shape and error handling.

- [ ] **Step 1: Implement the processor** (no unit test — it's a thin delegator; covered by Task 6 + manual e2e):

```typescript
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { QUEUES } from '../../queue/queue.module';
import { WhatsAppIngestService } from '../services/whatsapp-ingest.service';

@Processor(QUEUES.WHATSAPP_INGEST)
export class WhatsAppIngestProcessor extends WorkerHost {
  private readonly logger = new Logger(WhatsAppIngestProcessor.name);

  constructor(private readonly ingest: WhatsAppIngestService) {
    super();
  }

  async process(job: Job<{ payload: any }>): Promise<{ ok: boolean }> {
    await this.ingest.ingest(job.data.payload);
    return { ok: true };
  }
}
```

- [ ] **Step 2: Register** `WhatsAppIngestProcessor` + `WhatsAppIngestService` + `WhatsAppService` + `WhatsAppDmAdapter` in the inbox module `providers`, and ensure `BullModule.registerQueue({ name: QUEUES.WHATSAPP_INGEST })` is imported there (or already global via `QueueModule`). Mirror how `DISCORD_INGEST`/`SLACK_INGEST` processors are wired.

- [ ] **Step 3: Verify build.**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Commit.**

```bash
git add src/inbox/processors/whatsapp-ingest.processor.ts src/inbox/inbox.module.ts
git commit -m "feat(whatsapp): ingest processor + module wiring"
```

---

### Task 8: Webhook routes (`GET`/`POST /webhooks/whatsapp`)

**Files:**
- Modify: `src/channels/webhooks.controller.ts`

**Interfaces:**
- Consumes: `verifyMetaSignature` (Task 2), `QUEUES.WHATSAPP_INGEST` queue (inject like `leadIntakeQueue`), `META_APP_SECRET` + `META_WEBHOOK_VERIFY_TOKEN` env.
- Produces: GET verification + signed POST that enqueues the raw payload.

**Note:** The POST handler needs the **raw body** for signature verification. Check how Slack's raw-body route is wired in `main.ts` (the Explore found Slack uses an Express raw-body middleware) and apply the same for `/webhooks/whatsapp`. If raw body isn't readily available, verify against `JSON.stringify(body)` is NOT safe — use the configured raw-body Buffer like the Slack route does (`req.body as Buffer`).

- [ ] **Step 1: Add the GET verification route** (mirror the existing FB/IG GET handler that returns `hub.challenge` when `hub.verify_token === META_VERIFY_TOKEN`). Reuse the existing `verifyMetaSubscription`/GET helper used by `facebook`/`instagram` — point a `@Get('whatsapp')` at it with `source='whatsapp'`.

- [ ] **Step 2: Add the POST route.**

```typescript
@Post('whatsapp')
@HttpCode(HttpStatus.OK)
async handleWhatsAppWebhook(@Req() req: Request, @Res() res: Response) {
  // 1. Verify signature against the RAW body before trusting anything.
  const appSecret = process.env.META_APP_SECRET ?? '';
  const raw = (req as any).rawBody ?? req.body; // raw Buffer (see main.ts raw-body setup)
  const sig = req.headers['x-hub-signature-256'] as string | undefined;
  const ok =
    !!appSecret &&
    verifyMetaSignature({
      appSecret,
      signatureHeader: sig,
      rawBody: Buffer.isBuffer(raw) ? raw : JSON.stringify(req.body),
    });
  if (!ok) {
    this.logger.warn('WhatsApp webhook signature verification failed');
    return res.status(401).send('invalid signature');
  }

  // 2. ACK fast, then process async.
  res.status(200).send('EVENT_RECEIVED');
  try {
    await this.whatsappIngestQueue.add(
      'whatsapp-ingest',
      { payload: req.body },
      { attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
    );
  } catch (err) {
    this.logger.error(`WhatsApp webhook enqueue failed: ${(err as Error).message}`);
  }
}
```

- [ ] **Step 3: Inject the queue.** Add `@InjectQueue(QUEUES.WHATSAPP_INGEST) private readonly whatsappIngestQueue: Queue` to the controller constructor (mirror `leadIntakeQueue`).

- [ ] **Step 4: Configure raw body for `/webhooks/whatsapp`** in `main.ts` next to the Slack raw-body config.

- [ ] **Step 5: Verify build + a manual signed POST** (local):

Run: `npm run build`
Then with the dev server running, POST a signed sample payload (compute `sha256=` HMAC with `META_APP_SECRET`) to `http://localhost:8000/webhooks/whatsapp` and confirm a 200 + a queued job log. A wrong signature must return 401.

- [ ] **Step 6: Commit.**

```bash
git add src/channels/webhooks.controller.ts src/main.ts
git commit -m "feat(whatsapp): signed webhook routes -> ingest queue"
```

---

### Task 9: Manual connect endpoint

**Files:**
- Modify: `src/channels/channels.controller.ts` (add a route) + `src/channels/services/channel.service.ts` (a `connectWhatsApp` helper if the generic create path needs platform-specific defaults)
- Create: `src/channels/dto/connect-whatsapp.dto.ts`

**Interfaces:**
- Produces: `POST /channels/workspaces/:workspaceId/whatsapp/connect` accepting `{ phoneNumberId, wabaId, accessToken, displayPhoneNumber, accountName }`, creating a `socialMediaChannels` row with `platform='whatsapp'`, `platformAccountId=phoneNumberId`, encrypted `accessToken`, and `metadata={ wabaId, displayPhoneNumber }`.

**Note:** Reuse the existing `ChannelService.createChannel(...)` path (it encrypts tokens + stores metadata). This endpoint just builds the DTO from the manual inputs. Enforce the workspace-owner guard like other channel routes.

- [ ] **Step 1: Create the DTO** with `class-validator` decorators (`@IsString()` etc., matching the project's DTO conventions).

- [ ] **Step 2: Add the controller route** that calls `ChannelService.createChannel` with the WhatsApp fields. Validate that the token works by calling `GET /{phoneNumberId}?fields=display_phone_number,verified_name` on the Graph API before persisting; reject with a clear 400 if it fails.

- [ ] **Step 3: Manual verification.** With a Meta test number + system-user token, hit the endpoint and confirm a `whatsapp` channel row is created and appears in the workspace's channel list.

- [ ] **Step 4: Commit.**

```bash
git add src/channels/dto/connect-whatsapp.dto.ts src/channels/channels.controller.ts src/channels/services/channel.service.ts
git commit -m "feat(whatsapp): manual connect endpoint (phase 1 onboarding)"
```

---

### Task 10: Wire reply send + register the DM adapter

**Files:**
- Modify: `src/inbox/services/inbox-dispatcher.service.ts` (register `WhatsAppDmAdapter` in the adapter map keyed by `'whatsapp'`)
- Modify: the inbox reply/send path (find where `PlatformDmAdapter.sendDm` is invoked for a DM reply — same place FB/IG DMs are sent)

**Interfaces:**
- Consumes: `WhatsAppDmAdapter` (Task 4), the existing DM-send flow.
- Produces: replying to a `whatsapp` DM in the inbox sends via WhatsApp and records the outbound message (`fromMe: true`) through `upsertDm`.

**Note:** The dispatcher already resolves a `ResolvedChannel` (decrypting the token via `ChannelService.getAccessToken`) and picks the adapter by platform — mirror exactly how Facebook/Instagram DM replies are dispatched. Before sending, call `getReplyWindowState`; if `canReply === false`, return the `reason` as a 4xx so the UI shows "window closed" instead of a silent failure. After a successful send, persist the outbound message via `upsertDm({ ...fromMe: true, platformItemId: created.platformItemId, conversationId, text })` so it appears in the thread immediately.

- [ ] **Step 1: Register** `'whatsapp' -> WhatsAppDmAdapter` in the dispatcher's DM-adapter map (mirror the Facebook/Instagram entries).

- [ ] **Step 2: Enforce the 24h window** in the reply path: call `adapter.getReplyWindowState(channel, conversationId, lastIncomingAt)`; throw a `BadRequestException(reason)` when `!canReply`. Derive `lastIncomingAt` from the latest inbound row of that conversation (the inbox service already has a query for conversation messages — reuse it).

- [ ] **Step 3: Persist the outbound** message via `upsertDm` with `fromMe: true` after send.

- [ ] **Step 4: Verify build.**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 5: End-to-end manual test.** From the inbox, reply to a WhatsApp conversation that has a recent inbound; confirm the customer receives it and the outbound bubble appears. Then test the closed-window case (no inbound / >24h) and confirm the UI shows the window-closed reason.

- [ ] **Step 6: Commit.**

```bash
git add src/inbox/services/inbox-dispatcher.service.ts
git commit -m "feat(whatsapp): two-way reply with 24h window enforcement"
```

---

### Task 11: Docs + env

**Files:**
- Modify: `.env.example` (add `META_APP_SECRET`, confirm `META_WEBHOOK_VERIFY_TOKEN`)
- Create: `docs/whatsapp-cloud-api.md` (setup: WABA, phone number, webhook subscription fields `messages`, App Review note)

- [ ] **Step 1: Document** the manual-connect flow + the Meta App Review / Business Verification dependency (production gate, like Boost). List the webhook fields to subscribe (`messages`) and the env vars.

- [ ] **Step 2: Commit.**

```bash
git add .env.example docs/whatsapp-cloud-api.md
git commit -m "docs(whatsapp): cloud API setup + app-review dependency"
```

---

## Out of Scope (Phase 2 — separate plan)

- **Message templates** + business-initiated sends (and replying after the 24h window).
- **WhatsApp notifications** (Schedura → its own users).
- **Embedded Signup** (multi-tenant self-serve WABA onboarding) + OAuth-based token refresh.
- **Media messages** (image/audio/document) inbound + outbound (uses `sendDmWithAttachments` + media download).
- Linking Click-to-WhatsApp **ad referral** context to the ads module's campaign rows (Phase 1 only stores raw `referral` in metadata).

## Self-Review

- **Spec coverage:** connect (T9) ✓, inbound receive (T5/T6/T7/T8) ✓, two-way reply within 24h (T4/T10) ✓, signature security (T2/T8) ✓, ads messages flow through same webhook with referral captured (T5/T6) ✓, manual onboarding (T9) ✓, Meta-review dependency surfaced (T11) ✓. Push-only history limitation documented (T4). Phase-2 items explicitly deferred.
- **Type consistency:** `conversationId` convention `'<phoneNumberId>:<fromWaId>'` is identical in T4 (`sendDm` parse), T6 (ingest build). `WhatsAppService.sendText(accessToken, phoneNumberId, toWaId, text)` matches its call in T4. `upsertDm` fields match the real signature in `inbox.service.ts:2251`. `verifyMetaSignature` signature matches T2 ↔ T8 usage.
- **Open item for implementer:** confirm the exact `ChannelService` lookup method (`findByPlatformAccount` placeholder in T6) and the FB/IG DM reply dispatch site (T10) by reading those files at execution time; keep test mocks in sync with the real names.
