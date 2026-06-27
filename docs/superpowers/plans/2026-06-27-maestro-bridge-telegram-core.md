# Maestro Bridge — Telegram Core Implementation Plan (Plan A)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A user links their Telegram account to Schedura via a deep link, then DMs the central Maestro bot and gets a real Maestro answer back on Telegram (text round-trip), running the same agent + tools + persistence headless.

**Architecture:** A new `src/maestro/bridge/` area. The central Telegram bot (own token) posts updates to `POST /webhooks/maestro/telegram`, which enqueues to a `MAESTRO_BRIDGE` BullMQ queue. The processor either (a) links the Telegram identity on `/start <token>` or (b) runs a headless Maestro turn and replies. Identity lives in a new `maestro_channel_links` table. The headless turn reuses `MaestroService` (history, budget, persistence) via a new `runHeadlessTurn()` method.

**Tech Stack:** NestJS, Drizzle (Postgres/Neon), BullMQ/Redis, `@anthropic-ai/claude-agent-sdk`, existing `TelegramService.forToken()`.

## Global Constraints

- Backend dir: `socialmedia-workspace/`. Build check: `npm run build`. Tests: `npm run test` (Jest, `*.spec.ts` co-located).
- This plan is **backend only**. Frontend "Connect Maestro" UI is a separate plan + separate go-ahead (CLAUDE.md rule).
- Reuse, never fork: `MaestroService`, `ConversationService`, `TelegramService`, `encryption.util`, `ConfigService`, `QUEUES`.
- Central bot identity is **separate** from per-workspace inbox bots: new env `MAESTRO_TELEGRAM_BOT_TOKEN`, new webhook route `/webhooks/maestro/telegram`, new static secret `MAESTRO_TELEGRAM_WEBHOOK_SECRET`. Never touch `/webhooks/telegram/:routeId`.
- Link tokens: HMAC-SHA256 signed (`secureCompare`), TTL 10 min, single-use, bound to `userId` + `defaultWorkspaceId`.
- Confirm-before-send defaults **ON** for bridge runs (unattended surface).
- Migrations: no `.mjs` script convention on this project — add the schema file and apply with `npm run db:push` (dev). Note the new table in the commit.

---

### Task 1: `maestro_channel_links` schema + table

**Files:**
- Create: `src/drizzle/schema/maestro-links.schema.ts`
- Modify: `src/drizzle/schema/index.ts` (export the new schema — match how other schemas are re-exported)

**Interfaces:**
- Produces: `maestroChannelLinks` table; types `MaestroChannelLink`, `NewMaestroChannelLink`.

- [ ] **Step 1: Create the schema file**

```typescript
// src/drizzle/schema/maestro-links.schema.ts
import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { users } from './users.schema';
import { workspace } from './workspace.schema';

export type MaestroBridgeChannel = 'telegram' | 'whatsapp' | 'email';
export type MaestroLinkStatus = 'active' | 'revoked';

export const maestroChannelLinks = pgTable(
  'maestro_channel_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    channel: varchar('channel', { length: 16 })
      .$type<MaestroBridgeChannel>()
      .notNull(),
    externalId: varchar('external_id', { length: 128 }).notNull(),
    displayName: text('display_name'),
    defaultWorkspaceId: uuid('default_workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id'),
    status: varchar('status', { length: 16 })
      .$type<MaestroLinkStatus>()
      .notNull()
      .default('active'),
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    linkedAt: timestamp('linked_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => ({
    uniqChannelExternal: uniqueIndex('maestro_links_channel_external_uniq').on(
      t.channel,
      t.externalId,
    ),
    byUser: index('maestro_links_user_idx').on(t.userId),
  }),
);

export type MaestroChannelLink = typeof maestroChannelLinks.$inferSelect;
export type NewMaestroChannelLink = typeof maestroChannelLinks.$inferInsert;
```

- [ ] **Step 2: Export from the schema barrel**

Open `src/drizzle/schema/index.ts` and add (matching existing export style):
```typescript
export * from './maestro-links.schema';
```

- [ ] **Step 3: Push the schema to the dev DB**

Run: `npm run db:push`
Expected: drizzle-kit reports creating `maestro_channel_links` with no errors.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/drizzle/schema/maestro-links.schema.ts src/drizzle/schema/index.ts
git commit -m "feat(maestro-bridge): maestro_channel_links schema"
```

---

### Task 2: `BridgeLinkService` — link tokens + link CRUD (unit-tested)

**Files:**
- Create: `src/maestro/bridge/services/bridge-link.service.ts`
- Test: `src/maestro/bridge/services/bridge-link.service.spec.ts`

**Interfaces:**
- Consumes: `encryption.util` (`secureCompare`), `ConfigService`, `db`, `maestroChannelLinks`.
- Produces:
  - `issueLinkToken(userId: string, workspaceId: string): string`
  - `verifyLinkToken(token: string): { userId: string; workspaceId: string } | null`
  - `upsertLink(p: { userId; channel; externalId; displayName?; defaultWorkspaceId; metadata? }): Promise<MaestroChannelLink>`
  - `findLink(channel: MaestroBridgeChannel, externalId: string): Promise<MaestroChannelLink | null>` (active only)
  - `setDefaultWorkspace(linkId: string, workspaceId: string): Promise<void>`
  - `revoke(linkId: string): Promise<void>`
  - `setConversation(linkId: string, conversationId: string): Promise<void>`

Token format: `base64url(payloadJson).hmacHex` where payload = `{ u: userId, w: workspaceId, exp: epochMs }`. Secret = `MAESTRO_TELEGRAM_WEBHOOK_SECRET` (reused as link-signing key) or a dedicated `MAESTRO_LINK_SECRET`; use `MAESTRO_LINK_SECRET` with fallback to the webhook secret.

- [ ] **Step 1: Write the failing test (token round-trip + tamper + expiry)**

```typescript
// src/maestro/bridge/services/bridge-link.service.spec.ts
import { ConfigService } from '@nestjs/config';
import { BridgeLinkService } from './bridge-link.service';

function svc() {
  const config = {
    get: (k: string) => (k === 'MAESTRO_LINK_SECRET' ? 'test-secret-please-change' : ''),
  } as unknown as ConfigService;
  return new BridgeLinkService(config);
}

describe('BridgeLinkService link tokens', () => {
  it('round-trips a valid token', () => {
    const s = svc();
    const token = s.issueLinkToken('user-1', 'ws-1');
    expect(s.verifyLinkToken(token)).toEqual({ userId: 'user-1', workspaceId: 'ws-1' });
  });

  it('rejects a tampered token', () => {
    const s = svc();
    const token = s.issueLinkToken('user-1', 'ws-1');
    const tampered = token.slice(0, -2) + (token.endsWith('aa') ? 'bb' : 'aa');
    expect(s.verifyLinkToken(tampered)).toBeNull();
  });

  it('rejects an expired token', () => {
    const s = svc();
    const realNow = Date.now;
    Date.now = () => realNow() - 11 * 60 * 1000; // issued 11 min ago
    const token = s.issueLinkToken('user-1', 'ws-1');
    Date.now = realNow;
    expect(s.verifyLinkToken(token)).toBeNull();
  });

  it('rejects garbage', () => {
    expect(svc().verifyLinkToken('not-a-token')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npm run test -- bridge-link.service`
Expected: FAIL (module/class not found).

- [ ] **Step 3: Implement `BridgeLinkService`**

```typescript
// src/maestro/bridge/services/bridge-link.service.ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../../../drizzle/db';
import {
  maestroChannelLinks,
  type MaestroBridgeChannel,
  type MaestroChannelLink,
} from '../../../drizzle/schema/maestro-links.schema';
import { secureCompare } from '../../../common/utils/encryption.util';

const TOKEN_TTL_MS = 10 * 60 * 1000;

interface LinkPayload {
  u: string;
  w: string;
  exp: number;
}

@Injectable()
export class BridgeLinkService {
  constructor(private readonly config: ConfigService) {}

  private secret(): string {
    return (
      this.config.get<string>('MAESTRO_LINK_SECRET') ||
      this.config.get<string>('MAESTRO_TELEGRAM_WEBHOOK_SECRET') ||
      'dev-insecure-link-secret'
    );
  }

  private sign(body: string): string {
    return createHmac('sha256', this.secret()).update(body).digest('hex');
  }

  issueLinkToken(userId: string, workspaceId: string): string {
    const payload: LinkPayload = { u: userId, w: workspaceId, exp: Date.now() + TOKEN_TTL_MS };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${body}.${this.sign(body)}`;
  }

  verifyLinkToken(token: string): { userId: string; workspaceId: string } | null {
    const dot = token.lastIndexOf('.');
    if (dot <= 0) return null;
    const body = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    if (!secureCompare(sig, this.sign(body))) return null;
    try {
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as LinkPayload;
      if (!payload.u || !payload.w || typeof payload.exp !== 'number') return null;
      if (Date.now() > payload.exp) return null;
      return { userId: payload.u, workspaceId: payload.w };
    } catch {
      return null;
    }
  }

  async upsertLink(p: {
    userId: string;
    channel: MaestroBridgeChannel;
    externalId: string;
    displayName?: string;
    defaultWorkspaceId: string;
    metadata?: Record<string, unknown>;
  }): Promise<MaestroChannelLink> {
    const [row] = await db
      .insert(maestroChannelLinks)
      .values({
        userId: p.userId,
        channel: p.channel,
        externalId: p.externalId,
        displayName: p.displayName ?? null,
        defaultWorkspaceId: p.defaultWorkspaceId,
        status: 'active',
        metadata: p.metadata ?? {},
      })
      .onConflictDoUpdate({
        target: [maestroChannelLinks.channel, maestroChannelLinks.externalId],
        set: {
          userId: p.userId,
          displayName: p.displayName ?? null,
          defaultWorkspaceId: p.defaultWorkspaceId,
          status: 'active',
          updatedAt: new Date(),
        },
      })
      .returning();
    return row;
  }

  async findLink(channel: MaestroBridgeChannel, externalId: string): Promise<MaestroChannelLink | null> {
    const [row] = await db
      .select()
      .from(maestroChannelLinks)
      .where(
        and(
          eq(maestroChannelLinks.channel, channel),
          eq(maestroChannelLinks.externalId, externalId),
          eq(maestroChannelLinks.status, 'active'),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async setDefaultWorkspace(linkId: string, workspaceId: string): Promise<void> {
    await db
      .update(maestroChannelLinks)
      .set({ defaultWorkspaceId: workspaceId, updatedAt: new Date() })
      .where(eq(maestroChannelLinks.id, linkId));
  }

  async setConversation(linkId: string, conversationId: string): Promise<void> {
    await db
      .update(maestroChannelLinks)
      .set({ conversationId, updatedAt: new Date() })
      .where(eq(maestroChannelLinks.id, linkId));
  }

  async revoke(linkId: string): Promise<void> {
    await db
      .update(maestroChannelLinks)
      .set({ status: 'revoked', updatedAt: new Date() })
      .where(eq(maestroChannelLinks.id, linkId));
  }
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npm run test -- bridge-link.service`
Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add src/maestro/bridge/services/bridge-link.service.ts src/maestro/bridge/services/bridge-link.service.spec.ts
git commit -m "feat(maestro-bridge): link token sign/verify + link CRUD"
```

---

### Task 3: Headless turn on `MaestroService`

**Files:**
- Modify: `src/maestro/services/maestro.service.ts` (add `runHeadlessTurn`; read the existing `streamMessage` + `MaestroSseEvent` union first to consume the right event names)

**Interfaces:**
- Produces: `runHeadlessTurn(params: { conversationId: string; userId: string; message: string; confirmBeforeSend?: boolean }): Promise<{ text: string }>`
- Consumes: the service's own `streamMessage(params, signal)` generator.

- [ ] **Step 1: Read `streamMessage` + the `MaestroSseEvent` union**

Open `src/maestro/services/maestro.service.ts`. Identify the event variants the generator yields that carry assistant text (e.g. `message_stream`/`text` deltas and a terminal `message_complete`/`done`). Note their exact field names — the implementation below must match them.

- [ ] **Step 2: Implement `runHeadlessTurn`**

Consume the existing generator, accumulate assistant text, stop on the terminal event. (Adjust the event/field names in the `switch` to the real union read in Step 1.)

```typescript
async runHeadlessTurn(params: {
  conversationId: string;
  userId: string;
  message: string;
  confirmBeforeSend?: boolean;
}): Promise<{ text: string }> {
  const controller = new AbortController();
  let text = '';
  for await (const ev of this.streamMessage(
    {
      conversationId: params.conversationId,
      userId: params.userId,
      message: params.message,
      confirmBeforeSend: params.confirmBeforeSend ?? true,
    },
    controller.signal,
  )) {
    // Match these to the real MaestroSseEvent variants read in Step 1:
    if (ev.type === 'message_stream' && typeof ev.text === 'string') text += ev.text;
    else if (ev.type === 'message_complete' && typeof ev.content === 'string') text = ev.content;
    else if (ev.type === 'error') {
      text = text || "Sorry — I hit an error and couldn't finish that.";
      break;
    }
  }
  return { text: text.trim() };
}
```

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: green (fix any event-name mismatches surfaced by `tsc`).

- [ ] **Step 4: Commit**

```bash
git add src/maestro/services/maestro.service.ts
git commit -m "feat(maestro-bridge): headless turn runner on MaestroService"
```

---

### Task 4: Link-token + status REST endpoints (in-app "Connect Telegram")

**Files:**
- Modify: `src/maestro/maestro.controller.ts` (add two routes under the existing JwtAuthGuard)
- Create: `src/maestro/bridge/services/bridge.service.ts` (thin facade the controller calls; wraps `BridgeLinkService` + builds the deep link)

**Interfaces:**
- Consumes: `BridgeLinkService`, `ConfigService` (`MAESTRO_TELEGRAM_BOT_USERNAME`).
- Produces:
  - `GET /maestro/bridge/links` → `{ links: Array<{ channel; displayName; defaultWorkspaceId; status }> }`
  - `POST /maestro/bridge/telegram/link-token` (body `{ workspaceId }`) → `{ deepLink: string }`
  - `BridgeService.telegramDeepLink(userId, workspaceId): string`
  - `BridgeService.listLinks(userId): Promise<...>`

- [ ] **Step 1: Implement `BridgeService`**

```typescript
// src/maestro/bridge/services/bridge.service.ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import { db } from '../../../drizzle/db';
import { maestroChannelLinks } from '../../../drizzle/schema/maestro-links.schema';
import { BridgeLinkService } from './bridge-link.service';

@Injectable()
export class BridgeService {
  constructor(
    private readonly links: BridgeLinkService,
    private readonly config: ConfigService,
  ) {}

  telegramDeepLink(userId: string, workspaceId: string): string {
    const token = this.links.issueLinkToken(userId, workspaceId);
    const bot = this.config.get<string>('MAESTRO_TELEGRAM_BOT_USERNAME', 'ScheduraMaestroBot');
    return `https://t.me/${bot}?start=${token}`;
  }

  async listLinks(userId: string) {
    const rows = await db
      .select()
      .from(maestroChannelLinks)
      .where(eq(maestroChannelLinks.userId, userId));
    return rows.map((r) => ({
      id: r.id,
      channel: r.channel,
      displayName: r.displayName,
      defaultWorkspaceId: r.defaultWorkspaceId,
      status: r.status,
    }));
  }
}
```

- [ ] **Step 2: Add the two controller routes**

In `src/maestro/maestro.controller.ts`, inject `BridgeService` and add (mirror the existing auth/`@Req` user-id extraction in that controller):
```typescript
@Get('bridge/links')
async listBridgeLinks(@Req() req: AuthedRequest) {
  return { links: await this.bridge.listLinks(req.user.id) };
}

@Post('bridge/telegram/link-token')
async createTelegramLinkToken(
  @Req() req: AuthedRequest,
  @Body() body: { workspaceId: string },
) {
  return { deepLink: this.bridge.telegramDeepLink(req.user.id, body.workspaceId) };
}
```
(Use the same request/user type the controller already uses; do not invent a new guard.)

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add src/maestro/maestro.controller.ts src/maestro/bridge/services/bridge.service.ts
git commit -m "feat(maestro-bridge): link-token + links REST endpoints"
```

---

### Task 5: `MAESTRO_BRIDGE` queue + webhook route

**Files:**
- Modify: `src/queue/queue.module.ts` (add `MAESTRO_BRIDGE: 'maestro-bridge'` to `QUEUES` + `registerQueue`)
- Modify: `src/channels/webhooks.controller.ts` (add `POST maestro/telegram`; inject the new queue)

**Interfaces:**
- Produces: webhook route `POST /webhooks/maestro/telegram`; queue jobs `{ update: <telegram update> }` on `QUEUES.MAESTRO_BRIDGE`.
- Consumes: `MAESTRO_TELEGRAM_WEBHOOK_SECRET` for header compare.

- [ ] **Step 1: Register the queue**

In `src/queue/queue.module.ts` add to the `QUEUES` object: `MAESTRO_BRIDGE: 'maestro-bridge',` and add `BullModule.registerQueue({ name: QUEUES.MAESTRO_BRIDGE })` alongside the others.

- [ ] **Step 2: Add the webhook route**

In `src/channels/webhooks.controller.ts`, inject `@InjectQueue(QUEUES.MAESTRO_BRIDGE) private readonly maestroBridgeQueue: Queue` and add:
```typescript
@Post('maestro/telegram')
@HttpCode(HttpStatus.OK)
async receiveMaestroTelegram(
  @Headers('x-telegram-bot-api-secret-token') headerSecret: string | undefined,
  @Body() update: Record<string, unknown>,
) {
  const expected = this.config.get<string>('MAESTRO_TELEGRAM_WEBHOOK_SECRET', '');
  if (!expected || !headerSecret || !secureCompare(headerSecret, expected)) {
    return { ok: true }; // do not leak; drop quietly
  }
  await this.maestroBridgeQueue.add('telegram-update', { update }, {
    attempts: 2,
    removeOnComplete: true,
    removeOnFail: 100,
  });
  return { ok: true };
}
```
(Import `secureCompare` from `encryption.util` and ensure `ConfigService` is injected — follow existing imports in the file.)

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add src/queue/queue.module.ts src/channels/webhooks.controller.ts
git commit -m "feat(maestro-bridge): MAESTRO_BRIDGE queue + telegram webhook route"
```

---

### Task 6: `MaestroBridgeProcessor` — link on `/start`, run on text

**Files:**
- Create: `src/maestro/bridge/processors/maestro-bridge.processor.ts`

**Interfaces:**
- Consumes: `BridgeLinkService`, `MaestroService` (`createConversation`, `runHeadlessTurn`), `TelegramService.forToken`, `ConfigService` (`MAESTRO_TELEGRAM_BOT_TOKEN`).
- Produces: `@Processor(QUEUES.MAESTRO_BRIDGE)` worker handling `{ update }`.

Behaviour:
- Parse `update.message` → `{ chatId, fromId, text }` (Telegram `message.from.id`, `message.chat.id`, `message.text`). Ignore non-message updates for now (callback_query handled in Plan B).
- If `text` starts with `/start ` → verify the link token, `upsertLink({ channel:'telegram', externalId: String(fromId), userId, defaultWorkspaceId: workspaceId, displayName })`, reply "✅ Connected. Send me anything." Invalid token → reply "This link expired — generate a new one in Schedura."
- Else → `findLink('telegram', String(fromId))`. None → reply "Connect your Schedura account first: <APP_URL>/…". Found → ensure a conversation (create if `link.conversationId` null, persist back via `setConversation`), `runHeadlessTurn({ conversationId, userId: link.userId, message: text, confirmBeforeSend: true })`, reply the text.
- All replies via `this.telegram.forToken(centralToken).sendMessage(chatId, text)`.

- [ ] **Step 1: Implement the processor**

```typescript
// src/maestro/bridge/processors/maestro-bridge.processor.ts
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import { QUEUES } from '../../../queue/queue.module';
import { TelegramService } from '../../../channels/services/telegram.service';
import { MaestroService } from '../../services/maestro.service';
import { BridgeLinkService } from '../services/bridge-link.service';

@Processor(QUEUES.MAESTRO_BRIDGE)
export class MaestroBridgeProcessor extends WorkerHost {
  private readonly logger = new Logger(MaestroBridgeProcessor.name);

  constructor(
    private readonly links: BridgeLinkService,
    private readonly maestro: MaestroService,
    private readonly telegram: TelegramService,
    private readonly config: ConfigService,
  ) {
    super();
  }

  private tg() {
    return this.telegram.forToken(
      this.config.get<string>('MAESTRO_TELEGRAM_BOT_TOKEN') || undefined,
    );
  }

  async process(job: Job<{ update: Record<string, any> }>): Promise<void> {
    const msg = job.data.update?.message;
    if (!msg?.chat?.id || !msg?.from?.id) return;
    const chatId = msg.chat.id as number;
    const fromId = String(msg.from.id);
    const text = String(msg.text ?? '').trim();
    if (!text) return;

    if (text.startsWith('/start')) {
      await this.handleStart(chatId, fromId, msg, text);
      return;
    }
    await this.handleMessage(chatId, fromId, text);
  }

  private async handleStart(
    chatId: number,
    fromId: string,
    msg: Record<string, any>,
    text: string,
  ): Promise<void> {
    const token = text.slice('/start'.length).trim();
    const verified = token ? this.links.verifyLinkToken(token) : null;
    if (!verified) {
      await this.tg().sendMessage(
        chatId,
        'That connect link has expired. Open Schedura → Maestro → Connect Telegram to get a fresh link.',
      );
      return;
    }
    const displayName =
      [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') ||
      msg.from?.username ||
      'Telegram user';
    await this.links.upsertLink({
      userId: verified.userId,
      channel: 'telegram',
      externalId: fromId,
      displayName,
      defaultWorkspaceId: verified.workspaceId,
    });
    await this.tg().sendMessage(
      chatId,
      '✅ Connected to Schedura. Send me anything — I can check your inbox, draft and publish posts, and more.',
    );
  }

  private async handleMessage(chatId: number, fromId: string, text: string): Promise<void> {
    const link = await this.links.findLink('telegram', fromId);
    if (!link) {
      const app = this.config.get<string>('APP_URL') || this.config.get<string>('FRONTEND_URL') || '';
      await this.tg().sendMessage(
        chatId,
        `You're not connected yet. Open Schedura → Maestro → Connect Telegram${app ? ` (${app})` : ''} to link your account.`,
      );
      return;
    }
    let conversationId = link.conversationId;
    if (!conversationId) {
      const conv = await this.maestro.createConversation(link.userId, link.defaultWorkspaceId);
      conversationId = conv.id;
      await this.links.setConversation(link.id, conversationId);
    }
    try {
      const { text: reply } = await this.maestro.runHeadlessTurn({
        conversationId,
        userId: link.userId,
        message: text,
        confirmBeforeSend: true,
      });
      await this.tg().sendMessage(chatId, reply || '…');
    } catch (err) {
      this.logger.error(`bridge run failed: ${err instanceof Error ? err.message : err}`);
      await this.tg().sendMessage(chatId, 'Sorry — something went wrong on my end. Try again in a moment.');
    }
  }
}
```

- [ ] **Step 2: Build** (will fail until module wiring in Task 7 — acceptable; verify no syntax errors)

Run: `npm run build`
Expected: may report the processor is not in a module yet; proceed to Task 7, then build green.

- [ ] **Step 3: Commit**

```bash
git add src/maestro/bridge/processors/maestro-bridge.processor.ts
git commit -m "feat(maestro-bridge): processor — link on /start, headless run on text"
```

---

### Task 7: Module wiring + webhook registration + smoke test

**Files:**
- Create: `src/maestro/bridge/maestro-bridge.module.ts`
- Modify: `src/maestro/maestro.module.ts` (import `MaestroBridgeModule`; export `MaestroService` if not already, since the processor consumes it)
- Modify: `src/channels/channels.module.ts` (ensure `TelegramService` is exported for the bridge processor — it likely already is)
- Modify: `src/queue/queue.module.ts` already done in Task 5

**Interfaces:**
- Produces: a wired `MaestroBridgeModule` providing `BridgeLinkService`, `BridgeService`, `MaestroBridgeProcessor`, registering the `MAESTRO_BRIDGE` queue consumer.

- [ ] **Step 1: Create the bridge module**

```typescript
// src/maestro/bridge/maestro-bridge.module.ts
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { QUEUES } from '../../queue/queue.module';
import { ChannelsModule } from '../../channels/channels.module';
import { BridgeLinkService } from './services/bridge-link.service';
import { BridgeService } from './services/bridge.service';
import { MaestroBridgeProcessor } from './processors/maestro-bridge.processor';

@Module({
  imports: [
    ConfigModule,
    ChannelsModule, // provides TelegramService
    BullModule.registerQueue({ name: QUEUES.MAESTRO_BRIDGE }),
  ],
  providers: [BridgeLinkService, BridgeService, MaestroBridgeProcessor],
  exports: [BridgeLinkService, BridgeService],
})
export class MaestroBridgeModule {}
```

Note: `MaestroBridgeProcessor` needs `MaestroService`. To avoid a circular import (MaestroModule → MaestroBridgeModule → MaestroService), put the processor's dependency on `MaestroService` by importing `MaestroModule` here with `forwardRef` if needed, OR register the processor inside `MaestroModule` instead of the bridge module. **Chosen approach:** declare `MaestroBridgeProcessor` and `BridgeService`/`BridgeLinkService` inside `MaestroModule` directly (it already provides `MaestroService`), and keep `maestro-bridge.module.ts` minimal/unused, OR use `forwardRef(() => MaestroModule)`. Implement whichever compiles cleanly; prefer declaring providers in `MaestroModule` to sidestep the cycle.

- [ ] **Step 2: Wire providers into `MaestroModule`**

In `src/maestro/maestro.module.ts`: add `BridgeLinkService`, `BridgeService`, `MaestroBridgeProcessor` to `providers`, register the `MAESTRO_BRIDGE` queue via `BullModule.registerQueue`, ensure `ChannelsModule` is imported (for `TelegramService`) and `ConfigModule` present. The controller routes from Task 4 already live in `MaestroController`, so `BridgeService` must be provided here.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: green. Resolve any DI/circular errors (use `forwardRef` only if the compiler demands it).

- [ ] **Step 4: Register the central bot webhook (one-time, manual)**

Set env: `MAESTRO_TELEGRAM_BOT_TOKEN`, `MAESTRO_TELEGRAM_BOT_USERNAME`, `MAESTRO_TELEGRAM_WEBHOOK_SECRET`, `MAESTRO_LINK_SECRET`, `API_PUBLIC_URL`.
Run (curl, once) to point the central bot at our route:
```bash
curl "https://api.telegram.org/bot$MAESTRO_TELEGRAM_BOT_TOKEN/setWebhook?url=$API_PUBLIC_URL/webhooks/maestro/telegram&secret_token=$MAESTRO_TELEGRAM_WEBHOOK_SECRET"
```
Expected: `{"ok":true,"result":true,...}`.

- [ ] **Step 5: Manual smoke test (live)**

1. Call `POST /maestro/bridge/telegram/link-token` (authed) → get `deepLink`.
2. Open it in Telegram → tap Start → expect "✅ Connected…".
3. DM the bot "what workspace am I in?" → expect a Maestro reply (a `get_workspace_info` round-trip).
4. Verify `GET /maestro/bridge/links` lists the active telegram link.

- [ ] **Step 6: Commit**

```bash
git add src/maestro/bridge/maestro-bridge.module.ts src/maestro/maestro.module.ts src/channels/channels.module.ts
git commit -m "feat(maestro-bridge): wire module + central bot webhook; telegram round-trip"
```

---

## Self-Review

- **Spec coverage:** linking (Task 2/4/6), central bot infra (Task 5/7), inbound→headless run→reply (Task 3/6), persistence reuse (Task 3/6), token-gated unlinked handling (Task 6), entitlement check — **deferred to Plan B** (Telegram is free, so Plan A needs no gate; WhatsApp/gate lands with Plan C). Questions→buttons, media, `/switch`, notifications — **explicitly Plans B/C**. Frontend UI — separate plan.
- **Placeholder scan:** Task 3 intentionally requires reading the real `MaestroSseEvent` union before finalizing event names — this is a read-and-match instruction with concrete fallback code, not a TBD. Everything else is concrete.
- **Type consistency:** `runHeadlessTurn` signature matches between Task 3 (definition) and Task 6 (call). `forToken`, `findLink`, `upsertLink`, `setConversation`, `createConversation` names consistent across tasks.

## Follow-up plans (not this document)
- **Plan B — Rich Telegram rendering:** `ask_user`/confirm cards → inline keyboard + `callback_query` resume; media results → `sendPhoto`; `/switch` workspace.
- **Plan C — WhatsApp + notifications:** WhatsApp bridge (premium, plan-gate via billing entitlement) + `maestro-notification.service` (Resend email + Telegram).
- **Plan D — Frontend "Connect Maestro" UI** (separate go-ahead).
