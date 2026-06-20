# Telegram Custom Bots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the shared env Telegram bot with user-provided per-workspace bots (multiple per workspace), each routed by its own webhook with a derived secret.

**Architecture:** A bot's token is stored encrypted on its own `social_media_channels` row. The bot is the routing identity: each bot gets a per-channel webhook URL `/webhooks/telegram/<routeId>` whose secret is `HMAC(SERVER_SECRET, routeId)` (derived, never stored). `TelegramService` becomes token-parameterized via `forToken(token)`. Ingest knows the channel from the route, so no chat-binding or `/start` gate.

**Tech Stack:** NestJS, Drizzle (Neon HTTP), BullMQ, Jest (`*.spec.ts`), Node `crypto`, React 19 + Vite + shadcn/ui (frontend phase).

## Global Constraints

- Backend tests: Jest, `*.spec.ts` co-located with source.
- Tokens are stored encrypted via `encrypt()` from `src/common/utils/encryption.util.ts`; read via `channelService.getAccessToken(channelId, workspaceId)` (decrypts).
- Prettier: single quotes, trailing commas. `@typescript-eslint/no-explicit-any` is off.
- New env var: `TELEGRAM_WEBHOOK_HMAC_SECRET` (server secret). Webhook base URL from existing `TELEGRAM_WEBHOOK_BASE_URL` (fallback `API_PUBLIC_URL`).
- DB migrations use the one-off apply-script pattern (`scripts/apply-*.mjs`, `@neondatabase/serverless`, `ADD COLUMN IF NOT EXISTS`) — `db:migrate` has journal drift.
- Frontend: shadcn-only UI; `Form` = RHF + Zod; icons from `lucide-react`; theme tokens only.
- Allowed Telegram updates: `['message','edited_message','callback_query','my_chat_member']`.

---

## Phase A — Backend

### Task 1: DB column + schema + apply script

**Files:**
- Modify: `src/drizzle/schema/channels.schema.ts` (add column to `socialMediaChannels`)
- Create: `scripts/apply-telegram-route-id-migration.mjs`

**Interfaces:**
- Produces: `socialMediaChannels.telegramWebhookRouteId` (text, nullable, unique).

- [ ] **Step 1: Add the column to the Drizzle schema**

In `src/drizzle/schema/channels.schema.ts`, inside the `socialMediaChannels` table definition, add (near the other text columns):

```ts
telegramWebhookRouteId: text('telegram_webhook_route_id').unique(),
```

- [ ] **Step 2: Write the apply script**

Create `scripts/apply-telegram-route-id-migration.mjs`:

```js
import { neon } from '@neondatabase/serverless';
import 'dotenv/config';

const sql = neon(process.env.DATABASE_URL);

const run = async () => {
  await sql`ALTER TABLE "social_media_channels" ADD COLUMN IF NOT EXISTS "telegram_webhook_route_id" text`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS "social_media_channels_telegram_webhook_route_id_unique" ON "social_media_channels" ("telegram_webhook_route_id")`;
  console.log('✓ telegram_webhook_route_id column + unique index applied');
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 3: Run the apply script against the dev DB**

Run: `node scripts/apply-telegram-route-id-migration.mjs`
Expected: `✓ telegram_webhook_route_id column + unique index applied`

> NOTE: On production (Railway) this script must be run before deploying code that reads/writes the column — same ordering lesson as the `archived_at` migration.

- [ ] **Step 4: Verify the build picks up the schema**

Run: `npm run build`
Expected: compiles, no TS errors.

- [ ] **Step 5: Commit**

```bash
git add src/drizzle/schema/channels.schema.ts scripts/apply-telegram-route-id-migration.mjs
git commit -m "feat(telegram): add telegram_webhook_route_id channel column + apply script"
```

---

### Task 2: Webhook secret derivation util

**Files:**
- Create: `src/channels/utils/telegram-webhook-secret.util.ts`
- Test: `src/channels/utils/telegram-webhook-secret.util.spec.ts`

**Interfaces:**
- Produces:
  - `deriveTelegramWebhookSecret(routeId: string): string` — hex HMAC-SHA256 of routeId keyed by `TELEGRAM_WEBHOOK_HMAC_SECRET`.
  - `verifyTelegramWebhookSecret(routeId: string, headerSecret: string | undefined): boolean` — constant-time compare.
  - `generateTelegramRouteId(): string` — 32-hex random id.

- [ ] **Step 1: Write the failing test**

Create `src/channels/utils/telegram-webhook-secret.util.spec.ts`:

```ts
process.env.TELEGRAM_WEBHOOK_HMAC_SECRET = 'test-server-secret';
import {
  deriveTelegramWebhookSecret,
  verifyTelegramWebhookSecret,
  generateTelegramRouteId,
} from './telegram-webhook-secret.util';

describe('telegram-webhook-secret.util', () => {
  it('derives a stable hex secret for a routeId', () => {
    const a = deriveTelegramWebhookSecret('route-abc');
    const b = deriveTelegramWebhookSecret('route-abc');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('derives different secrets for different routeIds', () => {
    expect(deriveTelegramWebhookSecret('r1')).not.toBe(
      deriveTelegramWebhookSecret('r2'),
    );
  });

  it('verifies a matching header secret', () => {
    const secret = deriveTelegramWebhookSecret('route-xyz');
    expect(verifyTelegramWebhookSecret('route-xyz', secret)).toBe(true);
  });

  it('rejects a wrong or missing header secret', () => {
    expect(verifyTelegramWebhookSecret('route-xyz', 'nope')).toBe(false);
    expect(verifyTelegramWebhookSecret('route-xyz', undefined)).toBe(false);
  });

  it('generates a 32-hex routeId', () => {
    expect(generateTelegramRouteId()).toMatch(/^[0-9a-f]{32}$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- telegram-webhook-secret`
Expected: FAIL — cannot find module `./telegram-webhook-secret.util`.

- [ ] **Step 3: Write the implementation**

Create `src/channels/utils/telegram-webhook-secret.util.ts`:

```ts
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

function serverSecret(): string {
  const s = process.env.TELEGRAM_WEBHOOK_HMAC_SECRET;
  if (!s) {
    throw new Error('TELEGRAM_WEBHOOK_HMAC_SECRET is not configured');
  }
  return s;
}

/** Random opaque id embedded in the per-bot webhook URL path. */
export function generateTelegramRouteId(): string {
  return randomBytes(16).toString('hex'); // 32 hex chars
}

/** Per-bot webhook secret, derived (not stored) from the routeId. */
export function deriveTelegramWebhookSecret(routeId: string): string {
  return createHmac('sha256', serverSecret()).update(routeId).digest('hex');
}

/** Constant-time comparison of the X-Telegram-Bot-Api-Secret-Token header. */
export function verifyTelegramWebhookSecret(
  routeId: string,
  headerSecret: string | undefined,
): boolean {
  if (!headerSecret) return false;
  const expected = Buffer.from(deriveTelegramWebhookSecret(routeId), 'utf8');
  const got = Buffer.from(headerSecret, 'utf8');
  if (expected.length !== got.length) return false;
  return timingSafeEqual(expected, got);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- telegram-webhook-secret`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/channels/utils/telegram-webhook-secret.util.ts src/channels/utils/telegram-webhook-secret.util.spec.ts
git commit -m "feat(telegram): webhook secret derivation + routeId util"
```

---

### Task 3: Token-parameterize `TelegramService`

**Files:**
- Modify: `src/channels/services/telegram.service.ts`
- Test: `src/channels/services/telegram.service.spec.ts`

**Interfaces:**
- Produces:
  - `telegram.forToken(token?: string): TelegramClient` — bound client exposing the full method surface (`getMe`, `setWebhook`, `deleteWebhook`, `getWebhookInfo`, `sendMessage`, `editMessageText`, `deleteMessage`, `answerCallbackQuery`, `getChatAdministrators`, `getFile`, `getUserProfilePhotoFileId`, `downloadFile`, `sendPhoto/Voice/Audio/Video/Document`, `resolveEntities`).
  - `TelegramClient` interface (exported type).
  - New methods on the client: `deleteWebhook(): Promise<true>`, `getWebhookInfo(): Promise<{ url: string; last_error_message?: string }>`.
- Consumes: nothing new.

**Approach:** Extract the HTTP plumbing into a small class `TelegramClient` constructed with a token; it holds `callJson`/`callMultipart`/`downloadFile` and every existing method (move the bodies verbatim, replacing `this.botToken`/`this.baseUrl`/`this.fileBaseUrl` with the instance's token-derived URLs). `TelegramService` keeps a thin `forToken(token)` factory and an `isConfigured()` that reflects the env fallback. `resolveEntities` is pure — keep it on both (client delegates to a shared function).

- [ ] **Step 1: Write the failing test**

Create `src/channels/services/telegram.service.spec.ts`:

```ts
import { TelegramService } from './telegram.service';

describe('TelegramService.forToken', () => {
  const svc = new TelegramService({ get: () => '' } as any);

  it('builds an API client bound to the given token', () => {
    const client = svc.forToken('123:ABC');
    expect(client).toBeDefined();
    expect(typeof client.sendMessage).toBe('function');
    expect(typeof client.deleteWebhook).toBe('function');
    expect(typeof client.getWebhookInfo).toBe('function');
  });

  it('getMe POSTs to the token-specific base url', async () => {
    const client = svc.forToken('TOKEN_A');
    const spy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true, result: { id: 1, is_bot: true, first_name: 'Bot' } }), { status: 200 }),
      );
    await client.getMe();
    expect(spy).toHaveBeenCalledWith(
      'https://api.telegram.org/botTOKEN_A/getMe',
      expect.objectContaining({ method: 'POST' }),
    );
    spy.mockRestore();
  });

  it('resolveEntities replaces text_mention with @first_name', () => {
    const client = svc.forToken('T');
    const out = client.resolveEntities('hi bob', [
      { type: 'text_mention', offset: 3, length: 3, user: { id: 9, is_bot: false, first_name: 'Bob' } } as any,
    ]);
    expect(out).toBe('hi @Bob');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- telegram.service`
Expected: FAIL — `forToken` is not a function.

- [ ] **Step 3: Refactor `TelegramService` into a token-bound client**

In `src/channels/services/telegram.service.ts`:

1. Add an exported `class TelegramClient` whose constructor takes `(private readonly token: string, private readonly logger: Logger)` and computes `baseUrl = https://api.telegram.org/bot${token}` and `fileBaseUrl = https://api.telegram.org/file/bot${token}`.
2. Move `callJson`, `callMultipart`, `downloadFile`, and every public method (`getMe`, `setWebhook`, `sendMessage`, `editMessageText`, `deleteMessage`, `answerCallbackQuery`, `getChatAdministrators`, `getFile`, `getUserProfilePhotoFileId`, `sendPhoto/Voice/Audio/Video/Document`, `buildMediaForm`, `resolveEntities`) onto `TelegramClient` **unchanged in body** except: replace `this.isConfigured()` guards with a check on `this.token`, and drop the `InternalServerErrorException('TELEGRAM_BOT_TOKEN not configured')` (a client always has a token).
3. Add two new methods on `TelegramClient`:

```ts
async deleteWebhook(): Promise<true> {
  return this.callJson<true>('deleteWebhook', { drop_pending_updates: false });
}

async getWebhookInfo(): Promise<{ url: string; last_error_message?: string }> {
  return this.callJson('getWebhookInfo', {});
}
```

4. Replace the body of `TelegramService` with the factory:

```ts
@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);
  private readonly envToken: string;

  constructor(private readonly config: ConfigService) {
    this.envToken = this.config.get<string>('TELEGRAM_BOT_TOKEN', '');
  }

  /** Build a client bound to a specific bot token. Falls back to the env
   *  token only when no token is passed (dev/local). */
  forToken(token?: string): TelegramClient {
    const effective = token ?? this.envToken;
    if (!effective) {
      throw new BadRequestException('No Telegram bot token available.');
    }
    return new TelegramClient(effective, this.logger);
  }
}
```

Keep all existing exported types (`TgUser`, `TgMessage`, `TgEntity`, `TgInlineKeyboardButton`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- telegram.service`
Expected: PASS (3 tests).

- [ ] **Step 5: Compile (consumers will break — that's expected, fixed in later tasks)**

Run: `npm run build`
Expected: TS errors ONLY in `telegram-ingest.processor.ts`, `telegram-dm.adapter.ts`, `telegram-bot-setup.service.ts`, `channels.controller.ts` (they still call old singleton methods). These are fixed in Tasks 4–8. Do not fix unrelated files.

- [ ] **Step 6: Commit**

```bash
git add src/channels/services/telegram.service.ts src/channels/services/telegram.service.spec.ts
git commit -m "feat(telegram): token-parameterized client via forToken()"
```

---

### Task 4: Connect service + endpoint

**Files:**
- Create: `src/channels/services/telegram-connect.service.ts`
- Test: `src/channels/services/telegram-connect.service.spec.ts`
- Create: `src/channels/dto/telegram-connect.dto.ts` (replace old contents)
- Modify: `src/channels/channels.controller.ts` (replace `generateTelegramConnectLink` with `connectTelegramBot`)
- Modify: `src/channels/channels.module.ts` (provide `TelegramConnectService`)

**Interfaces:**
- Consumes: `telegram.forToken`, `channelService.createChannel`, `deriveTelegramWebhookSecret`, `generateTelegramRouteId`.
- Produces:
  - `TelegramConnectService.connect(workspaceId: string, userId: string, token: string): Promise<ChannelResponseDto>`
  - DTO `ConnectTelegramBotDto { token: string }` (class-validator: `@IsString() @IsNotEmpty()`).
  - Endpoint `POST /channels/workspaces/:workspaceId/telegram/connect` body `{ token }`.

- [ ] **Step 1: Write the failing test**

Create `src/channels/services/telegram-connect.service.spec.ts`:

```ts
process.env.TELEGRAM_WEBHOOK_HMAC_SECRET = 'test-secret';
process.env.TELEGRAM_WEBHOOK_BASE_URL = 'https://api.example.com';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { TelegramConnectService } from './telegram-connect.service';

function makeClient(overrides: any = {}) {
  return {
    getMe: jest.fn().mockResolvedValue({ id: 555, is_bot: true, first_name: 'My Bot', username: 'my_bot' }),
    setWebhook: jest.fn().mockResolvedValue(true),
    getWebhookInfo: jest.fn().mockResolvedValue({ url: 'https://api.example.com/webhooks/telegram/x' }),
    getUserProfilePhotoFileId: jest.fn().mockResolvedValue(null),
    ...overrides,
  };
}

describe('TelegramConnectService.connect', () => {
  let telegram: any;
  let channelService: any;
  let assertAccess: jest.Mock;
  let svc: TelegramConnectService;

  beforeEach(() => {
    telegram = { forToken: jest.fn() };
    channelService = {
      findChannelByPlatformAccountGlobal: jest.fn().mockResolvedValue(null),
      createChannel: jest.fn().mockResolvedValue({ id: 10, platform: 'telegram' }),
    };
    assertAccess = jest.fn().mockResolvedValue(undefined);
    svc = new TelegramConnectService(telegram, channelService, { assertWorkspaceAccessPublic: assertAccess } as any);
  });

  it('rejects an invalid token', async () => {
    telegram.forToken.mockReturnValue(makeClient({ getMe: jest.fn().mockRejectedValue(new Error('401')) }));
    await expect(svc.connect('ws', 'u', 'bad')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a bot already connected anywhere (409)', async () => {
    telegram.forToken.mockReturnValue(makeClient());
    channelService.findChannelByPlatformAccountGlobal.mockResolvedValue({ id: 99 });
    await expect(svc.connect('ws', 'u', 'tok')).rejects.toBeInstanceOf(ConflictException);
  });

  it('sets the webhook and creates an encrypted channel row', async () => {
    const client = makeClient();
    telegram.forToken.mockReturnValue(client);
    const res = await svc.connect('ws', 'u', 'tok');
    expect(client.setWebhook).toHaveBeenCalledWith(
      expect.stringMatching(/^https:\/\/api\.example\.com\/webhooks\/telegram\/[0-9a-f]{32}$/),
      expect.stringMatching(/^[0-9a-f]{64}$/),
    );
    const dto = channelService.createChannel.mock.calls[0][2];
    expect(dto.platform).toBe('telegram');
    expect(dto.platformAccountId).toBe('555');
    expect(dto.username).toBe('my_bot');
    expect(dto.telegramWebhookRouteId).toMatch(/^[0-9a-f]{32}$/);
    expect(res).toEqual({ id: 10, platform: 'telegram' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- telegram-connect.service`
Expected: FAIL — cannot find module `./telegram-connect.service`.

- [ ] **Step 3: Extend `setWebhook` signature note + add the global lookup**

In `src/channels/services/channel.service.ts`, add a global (cross-workspace) lookup used for bot uniqueness:

```ts
async findChannelByPlatformAccountGlobal(
  platform: string,
  platformAccountId: string,
): Promise<{ id: number } | null> {
  const [row] = await db
    .select({ id: socialMediaChannels.id })
    .from(socialMediaChannels)
    .where(
      and(
        eq(socialMediaChannels.platform, platform as any),
        eq(socialMediaChannels.platformAccountId, platformAccountId),
      ),
    )
    .limit(1);
  return row ?? null;
}
```

Also extend `CreateChannelDto` (`src/channels/dto/channel.dto.ts`) with an optional field:

```ts
telegramWebhookRouteId?: string;
```

And in `createChannel`, when inserting the new row, pass it through:

```ts
telegramWebhookRouteId: dto.telegramWebhookRouteId ?? null,
```

(Find the `.values({ ... })` insert object in `createChannel` and add this line alongside the other identity fields.)

- [ ] **Step 4: Write the connect service**

Create `src/channels/dto/telegram-connect.dto.ts`:

```ts
import { IsNotEmpty, IsString } from 'class-validator';

export class ConnectTelegramBotDto {
  @IsString()
  @IsNotEmpty()
  token!: string;
}
```

Create `src/channels/services/telegram-connect.service.ts`:

```ts
import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { TelegramService } from './telegram.service';
import { ChannelService } from './channel.service';
import { InboxService } from '../../inbox/inbox.service';
import type { ChannelResponseDto } from '../dto/channel.dto';
import {
  deriveTelegramWebhookSecret,
  generateTelegramRouteId,
} from '../utils/telegram-webhook-secret.util';

@Injectable()
export class TelegramConnectService {
  private readonly logger = new Logger(TelegramConnectService.name);

  constructor(
    private readonly telegram: TelegramService,
    private readonly channelService: ChannelService,
    private readonly inbox: InboxService,
  ) {}

  async connect(
    workspaceId: string,
    userId: string,
    token: string,
  ): Promise<ChannelResponseDto> {
    await this.inbox.assertWorkspaceAccessPublic(workspaceId, userId);

    const client = this.telegram.forToken(token.trim());

    // 1. Validate the token.
    let me: { id: number; first_name: string; username?: string };
    try {
      me = await client.getMe();
    } catch {
      throw new BadRequestException(
        'Invalid bot token. Re-copy it from @BotFather and try again.',
      );
    }

    // 2. Global uniqueness — Telegram allows exactly one webhook per bot.
    const existing = await this.channelService.findChannelByPlatformAccountGlobal(
      'telegram',
      String(me.id),
    );
    if (existing) {
      throw new ConflictException(
        'This bot is already connected. Disconnect it first, or use a different bot.',
      );
    }

    // 3. Route + derived secret, set the webhook, verify.
    const routeId = generateTelegramRouteId();
    const secret = deriveTelegramWebhookSecret(routeId);
    const base = (
      process.env.TELEGRAM_WEBHOOK_BASE_URL ||
      process.env.API_PUBLIC_URL ||
      ''
    )
      .trim()
      .replace(/\/+$/, '');
    if (!base) {
      throw new BadRequestException(
        'Server webhook base URL is not configured.',
      );
    }
    const url = `${base}/webhooks/telegram/${routeId}`;
    await client.setWebhook(url, secret);
    const info = await client.getWebhookInfo();
    if (info.last_error_message) {
      this.logger.warn(
        `setWebhook verify warning for @${me.username}: ${info.last_error_message}`,
      );
    }

    // 4. Best-effort bot avatar.
    let profilePictureUrl: string | undefined;
    try {
      const fileId = await client.getUserProfilePhotoFileId(me.id);
      if (fileId) {
        const file = await client.getFile(fileId);
        if (file.file_path) {
          profilePictureUrl = `https://api.telegram.org/file/bot${token.trim()}/${file.file_path}`;
        }
      }
    } catch {
      // ignore — initials fallback in UI
    }

    // 5. Persist (createChannel encrypts the token).
    return this.channelService.createChannel(workspaceId, userId, {
      platform: 'telegram',
      accountType: 'bot',
      platformAccountId: String(me.id),
      accountName: me.first_name,
      username: (me.username ?? '').replace(/^@/, ''),
      profilePictureUrl,
      accessToken: token.trim(),
      telegramWebhookRouteId: routeId,
      permissions: [],
      capabilities: {
        canPost: false,
        canSchedule: false,
        canReadAnalytics: false,
        canReply: true,
        canDelete: true,
        supportedMediaTypes: ['image', 'video', 'audio', 'file'],
        maxMediaPerPost: 1,
        maxTextLength: 4096,
      },
      metadata: { mode: 'custom_bot', botId: me.id },
    } as any);
  }
}
```

> NOTE: `setWebhook(url, secret)` already exists on the client and internally sets `allowed_updates`. The avatar URL stored here embeds the token; if that is undesirable, a follow-up can rehost to R2 — out of scope for this task.

- [ ] **Step 5: Wire the controller endpoint**

In `src/channels/channels.controller.ts`:
- Add imports: `TelegramConnectService`, `ConnectTelegramBotDto`.
- Inject `private readonly telegramConnectService: TelegramConnectService` into the constructor.
- Replace the `generateTelegramConnectLink` method with:

```ts
@Post('workspaces/:workspaceId/telegram/connect')
@UseGuards(JwtAuthGuard)
@HttpCode(HttpStatus.OK)
async connectTelegramBot(
  @Param('workspaceId') workspaceId: string,
  @Body() dto: ConnectTelegramBotDto,
  @CurrentUser() user: { userId: string; email: string },
) {
  return this.telegramConnectService.connect(workspaceId, user.userId, dto.token);
}
```

Leave `checkTelegramBinding` for now (removed in Task 8).

- [ ] **Step 6: Register the service**

In `src/channels/channels.module.ts`, add `TelegramConnectService` to the `providers` array (import it at top). `InboxService` must be resolvable here — it already is (ChannelsModule imports the inbox surface for the existing telegram endpoints). If a circular import surfaces, inject `InboxService` with `forwardRef` matching the existing pattern in this module.

- [ ] **Step 7: Run the connect service test**

Run: `npm test -- telegram-connect.service`
Expected: PASS (3 tests).

- [ ] **Step 8: Commit**

```bash
git add src/channels/services/telegram-connect.service.ts src/channels/services/telegram-connect.service.spec.ts src/channels/dto/telegram-connect.dto.ts src/channels/dto/channel.dto.ts src/channels/services/channel.service.ts src/channels/channels.controller.ts src/channels/channels.module.ts
git commit -m "feat(telegram): token connect endpoint (validate, setWebhook, store)"
```

---

### Task 5: Disconnect removes the webhook

**Files:**
- Modify: `src/channels/channels.controller.ts` (`deleteChannel`)

**Interfaces:**
- Consumes: `channelService.getChannelById`, `channelService.getAccessToken`, `telegram.forToken().deleteWebhook()`.

- [ ] **Step 1: Update `deleteChannel` to clear the Telegram webhook first**

Replace the `deleteChannel` body in `src/channels/channels.controller.ts`:

```ts
async deleteChannel(
  @Param('workspaceId') workspaceId: string,
  @Param('channelId') channelId: string,
) {
  const id = parseInt(channelId, 10);
  // Telegram: best-effort remove the bot's webhook before deleting the row,
  // so a re-add of the same bot can set a fresh webhook cleanly.
  try {
    const channel = await this.channelService.getChannelById(id, workspaceId);
    if (channel.platform === 'telegram') {
      const token = await this.channelService.getAccessToken(id, workspaceId);
      await this.telegramService.forToken(token).deleteWebhook();
    }
  } catch (err) {
    this.logger.warn(
      `Telegram deleteWebhook on disconnect failed (non-blocking): ${(err as Error).message}`,
    );
  }
  await this.channelService.deleteChannel(id, workspaceId);
}
```

(If the controller has no `logger`, use `console.warn` to match the file's existing logging style, or add `private readonly logger = new Logger(ChannelsController.name)`.)

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: compiles (the connect path and disconnect now use `forToken`).

- [ ] **Step 3: Commit**

```bash
git add src/channels/channels.controller.ts
git commit -m "feat(telegram): remove webhook on channel disconnect"
```

---

### Task 6: Per-bot webhook route

**Files:**
- Modify: `src/channels/webhooks.controller.ts`
- Modify: `src/inbox/inbox.service.ts` (add `findTelegramChannelByRouteId`)

**Interfaces:**
- Consumes: `verifyTelegramWebhookSecret`, the `TELEGRAM_INGEST` queue.
- Produces:
  - `inbox.findTelegramChannelByRouteId(routeId): Promise<{ id: number; workspaceId: string } | null>`
  - Route `POST /webhooks/telegram/:routeId` enqueueing `{ channelId, workspaceId, update }`.

- [ ] **Step 1: Add the channel lookup to InboxService**

In `src/inbox/inbox.service.ts`, add:

```ts
async findTelegramChannelByRouteId(
  routeId: string,
): Promise<{ id: number; workspaceId: string } | null> {
  const [row] = await db
    .select({ id: socialMediaChannels.id, workspaceId: socialMediaChannels.workspaceId })
    .from(socialMediaChannels)
    .where(eq(socialMediaChannels.telegramWebhookRouteId, routeId))
    .limit(1);
  return row ?? null;
}
```

(Ensure `socialMediaChannels` and `eq` are imported in this file — they are used elsewhere in it.)

- [ ] **Step 2: Replace the Telegram webhook route**

In `src/channels/webhooks.controller.ts`:
- Remove the `TELEGRAM_WEBHOOK_SECRET` field and the old `@Post('telegram')` handler.
- Add import: `import { verifyTelegramWebhookSecret } from './utils/telegram-webhook-secret.util';`
- Add the new route:

```ts
@Post('telegram/:routeId')
@HttpCode(HttpStatus.OK)
async receiveTelegramUpdate(
  @Param('routeId') routeId: string,
  @Headers('x-telegram-bot-api-secret-token') headerSecret: string | undefined,
  @Body() update: Record<string, unknown>,
) {
  const channel = await this.inbox.findTelegramChannelByRouteId(routeId);
  if (!channel) {
    this.logger.warn(`Telegram webhook: unknown routeId ${routeId}`);
    return { ok: true };
  }
  if (!verifyTelegramWebhookSecret(routeId, headerSecret)) {
    this.logger.warn(`Telegram webhook secret mismatch for routeId ${routeId}`);
    throw new HttpException('Forbidden', HttpStatus.FORBIDDEN);
  }
  await this.telegramQueue.add(
    'update',
    { channelId: channel.id, workspaceId: channel.workspaceId, update },
    { removeOnComplete: true, attempts: 3 },
  );
  return { ok: true };
}
```

Add `Param` to the `@nestjs/common` import if not present.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: compiles (ingest processor still reads old job shape — fixed next task; it will still compile because job data is `Record<string, unknown>`).

- [ ] **Step 4: Commit**

```bash
git add src/channels/webhooks.controller.ts src/inbox/inbox.service.ts
git commit -m "feat(telegram): per-bot webhook route with derived-secret verification"
```

---

### Task 7: Channel-aware ingest processor

**Files:**
- Modify: `src/inbox/processors/telegram-ingest.processor.ts`

**Interfaces:**
- Consumes: job data `{ channelId: number; workspaceId: string; update: Record<string, unknown> }`; `channelService.getAccessToken`; `telegram.forToken`.

- [ ] **Step 1: Rewrite `process()` to be channel-scoped**

In `src/inbox/processors/telegram-ingest.processor.ts`:
- Inject `ChannelService` (add to constructor).
- Replace the top of `process()`:

```ts
async process(job: Job<Record<string, unknown>>): Promise<void> {
  const channelId = job.data.channelId as number;
  const workspaceId = job.data.workspaceId as string;
  const update = job.data.update as Record<string, unknown>;
  if (!channelId || !workspaceId || !update) {
    this.logger.warn(`Telegram ingest: malformed job ${job.id} — skipping`);
    return;
  }

  const [channel] = await db
    .select()
    .from(socialMediaChannels)
    .where(eq(socialMediaChannels.id, channelId))
    .limit(1);
  if (!channel) {
    this.logger.warn(`Telegram ingest: channel ${channelId} not found`);
    return;
  }
  const botId = Number(channel.platformAccountId);
  const token = await this.channelService.getAccessToken(channelId, workspaceId);
  const tg = this.telegram.forToken(token);

  const message = update.message as TgMessage | undefined;
  if (!message) return; // edited_message / callback_query / my_chat_member: ignored in this phase
  if (message.from?.is_bot && message.from.id === botId) return;

  await this.ingestPlainMessage(tg, channel, workspaceId, message);
}
```

- Delete `handleStartBinding`, `handleMyChatMember`, `handleCallbackQuery`, `ensureTelegramChannel`, the `botId`/`avatarCache` lazy-getMe logic, and the `telegramChatBindings` import.
- Change `ingestPlainMessage` signature to `(tg: TelegramClient, channel: <row type>, workspaceId: string, message: TgMessage)` and replace every `this.telegram.X(...)` with `tg.X(...)`, every `binding.workspaceId` with `workspaceId`, and remove the binding lookup block (the early `if (!binding) return`). Use `channel.id` and `workspaceId` directly.
- Change `resolveAuthorAvatar(authorId, workspaceId, channelId)` to also take `tg` and use `tg.getUserProfilePhotoFileId/getFile/downloadFile`.
- Import `TelegramClient` from `../../channels/services/telegram.service`.

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: compiles with no Telegram-related errors.

- [ ] **Step 3: Manual smoke (deferred to live test)**

This processor needs a live bot + webhook; covered in Task 12's manual checklist. No unit test here (pure I/O orchestration).

- [ ] **Step 4: Commit**

```bash
git add src/inbox/processors/telegram-ingest.processor.ts
git commit -m "feat(telegram): channel-aware ingest (per-bot token, no binding gate)"
```

---

### Task 8: Remove obsolete shared-bot code

**Files:**
- Delete: `src/channels/services/telegram-bot-setup.service.ts`
- Modify: `src/channels/channels.module.ts` (drop `TelegramBotSetupService` provider)
- Modify: `src/channels/channels.controller.ts` (remove `checkTelegramBinding`, old `telegram-bindings` import if now unused)
- Modify: `src/inbox/adapters/telegram-dm.adapter.ts` (use `forToken`)
- Modify: `src/channels/dto/telegram-connect.dto.ts` (drop `GenerateConnectLinkResponse`, `CheckBindingResponse` if defined there)

**Interfaces:**
- Consumes: `channelService.getAccessToken` inside the DM adapter.

- [ ] **Step 1: Update the Telegram DM adapter to use a per-channel token**

In `src/inbox/adapters/telegram-dm.adapter.ts`, the `deleteDm` (and any send) path must build a client from the channel token. Replace direct `this.telegram.deleteMessage(...)` with:

```ts
async deleteDm(channel: ResolvedChannel, conversationId: string, platformItemId: string): Promise<boolean> {
  await this.telegram
    .forToken(channel.accessToken)
    .deleteMessage(conversationId, Number(platformItemId));
  return true;
}
```

(`ResolvedChannel.accessToken` is already the decrypted token — same field the Slack adapter uses.)

- [ ] **Step 2: Delete the boot-time setup service**

```bash
git rm src/channels/services/telegram-bot-setup.service.ts
```

Remove its import and `providers`/`OnModuleInit` registration from `src/channels/channels.module.ts`.

- [ ] **Step 3: Remove the binding-check endpoint**

In `src/channels/channels.controller.ts`, delete the `checkTelegramBinding` method and the now-unused `telegramChatBindings` import and `telegram-connect.dto` response-type imports. In `src/channels/dto/telegram-connect.dto.ts`, keep only `ConnectTelegramBotDto`.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: compiles cleanly across the whole backend.

- [ ] **Step 5: Run the full telegram-related test set**

Run: `npm test -- telegram`
Expected: PASS (secret util + service + connect service).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(telegram): remove shared-bot setup, deep-link + binding endpoints"
```

---

### Task 9: Backend build + lint gate

- [ ] **Step 1: Full build**

Run: `npm run build`
Expected: success.

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: no new errors.

- [ ] **Step 3: Commit (only if lint auto-fixed anything)**

```bash
git add -A
git commit -m "chore(telegram): lint pass"
```

---

## Phase B — Frontend (START ONLY AFTER EXPLICIT GO-AHEAD)

> Per CLAUDE.md: present backend completion and get approval before this phase.

### Task 10: Connect API + schema + hook

**Files:**
- Modify: `src/features/channels/api/telegram.api.ts`
- Create: `src/features/channels/schemas/telegram-connect.schema.ts`
- Modify: `src/features/channels/hooks/use-connect-telegram.ts`

**Interfaces:**
- Produces:
  - `connectTelegramBot(workspaceId: string, token: string): Promise<Channel>`
  - `telegramConnectSchema` (zod: `{ token: string().min(20) }`)
  - `useConnectTelegramBot()` mutation hook.

- [ ] **Step 1: Replace the API module**

In `src/features/channels/api/telegram.api.ts`, remove `generateTelegramConnectLink` / binding-poll calls; add:

```ts
import { apiClient } from '@/lib/api'
import type { Channel } from '@/types/channels'

export async function connectTelegramBot(
  workspaceId: string,
  token: string,
): Promise<Channel> {
  const { data } = await apiClient.post<Channel>(
    `/channels/workspaces/${workspaceId}/telegram/connect`,
    { token },
  )
  return data
}
```

(Use the actual `Channel` type path used elsewhere in this feature.)

- [ ] **Step 2: Add the zod schema**

Create `src/features/channels/schemas/telegram-connect.schema.ts`:

```ts
import { z } from 'zod'

export const telegramConnectSchema = z.object({
  token: z
    .string()
    .trim()
    .min(20, 'That doesn’t look like a bot token. Copy it from @BotFather.')
    .regex(/^\d+:[A-Za-z0-9_-]+$/, 'Token format looks wrong (expected 123456:ABC...).'),
})

export type TelegramConnectValues = z.infer<typeof telegramConnectSchema>
```

- [ ] **Step 3: Replace the hook**

In `src/features/channels/hooks/use-connect-telegram.ts`, remove the generate+poll hooks; add:

```ts
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { connectTelegramBot } from '../api/telegram.api'
import { channelKeys } from '@/lib/queryClient'

export function useConnectTelegramBot(workspaceId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (token: string) => connectTelegramBot(workspaceId, token),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: channelKeys.list(workspaceId) })
    },
  })
}
```

(Match the real query-key factory + import paths in the codebase.)

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: compiles.

- [ ] **Step 5: Commit**

```bash
git add src/features/channels/api/telegram.api.ts src/features/channels/schemas/telegram-connect.schema.ts src/features/channels/hooks/use-connect-telegram.ts
git commit -m "feat(telegram): frontend connect API + schema + hook"
```

---

### Task 11: Connect dialog (shadcn)

**Files:**
- Create: `src/features/channels/components/connect-telegram-dialog.tsx`

**Interfaces:**
- Consumes: `useConnectTelegramBot`, `telegramConnectSchema`.
- Produces: `<ConnectTelegramDialog workspaceId onConnected? />`.

- [ ] **Step 1: Confirm shadcn components exist**

Verify `dialog`, `form`, `input`, `button` are installed (`src/components/ui/`). If any is missing, install via the shadcn MCP (`get_add_command_for_items`) — do NOT hand-roll.

- [ ] **Step 2: Build the dialog**

Create `src/features/channels/components/connect-telegram-dialog.tsx` — a `Dialog` containing a shadcn `Form` (RHF + `zodResolver(telegramConnectSchema)`), one `Input` for the token, an inline helper (ordered list: open @BotFather → `/newbot` → copy token), and a submit `Button` with `Loader2` spinner while pending. On success: `toast.success`, call `onConnected?.()`, close. On error: show `error.message` (400/409) via inline `FormMessage` fallback + `toast.error`. Use only theme tokens; `gap-*`/`space-y-*` spacing per Rule 3.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: compiles.

- [ ] **Step 4: Commit**

```bash
git add src/features/channels/components/connect-telegram-dialog.tsx
git commit -m "feat(telegram): connect dialog (shadcn form + BotFather helper)"
```

---

### Task 12: Wire into channel grid + remove old button + live test

**Files:**
- Modify: `src/features/channels/components/connect-channel-grid.tsx`
- Delete: `src/features/channels/components/connect-telegram-button.tsx`

- [ ] **Step 1: Swap the trigger**

In `connect-channel-grid.tsx`, replace `<ConnectTelegramButton .../>` usage with the new `<ConnectTelegramDialog workspaceId={...} onConnected={refetch} />`. Remove the import of the old button.

- [ ] **Step 2: Delete the old button**

```bash
git rm src/features/channels/components/connect-telegram-button.tsx
```

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: compiles, no references to the deleted button.

- [ ] **Step 4: Live manual test (user-driven on Railway)**

Checklist:
1. `node scripts/apply-telegram-route-id-migration.mjs` on prod DB; set `TELEGRAM_WEBHOOK_HMAC_SECRET`.
2. Connect a real @BotFather bot via the dialog → channel appears.
3. DM the bot from a personal account → message lands in inbox (text, image, voice, file).
4. Reply (text + each media type) → arrives in Telegram.
5. Delete a sent message → removed in Telegram.
6. Connect a **second** bot in the same workspace → both isolated, both ingest.
7. Disconnect → `getWebhookInfo` for that bot shows empty url.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(telegram): use connect dialog in channel grid; remove deep-link button"
```

---

## Self-Review Notes

- **Spec coverage:** schema column (T1), derived secret (T2), token-parameterized service (T3), connect validate/uniqueness/setWebhook/verify/avatar/store (T4), disconnect deleteWebhook (T5), per-bot webhook route (T6), channel-aware ingest no-binding (T7), obsolete removal (T8), frontend form (T10–12). Auto-flow = no `/start` handler in T7. Multiple-bots = global uniqueness + per-channel rows (T4) + route lookup (T6).
- **Deferred (per spec §11):** `telegram_chat_bindings` table left in place (only its reads/writes removed); bot avatar best-effort (T4).
- **Type consistency:** `forToken(token)` → `TelegramClient` used identically in T3/T4/T5/T7/T8; job shape `{ channelId, workspaceId, update }` produced in T6, consumed in T7; `telegramWebhookRouteId` defined T1, written T4, read T6.
