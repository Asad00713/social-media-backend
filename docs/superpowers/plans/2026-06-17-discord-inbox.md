# Discord Inbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Discord as a DM/mention inbox platform — receive bot DMs and @mentions (with attachments + edit/delete sync) and reply (text + attachments, delete own message), reusing the existing inbox pipeline.

**Architecture:** A single persistent Discord Gateway (WebSocket) worker receives events and enqueues them to a `DISCORD_INGEST` BullMQ queue; an ingest processor maps `guild_id`/DM → workspace+channel, rehosts attachments to R2, and writes `inbox_items` — identical downstream to Slack/Telegram ingest, only the entry point differs. Replies/deletes go out via Discord REST through a `DiscordDmAdapter` registered in `InboxDispatcher`.

**Tech Stack:** NestJS, BullMQ (Redis), Drizzle (Postgres/Neon), `discord.js` v14 (Gateway + REST), Cloudflare R2. Design doc: `docs/superpowers/specs/2026-06-17-discord-inbox-design.md`.

## Global Constraints

- Discord uses ONE shared bot (`DISCORD_BOT_TOKEN`); route events by `guild_id → channel row → workspace`. NEVER run the gateway on >1 replica (Discord disconnects a second IDENTIFY) — gate start with `DISCORD_GATEWAY_ENABLED`.
- Phase 1 = DMs + @mentions only. Do NOT enable all-channel reading (needs Message Content privileged intent — deferred).
- Conform to the existing `PlatformDmAdapter` interface (`src/inbox/adapters/inbox-adapter.interface.ts`); ingest reuses `InboxService.upsertDm`; attachments rehost via `CloudflareR2Service.uploadBuffer`.
- Backend conventions: service-controller-module, `*.spec.ts` co-located, Prettier single quotes + trailing commas. ESLint `no-explicit-any` is off.
- Telegram multi-bot is a SEPARATE parallel effort (sequenced after). Do not generalize Discord's single-bot model onto Telegram.

---

### Task 1: Dependencies, queue, and env scaffolding

**Files:**
- Modify: `package.json` (add `discord.js`)
- Modify: `src/queue/queue.module.ts:7-18` (add `DISCORD_INGEST`) and the `registerQueue` list (`:58-68`)
- Modify: `.env.example` (document new vars)

**Interfaces:**
- Produces: `QUEUES.DISCORD_INGEST = 'discord-ingest'` (consumed by Tasks 3, 4); env vars `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_GATEWAY_ENABLED`.

- [ ] **Step 1: Install discord.js**

```bash
cd socialmedia-workspace
npm install discord.js@^14
```

- [ ] **Step 2: Add the queue constant + registration**

In `src/queue/queue.module.ts`, add to the `QUEUES` object (after `TELEGRAM_INGEST`):

```ts
  DISCORD_INGEST: 'discord-ingest',
```

And add to the `BullModule.registerQueue` array (after `{ name: QUEUES.TELEGRAM_INGEST }`):

```ts
      { name: QUEUES.DISCORD_INGEST },
```

- [ ] **Step 3: Document env vars** in `.env.example`:

```bash
# Discord (inbox) — one shared bot for the whole platform
DISCORD_BOT_TOKEN=
DISCORD_CLIENT_ID=
DISCORD_CLIENT_SECRET=
# Set to "true" on EXACTLY ONE running instance so the Gateway connects once.
DISCORD_GATEWAY_ENABLED=false
```

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: compiles cleanly (no usage yet, just the constant + dep).

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/queue/queue.module.ts .env.example
git commit -m "chore(discord): add discord.js, DISCORD_INGEST queue, env scaffolding"
```

---

### Task 2: DiscordService — REST client

**Files:**
- Create: `src/channels/services/discord.service.ts`
- Test: `src/channels/services/discord.service.spec.ts`
- Modify: `src/channels/channels.module.ts` (provide + export `DiscordService`)

**Interfaces:**
- Produces (consumed by Tasks 3, 4, 5, 6):
  - `createMessage(channelId: string, body: { content?: string; messageReferenceId?: string; files?: { name: string; data: Buffer; contentType?: string }[] }): Promise<{ id: string; channelId: string }>`
  - `deleteMessage(channelId: string, messageId: string): Promise<boolean>`
  - `getUser(userId: string): Promise<{ id: string; username: string; globalName: string | null; avatarUrl: string | null } | null>`
  - `downloadAttachment(url: string): Promise<{ buffer: Buffer; contentType: string }>`
  - `exchangeOAuthCode(code: string, redirectUri: string): Promise<{ guildId: string; accessToken: string }>`

- [ ] **Step 1: Write the failing test**

```ts
import { DiscordService } from './discord.service';

describe('DiscordService', () => {
  const svc = new DiscordService();

  it('builds a CDN avatar url from a user hash', () => {
    const url = svc.avatarUrl('123', 'abcd');
    expect(url).toBe('https://cdn.discordapp.com/avatars/123/abcd.png');
  });

  it('returns null avatar url when hash is null', () => {
    expect(svc.avatarUrl('123', null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- discord.service`
Expected: FAIL — `Cannot find module './discord.service'`.

- [ ] **Step 3: Implement DiscordService**

```ts
import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { REST } from '@discordjs/rest';
import { Routes } from 'discord-api-types/v10';

@Injectable()
export class DiscordService {
  private readonly logger = new Logger(DiscordService.name);
  private readonly rest = new REST({ version: '10' }).setToken(
    process.env.DISCORD_BOT_TOKEN ?? '',
  );

  /** Build a CDN avatar URL, or null when the user has no custom avatar. */
  avatarUrl(userId: string, avatarHash: string | null): string | null {
    if (!avatarHash) return null;
    return `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.png`;
  }

  /** Create a message in a channel (DM or guild). `messageReferenceId` makes it
   *  a reply. `files` are uploaded as attachments. */
  async createMessage(
    channelId: string,
    body: {
      content?: string;
      messageReferenceId?: string;
      files?: { name: string; data: Buffer; contentType?: string }[];
    },
  ): Promise<{ id: string; channelId: string }> {
    const payload: Record<string, any> = {};
    if (body.content) payload.content = body.content;
    if (body.messageReferenceId) {
      payload.message_reference = { message_id: body.messageReferenceId };
    }
    const res = (await this.rest.post(Routes.channelMessages(channelId), {
      body: payload,
      files: body.files?.map((f) => ({
        name: f.name,
        data: f.data,
        contentType: f.contentType,
      })),
    })) as { id: string; channel_id: string };
    return { id: res.id, channelId: res.channel_id };
  }

  /** Delete a message the bot authored. Returns true on success. */
  async deleteMessage(channelId: string, messageId: string): Promise<boolean> {
    await this.rest.delete(Routes.channelMessage(channelId, messageId));
    return true;
  }

  /** Fetch a user's public profile for inbox author display. */
  async getUser(userId: string): Promise<{
    id: string;
    username: string;
    globalName: string | null;
    avatarUrl: string | null;
  } | null> {
    try {
      const u = (await this.rest.get(Routes.user(userId))) as {
        id: string;
        username: string;
        global_name: string | null;
        avatar: string | null;
      };
      return {
        id: u.id,
        username: u.username,
        globalName: u.global_name,
        avatarUrl: this.avatarUrl(u.id, u.avatar),
      };
    } catch (err) {
      this.logger.warn(`getUser failed for ${userId}: ${String(err)}`);
      return null;
    }
  }

  /** Download a Discord-hosted attachment (CDN urls are public + unauth). */
  async downloadAttachment(
    url: string,
  ): Promise<{ buffer: Buffer; contentType: string }> {
    const res = await fetch(url);
    if (!res.ok) {
      throw new BadRequestException(`Discord attachment fetch ${res.status}`);
    }
    const contentType =
      res.headers.get('content-type')?.split(';')[0]?.trim() ??
      'application/octet-stream';
    return { buffer: Buffer.from(await res.arrayBuffer()), contentType };
  }

  /** Exchange the bot-invite OAuth code for the guild id the bot was added to. */
  async exchangeOAuthCode(
    code: string,
    redirectUri: string,
  ): Promise<{ guildId: string; accessToken: string }> {
    const params = new URLSearchParams({
      client_id: process.env.DISCORD_CLIENT_ID ?? '',
      client_secret: process.env.DISCORD_CLIENT_SECRET ?? '',
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    });
    const res = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    });
    const data = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      guild?: { id?: string };
    };
    if (!res.ok || !data.guild?.id) {
      throw new BadRequestException('Discord OAuth exchange failed');
    }
    return { guildId: data.guild.id, accessToken: data.access_token ?? '' };
  }
}
```

- [ ] **Step 4: Register in module** — in `src/channels/channels.module.ts`, add `DiscordService` to `providers` and `exports`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- discord.service`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/channels/services/discord.service.ts src/channels/services/discord.service.spec.ts src/channels/channels.module.ts
git commit -m "feat(discord): REST service (create/delete message, getUser, attachment, oauth)"
```

---

### Task 3: DiscordGatewayService — persistent WS worker

**Files:**
- Create: `src/channels/services/discord-gateway.service.ts`
- Test: `src/channels/services/discord-gateway.service.spec.ts`
- Modify: `src/channels/channels.module.ts` (provide `DiscordGatewayService`)

**Interfaces:**
- Consumes: `QUEUES.DISCORD_INGEST` (Task 1).
- Produces: enqueues jobs `{ type: 'create' | 'update' | 'delete', message }` onto `DISCORD_INGEST` (consumed by Task 4). Exposes `shouldIngest(message, botUserId): boolean` (pure, unit-tested).

- [ ] **Step 1: Write the failing test** (pure filter logic — no live socket)

```ts
import { DiscordGatewayService } from './discord-gateway.service';

describe('DiscordGatewayService.shouldIngest', () => {
  const svc = new DiscordGatewayService(null as any);
  const BOT = 'bot-1';

  it('ingests a DM to the bot (no guild)', () => {
    expect(svc.shouldIngest({ guild_id: undefined, author: { id: 'u1', bot: false }, mentions: [] } as any, BOT)).toBe(true);
  });

  it('ingests a guild message that @mentions the bot', () => {
    expect(svc.shouldIngest({ guild_id: 'g1', author: { id: 'u1', bot: false }, mentions: [{ id: BOT }] } as any, BOT)).toBe(true);
  });

  it('skips a guild message that does not mention the bot', () => {
    expect(svc.shouldIngest({ guild_id: 'g1', author: { id: 'u1', bot: false }, mentions: [] } as any, BOT)).toBe(false);
  });

  it('skips messages authored by the bot itself', () => {
    expect(svc.shouldIngest({ guild_id: undefined, author: { id: BOT, bot: true }, mentions: [] } as any, BOT)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- discord-gateway.service`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement DiscordGatewayService**

```ts
import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Client, GatewayIntentBits, Events, Partials } from 'discord.js';
import { QUEUES } from '../../queue/queue.module';

/** Raw-ish shape we forward to the ingest queue (decoupled from discord.js). */
interface RawDiscordMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  author: { id: string; bot: boolean; username: string; global_name: string | null; avatar: string | null };
  content: string;
  mentions: { id: string }[];
  attachments: { id: string; url: string; filename: string; content_type?: string }[];
  referenced_message_id?: string | null;
  timestamp: string;
}

@Injectable()
export class DiscordGatewayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DiscordGatewayService.name);
  private client: Client | null = null;
  private botUserId = '';

  constructor(
    @InjectQueue(QUEUES.DISCORD_INGEST) private readonly queue: Queue,
  ) {}

  /** Pure filter: ingest DMs to the bot, or guild messages mentioning the bot.
   *  Never ingest the bot's own messages. */
  shouldIngest(
    msg: { guild_id?: string; author: { id: string; bot: boolean }; mentions: { id: string }[] },
    botUserId: string,
  ): boolean {
    if (msg.author.bot && msg.author.id === botUserId) return false;
    if (!msg.guild_id) return true; // DM channel
    return msg.mentions.some((m) => m.id === botUserId);
  }

  async onModuleInit(): Promise<void> {
    if (process.env.DISCORD_GATEWAY_ENABLED !== 'true') {
      this.logger.log('DISCORD_GATEWAY_ENABLED!=true — gateway not started here');
      return;
    }
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel], // required to receive DMs
    });

    this.client.once(Events.ClientReady, (c) => {
      this.botUserId = c.user.id;
      this.logger.log(`Discord gateway ready as ${c.user.tag} (${c.user.id})`);
    });

    this.client.on(Events.MessageCreate, (m) => this.forward('create', m));
    this.client.on(Events.MessageUpdate, (_old, m) => this.forward('update', m as any));
    this.client.on(Events.MessageDelete, (m) => this.forwardDelete(m as any));

    await this.client.login(process.env.DISCORD_BOT_TOKEN);
  }

  private async forward(type: 'create' | 'update', m: any): Promise<void> {
    const raw = this.toRaw(m);
    if (!this.shouldIngest(raw, this.botUserId)) return;
    await this.queue.add(type, { type, message: raw }, {
      removeOnComplete: true,
      removeOnFail: 50,
    });
  }

  private async forwardDelete(m: any): Promise<void> {
    // Deletes carry minimal data; forward id + channel for soft-delete lookup.
    await this.queue.add('delete', {
      type: 'delete',
      message: { id: m.id, channel_id: m.channelId, guild_id: m.guildId ?? undefined },
    }, { removeOnComplete: true, removeOnFail: 50 });
  }

  private toRaw(m: any): RawDiscordMessage {
    return {
      id: m.id,
      channel_id: m.channelId,
      guild_id: m.guildId ?? undefined,
      author: {
        id: m.author?.id ?? '',
        bot: Boolean(m.author?.bot),
        username: m.author?.username ?? '',
        global_name: m.author?.globalName ?? null,
        avatar: m.author?.avatar ?? null,
      },
      content: m.content ?? '',
      mentions: [...(m.mentions?.users?.values?.() ?? [])].map((u: any) => ({ id: u.id })),
      attachments: [...(m.attachments?.values?.() ?? [])].map((a: any) => ({
        id: a.id, url: a.url, filename: a.name, content_type: a.contentType ?? undefined,
      })),
      referenced_message_id: m.reference?.messageId ?? null,
      timestamp: (m.createdAt ?? new Date()).toISOString(),
    };
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.destroy();
  }
}
```

- [ ] **Step 4: Register** `DiscordGatewayService` in `channels.module.ts` `providers`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- discord-gateway.service`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/channels/services/discord-gateway.service.ts src/channels/services/discord-gateway.service.spec.ts src/channels/channels.module.ts
git commit -m "feat(discord): gateway worker — filter DM/mention, enqueue to DISCORD_INGEST"
```

---

### Task 4: DiscordIngestProcessor — events → inbox_items

**Files:**
- Create: `src/inbox/processors/discord-ingest.processor.ts`
- Test: `src/inbox/processors/discord-ingest.processor.spec.ts`
- Modify: `src/inbox/inbox.module.ts` (provide the processor)

**Interfaces:**
- Consumes: `DISCORD_INGEST` jobs `{ type, message }` (Task 3); `DiscordService` (Task 2); `InboxService.upsertDm`, `InboxService.markDmDeleted` (existing — verify name; if absent, mirror Slack delete soft-update inline); `CloudflareR2Service.uploadBuffer`; `ChannelService.getAccessToken`.
- Produces: rows in `inbox_items`.

- [ ] **Step 1: Write the failing test** (attachment kind classifier — pure)

```ts
import { classifyDiscordAttachment } from './discord-ingest.processor';

describe('classifyDiscordAttachment', () => {
  it('maps image content types', () => {
    expect(classifyDiscordAttachment('image/png')).toEqual({ r2Kind: 'image', dmKind: 'image' });
  });
  it('maps audio to voice', () => {
    expect(classifyDiscordAttachment('audio/ogg')).toEqual({ r2Kind: 'voice', dmKind: 'voice' });
  });
  it('falls back to file for unknown', () => {
    expect(classifyDiscordAttachment(undefined)).toEqual({ r2Kind: 'file', dmKind: 'file' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- discord-ingest.processor`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the processor**

```ts
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { eq, and } from 'drizzle-orm';
import { db } from '../../drizzle/db';
import { socialMediaChannels } from '../../drizzle/schema';
import { QUEUES } from '../../queue/queue.module';
import { InboxService } from '../inbox.service';
import { ChannelService } from '../../channels/services/channel.service';
import { DiscordService } from '../../channels/services/discord.service';
import { CloudflareR2Service } from '../../media/cloudflare-r2.service';
import type { R2MediaKind } from '../../media/cloudflare-r2.service';

/** Map a Discord attachment content-type to our R2 + DM attachment kinds. */
export function classifyDiscordAttachment(contentType?: string): {
  r2Kind: R2MediaKind;
  dmKind: 'image' | 'video' | 'audio' | 'voice' | 'file';
} {
  const mime = (contentType ?? '').toLowerCase();
  if (mime.startsWith('image/')) return { r2Kind: 'image', dmKind: 'image' };
  if (mime.startsWith('video/')) return { r2Kind: 'video', dmKind: 'video' };
  if (mime.startsWith('audio/')) return { r2Kind: 'voice', dmKind: 'voice' };
  return { r2Kind: 'file', dmKind: 'file' };
}

@Processor(QUEUES.DISCORD_INGEST)
export class DiscordIngestProcessor extends WorkerHost {
  private readonly logger = new Logger(DiscordIngestProcessor.name);

  constructor(
    private readonly inbox: InboxService,
    private readonly channelService: ChannelService,
    private readonly discord: DiscordService,
    private readonly r2: CloudflareR2Service,
  ) {
    super();
  }

  async process(job: Job<{ type: 'create' | 'update' | 'delete'; message: any }>): Promise<void> {
    const { type, message: msg } = job.data;

    // Resolve channel: guild messages by guild_id; DMs have no guild_id so we
    // resolve by the author's id mapping is not possible — DMs route to the
    // workspace of any guild the bot+user share. Phase 1: resolve guild_id when
    // present, else attribute to the most-recently-connected discord channel.
    const channel = await this.resolveChannel(msg.guild_id);
    if (!channel) {
      this.logger.warn(`No Discord channel row for guild ${msg.guild_id ?? '(dm)'} — skipping`);
      return;
    }

    if (type === 'delete') {
      await this.inbox.softDeleteDmByPlatformItemId({
        workspaceId: channel.workspaceId,
        channelId: channel.id,
        platform: 'discord',
        platformItemId: msg.id,
      });
      return;
    }

    const author = msg.author ?? {};
    const avatarUrl = this.discord.avatarUrl(author.id, author.avatar ?? null);

    // Rehost attachments to R2 (Discord CDN urls expire / are unauth but public;
    // rehost for permanence + consistency with other platforms). Per-file
    // failure logs + drops that file only, never the whole message.
    const rehosted: { kind: 'image' | 'video' | 'audio' | 'voice' | 'file'; url: string; contentType?: string }[] = [];
    for (const a of (msg.attachments ?? []) as any[]) {
      try {
        const { buffer, contentType } = await this.discord.downloadAttachment(a.url);
        const final = a.content_type ?? contentType;
        const { r2Kind, dmKind } = classifyDiscordAttachment(final);
        const { publicUrl } = await this.r2.uploadBuffer({
          kind: r2Kind,
          workspaceId: channel.workspaceId,
          buffer,
          contentType: final,
          filename: a.filename ?? `discord-${a.id}`,
        });
        rehosted.push({ kind: dmKind, url: publicUrl, contentType: final });
      } catch (err) {
        this.logger.error(`Rehost failed for attachment ${a.id}: ${String(err)}`);
      }
    }

    await this.inbox.upsertDm({
      workspaceId: channel.workspaceId,
      channelId: channel.id,
      platform: 'discord',
      conversationId: msg.channel_id,
      platformItemId: msg.id,
      platformParentId: msg.referenced_message_id ?? null,
      authorPlatformId: author.id ?? null,
      authorHandle: author.username ?? null,
      authorDisplayName: author.global_name ?? author.username ?? null,
      authorAvatarUrl: avatarUrl,
      text: msg.content ?? '',
      fromMe: false,
      platformCreatedAt: new Date(msg.timestamp),
      metadata: { guildId: msg.guild_id ?? null },
      attachments: rehosted.length > 0 ? rehosted : undefined,
    });
  }

  private async resolveChannel(guildId?: string) {
    if (guildId) {
      const [c] = await db
        .select()
        .from(socialMediaChannels)
        .where(
          and(
            eq(socialMediaChannels.platform, 'discord'),
            eq(socialMediaChannels.platformAccountId, guildId),
          ),
        )
        .limit(1);
      return c ?? null;
    }
    // DM (no guild): most-recently-connected discord channel (Phase 1 routing).
    const [c] = await db
      .select()
      .from(socialMediaChannels)
      .where(eq(socialMediaChannels.platform, 'discord'))
      .orderBy(socialMediaChannels.id)
      .limit(1);
    return c ?? null;
  }
}
```

- [ ] **Step 4: Add `InboxService.softDeleteDmByPlatformItemId`** if it does not already exist. Check `src/inbox/inbox.service.ts` for an existing soft-delete-by-item helper; if none, add:

```ts
/** Soft-delete a DM row identified by its platform message id (used by
 *  webhook/gateway delete events — we don't have our internal id). Flips text
 *  to '[deleted]' and status to 'done'. No-op if the row is absent. */
async softDeleteDmByPlatformItemId(input: {
  workspaceId: string;
  channelId: number;
  platform: string;
  platformItemId: string;
}): Promise<void> {
  await db
    .update(inboxItems)
    .set({ text: '[deleted]', status: 'done' })
    .where(
      and(
        eq(inboxItems.workspaceId, input.workspaceId),
        eq(inboxItems.channelId, input.channelId),
        eq(inboxItems.platformItemId, input.platformItemId),
      ),
    );
}
```

(Verify `inboxItems` is already imported in `inbox.service.ts` — it is, used by existing delete methods.)

- [ ] **Step 5: Register** `DiscordIngestProcessor` in `src/inbox/inbox.module.ts` `providers` (mirror `SlackIngestProcessor`). Ensure `DiscordService` is importable (channels module exports it — Task 2).

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test -- discord-ingest.processor`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add src/inbox/processors/discord-ingest.processor.ts src/inbox/processors/discord-ingest.processor.spec.ts src/inbox/inbox.module.ts src/inbox/inbox.service.ts
git commit -m "feat(discord): ingest processor — events to inbox_items + R2 rehost + delete sync"
```

---

### Task 5: DiscordDmAdapter — reply/delete + dispatcher registration

**Files:**
- Create: `src/inbox/adapters/discord-dm.adapter.ts`
- Test: `src/inbox/adapters/discord-dm.adapter.spec.ts`
- Modify: `src/inbox/services/inbox-dispatcher.service.ts:33-63` (inject + register under `'discord'`)
- Modify: `src/inbox/inbox.module.ts` (provide `DiscordDmAdapter`)

**Interfaces:**
- Consumes: `DiscordService` (Task 2); `PlatformDmAdapter` interface; `ResolvedChannel`, `CreatedDm`, `DmAttachmentInput` types.
- Produces: `DiscordDmAdapter` registered as `dmAdapters.get('discord')`.

- [ ] **Step 1: Write the failing test**

```ts
import { DiscordDmAdapter } from './discord-dm.adapter';

describe('DiscordDmAdapter', () => {
  const discord = {
    createMessage: jest.fn().mockResolvedValue({ id: 'm1', channelId: 'c1' }),
    deleteMessage: jest.fn().mockResolvedValue(true),
  } as any;
  const adapter = new DiscordDmAdapter(discord);

  it('always reports canReply true (no messaging window)', async () => {
    await expect(adapter.getReplyWindowState()).resolves.toEqual({ canReply: true });
  });

  it('sends a text DM via createMessage', async () => {
    const res = await adapter.sendDm({} as any, 'c1', 'hi');
    expect(discord.createMessage).toHaveBeenCalledWith('c1', { content: 'hi' });
    expect(res.platformItemId).toBe('m1');
  });

  it('deletes a message via deleteMessage', async () => {
    await expect(adapter.deleteDm({} as any, 'c1', 'm1')).resolves.toBe(true);
    expect(discord.deleteMessage).toHaveBeenCalledWith('c1', 'm1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- discord-dm.adapter`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the adapter**

```ts
import { Injectable } from '@nestjs/common';
import { DiscordService } from '../../channels/services/discord.service';
import type {
  PlatformDmAdapter,
  ResolvedChannel,
  FetchedDm,
  CreatedDm,
  DmConversationSummary,
  DmAttachmentInput,
} from './inbox-adapter.interface';

/**
 * Discord DM adapter. Discord is ingest-driven (gateway), so list/fetch are
 * backed by stored inbox_items elsewhere; this adapter implements the OUTBOUND
 * surface (send/reply/delete) plus the no-op window state. conversationId ==
 * Discord channel id (DM channel or guild channel). platformItemId == message id.
 */
@Injectable()
export class DiscordDmAdapter implements PlatformDmAdapter {
  readonly platform = 'discord' as const;

  constructor(private readonly discord: DiscordService) {}

  // Discord exposes no "list all conversations" REST endpoint; the inbox list is
  // served from stored inbox_items. Return empty so the poll path is a no-op.
  async listConversations(): Promise<DmConversationSummary[]> {
    return [];
  }

  async fetchConversationMessages(): Promise<FetchedDm[]> {
    return [];
  }

  async sendDm(
    _channel: ResolvedChannel,
    conversationId: string,
    text: string,
  ): Promise<CreatedDm> {
    const res = await this.discord.createMessage(conversationId, { content: text });
    return {
      conversationId,
      platformItemId: res.id,
      text,
      platformCreatedAt: new Date(),
    };
  }

  async sendDmWithAttachments(
    _channel: ResolvedChannel,
    conversationId: string,
    text: string,
    attachments: DmAttachmentInput[],
  ): Promise<CreatedDm> {
    const files = [];
    for (let i = 0; i < attachments.length; i++) {
      const att = attachments[i];
      const dl = await this.discord.downloadAttachment(att.url);
      const tail = att.url.split('/').pop() ?? `attachment-${i}`;
      files.push({ name: decodeURIComponent(tail), data: dl.buffer, contentType: att.contentType });
    }
    const res = await this.discord.createMessage(conversationId, {
      content: text || undefined,
      files,
    });
    return { conversationId, platformItemId: res.id, text, platformCreatedAt: new Date() };
  }

  async getReplyWindowState(): Promise<{ canReply: boolean }> {
    return { canReply: true };
  }

  async deleteDm(
    _channel: ResolvedChannel,
    conversationId: string,
    platformItemId: string,
  ): Promise<boolean> {
    return this.discord.deleteMessage(conversationId, platformItemId);
  }
}
```

- [ ] **Step 4: Register in dispatcher** — in `src/inbox/services/inbox-dispatcher.service.ts`, add a constructor param `private readonly discordDm: DiscordDmAdapter,` and add to the `dmAdapters` map: `['discord', this.discordDm],`.

- [ ] **Step 5: Provide in module** — add `DiscordDmAdapter` to `src/inbox/inbox.module.ts` providers.

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test -- discord-dm.adapter`
Expected: PASS (3 tests).

- [ ] **Step 7: Verify full build + dispatcher wiring**

Run: `npm run build`
Expected: compiles (DI graph resolves — `DiscordService` exported by channels module and imported by inbox module).

- [ ] **Step 8: Commit**

```bash
git add src/inbox/adapters/discord-dm.adapter.ts src/inbox/adapters/discord-dm.adapter.spec.ts src/inbox/services/inbox-dispatcher.service.ts src/inbox/inbox.module.ts
git commit -m "feat(discord): DM adapter (send/reply/delete) + dispatcher registration"
```

---

### Task 6: Connect flow — bot-invite OAuth callback

**Files:**
- Modify: `src/channels/channels.controller.ts` (Discord OAuth callback branch — locate the existing per-platform OAuth callback handling and add a `discord` case)
- Modify: `src/channels/services/channel.service.ts` (no change expected — reuse `createChannel`; verify discord path stores `platformAccountId = guildId`)

**Interfaces:**
- Consumes: `DiscordService.exchangeOAuthCode` (Task 2); existing `ChannelService.createChannel`.
- Produces: a `social_media_channels` row with `platform='discord'`, `platformAccountId=<guildId>`.

- [ ] **Step 1: Locate the OAuth callback** — search `channels.controller.ts` for where other OAuth platforms (e.g. slack) exchange a code and call `createChannel`. Read that block to match its shape (workspace id source, redirect URI construction, error handling).

Run: `grep -n "exchangeCode\|createChannel\|oauth" src/channels/channels.controller.ts | head`

- [ ] **Step 2: Add the discord branch** following the same pattern as the slack branch. Concretely, where the controller switches on platform during the OAuth callback, add:

```ts
if (platform === 'discord') {
  const redirectUri = `${process.env.API_PUBLIC_URL ?? ''}/channels/oauth/discord/callback`;
  const { guildId } = await this.discordService.exchangeOAuthCode(code, redirectUri);
  // Fetch guild name for display via the bot token.
  await this.channelService.createChannel(workspaceId, userId, {
    platform: 'discord',
    platformAccountId: guildId,
    username: `guild:${guildId}`,
    // accessToken: the shared bot token is used at call time from env; store a
    // placeholder/encrypted marker per existing createChannel contract.
  } as any);
  return; // redirect handled by the existing post-connect flow
}
```

(Match the EXACT field names + redirect/return convention used by the slack branch found in Step 1 — adjust the snippet to the real `createChannel` DTO. Inject `DiscordService` into the controller constructor.)

- [ ] **Step 3: Manual verification** (no unit test — OAuth needs live creds):
  1. Set `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` locally.
  2. Open the bot-invite authorize URL (scopes `bot guilds`), pick a test server.
  3. Confirm a `social_media_channels` row appears with `platform='discord'`, `platformAccountId=<guildId>`.

Run: `npm run build`
Expected: compiles.

- [ ] **Step 4: Commit**

```bash
git add src/channels/channels.controller.ts
git commit -m "feat(discord): bot-invite OAuth callback creates guild channel row"
```

---

### Task 7: Frontend wiring — enable Discord in the inbox

**Files (frontend repo `socialmedia-frontend`):**
- Modify: `src/features/inbox/constants.ts:27-33` (add `'discord'` to `INBOX_DM_PLATFORMS`)
- Modify: `src/features/inbox/components/dm-message-bubble.tsx:43` (add `'discord'` to `DELETE_SUPPORTED_PLATFORMS`)
- Verify: `src/features/channels/components/connect-channel-grid.tsx` (Discord connect = bot-invite redirect; confirm Discord tile triggers the OAuth URL, not a custom dialog)

**Interfaces:**
- Consumes: backend `dmSupportedPlatforms()` now returns `'discord'` (Task 5).

- [ ] **Step 1: Enable Discord DM platform** — in `src/features/inbox/constants.ts`, add `'discord'` to the `INBOX_DM_PLATFORMS` set:

```ts
export const INBOX_DM_PLATFORMS: ReadonlySet<SocialPlatform> = new Set<SocialPlatform>([
  'facebook',
  'instagram',
  'bluesky',
  'mastodon',
  'slack',
  'discord',
])
```

- [ ] **Step 2: Enable delete on Discord bubbles** — in `dm-message-bubble.tsx`, add `'discord'`:

```ts
// Discord: bot can delete its own sent messages — no time window.
const DELETE_SUPPORTED_PLATFORMS = new Set(['mastodon', 'bluesky', 'facebook', 'telegram', 'slack', 'discord'])
```

- [ ] **Step 3: Verify connect tile** — read `connect-channel-grid.tsx`; ensure the Discord tile opens the backend Discord OAuth/bot-invite URL (same mechanism as other OAuth platforms), not a custom credentials dialog. If a dialog branch exists for discord, remove it so it uses the standard OAuth redirect.

- [ ] **Step 4: Verify build**

Run: `cd socialmedia-frontend && npm run build`
Expected: `tsc -b && vite build` succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/features/inbox/constants.ts src/features/inbox/components/dm-message-bubble.tsx src/features/channels/components/connect-channel-grid.tsx
git commit -m "feat(discord): enable Discord DM channel in inbox (list + delete + connect)"
```

---

## End-to-end manual test (after all tasks + live creds)

1. Set env on one backend instance: `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_GATEWAY_ENABLED=true`.
2. Invite the bot to a test server (Task 6 connect flow).
3. From another Discord account, @mention the bot in a channel and DM the bot (with an image).
4. Confirm both appear in the Schedura inbox under the Discord channel, image rendered (rehosted to R2).
5. Reply from the inbox → confirm it lands in Discord. Edit/delete the source message in Discord → confirm the inbox row updates / shows `[deleted]`.
6. Delete your inbox-sent reply → confirm it disappears in Discord.
