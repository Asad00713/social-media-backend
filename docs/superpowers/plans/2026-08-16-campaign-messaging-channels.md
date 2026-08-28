# Campaign Messaging Channels (Slack + Discord) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let campaigns (bulk + drip) publish to Slack and Discord using a chat-style composer (one message + one optional media) with a required destination picker.

**Architecture:** Backend-first. A new optional `destination` field on `PostTarget` carries the Slack/Discord channel id from composer → post → publisher. Two thin publishers wrap the existing `SlackService`/`DiscordService` (no new API clients) and register in `PublisherFactory`. Frontend adds a `'message'` post type for slack/discord, a `MessageComposer` (message box + destination picker + single media), and launch validation requiring a destination.

**Tech Stack:** NestJS + Drizzle (backend, repo `socialmedia-workspace`); Vite + React 19 + TS + Tailwind 3 + shadcn + TanStack Query (frontend, worktree `socialmedia-frontend-campaigns`). Both on branch `feat/campaign-messaging-channels` off `main`.

**Spec:** `socialmedia-workspace/docs/superpowers/specs/2026-08-16-campaign-messaging-channels-design.md`

## Global Constraints

- **Scope: Slack + Discord ONLY.** Do NOT add telegram/whatsapp to `PLATFORM_POST_TYPES.types` or `PublisherFactory` — both are deferred (WhatsApp needs message templates; Telegram bots can't enumerate chats).
- **NO DB migration.** `posts.targets` is `jsonb().$type<PostTarget[]>()` and `PostTarget` is a plain TS interface — adding an optional nested field is a pure type change.
- **shadcn-only UI**, theme tokens only (no hex, no arbitrary Tailwind colors like `bg-blue-500`). Use shadcn MCP to confirm any new component.
- **Never** `git add .`/`-A`. Surgical `git add <path>` only (FE `.env` is git-tracked with secrets; BE `.env` is gitignored with secrets).
- **Bulk behaviour for non-messaging platforms stays byte-for-byte unchanged.**
- Slack posts to public channels without joining (`chat:write.public` already granted); the picker flags/disables private channels where `isMember === false`.
- Discord publisher uses the shared env `DISCORD_BOT_TOKEN` (ignores `accessToken`); Slack uses the per-channel decrypted token.
- Destination is **required** — a messaging slot without a destination blocks launch.
- Media cap = 1 (text-only allowed; media optional; never >1).

---

## BACKEND (do all backend tasks before frontend)

### Task 1: `destination` field on `PostTarget`

**Files:**
- Modify: `socialmedia-workspace/src/drizzle/schema/posts.schema.ts:52-61` (the `PostTarget` interface)

**Interfaces:**
- Produces: `PostTarget.destination?: { id: string; name?: string }` — consumed by Tasks 2, 3, 4, 6.

- [ ] **Step 1: Add the optional field.** In the `PostTarget` interface, after `contentOverride?: PlatformContent;`, add:

```ts
  /**
   * Sub-destination for chat/messaging platforms (Slack/Discord): which
   * Slack channel / Discord text channel the message goes to. Absent for
   * every social platform (they publish to the account itself). `id` is the
   * platform channel id; `name` is a human label for display/audit.
   */
  destination?: {
    id: string;
    name?: string;
  };
```

- [ ] **Step 2: Verify compile.**

Run: `cd socialmedia-workspace && npm run build`
Expected: exit 0 (pure type addition; no existing code references it yet).

- [ ] **Step 3: Commit.**

```bash
git add src/drizzle/schema/posts.schema.ts
git commit -m "feat(posts): optional destination on PostTarget for messaging platforms"
```

---

### Task 2: Thread `destination` into publisher metadata

**Files:**
- Modify: `socialmedia-workspace/src/posts/services/post.service.ts:795-798` (the `mergedMetadata` build)

**Interfaces:**
- Consumes: `PostTarget.destination` (Task 1).
- Produces: `options.metadata.destination` reaching every publisher — consumed by Tasks 3 (Slack) & 4 (Discord).

**Context:** `mergedMetadata` is built from `post.metadata` + `platformSpecific` and passed as `publish({ metadata: mergedMetadata, ... })` at line 810-813. It currently does NOT include `target.destination`. Add it so messaging publishers can read the destination the same way RedditPublisher reads `metadata.subreddit`.

- [ ] **Step 1: Add destination to mergedMetadata.** Change the `mergedMetadata` object (currently lines 795-798) to include the target's destination:

```ts
    const mergedMetadata: Record<string, any> = {
      ...postMetadata,
      ...platformSpecific,
      // Messaging platforms (Slack/Discord) read their sub-destination
      // (which channel to post to) from here; absent for social platforms.
      ...(target.destination ? { destination: target.destination } : {}),
    };
```

- [ ] **Step 2: Verify compile.**

Run: `cd socialmedia-workspace && npm run build`
Expected: exit 0.

- [ ] **Step 3: Commit.**

```bash
git add src/posts/services/post.service.ts
git commit -m "feat(posts): pass PostTarget.destination through to publisher metadata"
```

---

### Task 3: `SlackPublisher`

**Files:**
- Create: `socialmedia-workspace/src/posts/publishers/slack.publisher.ts`
- Test: `socialmedia-workspace/src/posts/publishers/slack.publisher.spec.ts`

**Interfaces:**
- Consumes: `SlackService.postMessage(botToken, { channel, text, threadTs? })` (`src/channels/services/slack.service.ts:90`), `SlackService.uploadFile(botToken, { channelId, filename, contentType, buffer, initialComment? })` (`:352`); `options.metadata.destination` (Task 2).
- Produces: `SlackPublisher` (registered in Task 5).

**Reference:** `src/posts/publishers/reddit.publisher.ts` — same shape (constructor-inject the channel service, `validate` reads metadata, `publish` delegates).

- [ ] **Step 1: Write the failing test.** `slack.publisher.spec.ts`:

```ts
import { SlackPublisher } from './slack.publisher';
import type { PublishOptions } from './base.publisher';

function baseOptions(over: Partial<PublishOptions> = {}): PublishOptions {
  return {
    content: 'hello team',
    mediaItems: [],
    metadata: { destination: { id: 'C123', name: '#general' } },
    accessToken: 'xoxb-token',
    platformAccountId: 'T1',
    channelMetadata: {},
    channelId: 7,
    ...over,
  };
}

describe('SlackPublisher', () => {
  function make() {
    const postMessage = jest.fn().mockResolvedValue({ ts: '1700000000.0001', channel: 'C123' });
    const uploadFile = jest.fn().mockResolvedValue({ ts: '1700000000.0002' });
    const slackService = { postMessage, uploadFile } as never;
    return { publisher: new SlackPublisher(slackService), postMessage, uploadFile };
  }

  it('rejects a missing destination', () => {
    const { publisher } = make();
    expect(() => publisher.validate(baseOptions({ metadata: {} }))).toThrow(/destination/i);
  });

  it('rejects more than one media item', () => {
    const { publisher } = make();
    const media = [
      { url: 'a', type: 'image' as const },
      { url: 'b', type: 'image' as const },
    ];
    expect(() => publisher.validate(baseOptions({ mediaItems: media }))).toThrow(/one media/i);
  });

  it('rejects empty message with no media', () => {
    const { publisher } = make();
    expect(() => publisher.validate(baseOptions({ content: '', mediaItems: [] }))).toThrow(/message or media/i);
  });

  it('posts a text-only message to the destination channel', async () => {
    const { publisher, postMessage, uploadFile } = make();
    const res = await publisher.publish(baseOptions());
    expect(postMessage).toHaveBeenCalledWith('xoxb-token', { channel: 'C123', text: 'hello team' });
    expect(uploadFile).not.toHaveBeenCalled();
    expect(res.platformPostId).toBe('1700000000.0001');
  });
});
```

- [ ] **Step 2: Run test to verify it fails.**

Run: `cd socialmedia-workspace && npx jest src/posts/publishers/slack.publisher.spec.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `SlackPublisher`.** Media path uses global `fetch` (Node 18+) to download the URL into a Buffer, mirroring `twitter.publisher.ts`. `slack.publisher.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { BasePublisher, PublishOptions, PublishResult } from './base.publisher';
import { SlackService } from '../../channels/services/slack.service';
import { MediaItem } from '../../drizzle/schema/posts.schema';
import { SupportedPlatform } from '../../drizzle/schema/channels.schema';

interface Destination {
  id: string;
  name?: string;
}

/**
 * Slack publisher — sends a single message (text and/or one media) to a chosen
 * Slack channel. The destination channel id comes from
 * `metadata.destination.id` (set by the campaign composer's destination
 * picker, threaded through PostTarget.destination). Uses the per-channel bot
 * token (`chat:write.public` lets it post to public channels without joining).
 */
@Injectable()
export class SlackPublisher extends BasePublisher {
  readonly platform: SupportedPlatform = 'slack';

  constructor(private readonly slackService: SlackService) {
    super();
  }

  private destination(options: PublishOptions): Destination | undefined {
    return options.metadata?.destination as Destination | undefined;
  }

  validate(options: PublishOptions): void {
    const dest = this.destination(options);
    if (!dest?.id) {
      throw new Error('Slack message requires a destination channel');
    }
    if (options.mediaItems.length > 1) {
      throw new Error('Slack message supports at most one media item');
    }
    const hasText = (options.content ?? '').trim().length > 0;
    if (!hasText && options.mediaItems.length === 0) {
      throw new Error('Slack message requires a message or media');
    }
  }

  supportsMediaTypes(mediaItems: MediaItem[]): boolean {
    return mediaItems.length <= 1;
  }

  async publish(options: PublishOptions): Promise<PublishResult> {
    this.validate(options);
    const dest = this.destination(options) as Destination;
    const { content, mediaItems, accessToken } = options;

    if (mediaItems.length === 0) {
      const res = await this.slackService.postMessage(accessToken, {
        channel: dest.id,
        text: content ?? '',
      });
      this.logger.log(`Posted Slack message to ${dest.id}: ${res.ts}`);
      return { platformPostId: res.ts };
    }

    const media = mediaItems[0];
    const resp = await fetch(media.url);
    if (!resp.ok) {
      throw new Error(`Failed to download Slack media (${resp.status})`);
    }
    const buffer = Buffer.from(await resp.arrayBuffer());
    const contentType = resp.headers.get('content-type') ?? 'application/octet-stream';
    const filename = media.url.split('/').pop()?.split('?')[0] || 'attachment';

    const res = await this.slackService.uploadFile(accessToken, {
      channelId: dest.id,
      filename,
      contentType,
      buffer,
      initialComment: content || undefined,
    });
    this.logger.log(`Uploaded Slack file to ${dest.id}`);
    return { platformPostId: (res as { ts?: string })?.ts ?? dest.id };
  }
}
```

**Note for implementer:** open `src/channels/services/slack.service.ts` and confirm the exact return shape of `postMessage` (expected `{ ts, channel }`) and `uploadFile`; adjust the `platformPostId` extraction to the real field names if they differ. Keep the test in sync.

- [ ] **Step 4: Run tests to verify they pass.**

Run: `cd socialmedia-workspace && npx jest src/posts/publishers/slack.publisher.spec.ts`
Expected: PASS (all 4).

- [ ] **Step 5: Commit.**

```bash
git add src/posts/publishers/slack.publisher.ts src/posts/publishers/slack.publisher.spec.ts
git commit -m "feat(publishers): SlackPublisher — single message + optional media to a chosen channel"
```

---

### Task 4: `DiscordPublisher`

**Files:**
- Create: `socialmedia-workspace/src/posts/publishers/discord.publisher.ts`
- Test: `socialmedia-workspace/src/posts/publishers/discord.publisher.spec.ts`

**Interfaces:**
- Consumes: `DiscordService.createMessage(channelId, { content?, files? })` (`src/channels/services/discord.service.ts:27`), `files: { name, data: Buffer, contentType? }[]`; `options.metadata.destination` (Task 2).
- Produces: `DiscordPublisher` (registered in Task 5).

- [ ] **Step 1: Write the failing test.** `discord.publisher.spec.ts`:

```ts
import { DiscordPublisher } from './discord.publisher';
import type { PublishOptions } from './base.publisher';

function baseOptions(over: Partial<PublishOptions> = {}): PublishOptions {
  return {
    content: 'gm',
    mediaItems: [],
    metadata: { destination: { id: 'D999', name: 'general' } },
    accessToken: 'ignored',
    platformAccountId: 'guild1',
    channelMetadata: {},
    channelId: 3,
    ...over,
  };
}

describe('DiscordPublisher', () => {
  function make() {
    const createMessage = jest.fn().mockResolvedValue({ id: 'msg-1' });
    const discordService = { createMessage } as never;
    return { publisher: new DiscordPublisher(discordService), createMessage };
  }

  it('rejects a missing destination', () => {
    const { publisher } = make();
    expect(() => publisher.validate(baseOptions({ metadata: {} }))).toThrow(/destination/i);
  });

  it('rejects more than one media item', () => {
    const { publisher } = make();
    const media = [
      { url: 'a', type: 'image' as const },
      { url: 'b', type: 'image' as const },
    ];
    expect(() => publisher.validate(baseOptions({ mediaItems: media }))).toThrow(/one media/i);
  });

  it('sends a text-only message to the destination channel', async () => {
    const { publisher, createMessage } = make();
    const res = await publisher.publish(baseOptions());
    expect(createMessage).toHaveBeenCalledWith('D999', { content: 'gm', files: undefined });
    expect(res.platformPostId).toBe('msg-1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails.**

Run: `cd socialmedia-workspace && npx jest src/posts/publishers/discord.publisher.spec.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `DiscordPublisher`.** `discord.publisher.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { BasePublisher, PublishOptions, PublishResult } from './base.publisher';
import { DiscordService } from '../../channels/services/discord.service';
import { MediaItem } from '../../drizzle/schema/posts.schema';
import { SupportedPlatform } from '../../drizzle/schema/channels.schema';

interface Destination {
  id: string;
  name?: string;
}

/**
 * Discord publisher — sends a single message (text and/or one media) to a
 * chosen guild text channel. Destination channel id comes from
 * `metadata.destination.id`. Uses the shared env DISCORD_BOT_TOKEN baked into
 * DiscordService (ignores `options.accessToken`, unlike per-channel-token
 * platforms).
 */
@Injectable()
export class DiscordPublisher extends BasePublisher {
  readonly platform: SupportedPlatform = 'discord';

  constructor(private readonly discordService: DiscordService) {
    super();
  }

  private destination(options: PublishOptions): Destination | undefined {
    return options.metadata?.destination as Destination | undefined;
  }

  validate(options: PublishOptions): void {
    const dest = this.destination(options);
    if (!dest?.id) {
      throw new Error('Discord message requires a destination channel');
    }
    if (options.mediaItems.length > 1) {
      throw new Error('Discord message supports at most one media item');
    }
    const hasText = (options.content ?? '').trim().length > 0;
    if (!hasText && options.mediaItems.length === 0) {
      throw new Error('Discord message requires a message or media');
    }
  }

  supportsMediaTypes(mediaItems: MediaItem[]): boolean {
    return mediaItems.length <= 1;
  }

  async publish(options: PublishOptions): Promise<PublishResult> {
    this.validate(options);
    const dest = this.destination(options) as Destination;
    const { content, mediaItems } = options;

    let files: { name: string; data: Buffer; contentType?: string }[] | undefined;
    if (mediaItems.length === 1) {
      const media = mediaItems[0];
      const resp = await fetch(media.url);
      if (!resp.ok) {
        throw new Error(`Failed to download Discord media (${resp.status})`);
      }
      const data = Buffer.from(await resp.arrayBuffer());
      const contentType = resp.headers.get('content-type') ?? undefined;
      const name = media.url.split('/').pop()?.split('?')[0] || 'attachment';
      files = [{ name, data, contentType }];
    }

    const res = await this.discordService.createMessage(dest.id, {
      content: content || undefined,
      files,
    });
    this.logger.log(`Posted Discord message to ${dest.id}: ${res.id}`);
    return { platformPostId: res.id };
  }
}
```

**Note for implementer:** confirm `DiscordService.createMessage` return shape has `.id`; confirm the `files` field name/shape matches its signature (`src/channels/services/discord.service.ts:27`). Adjust and keep the test in sync.

- [ ] **Step 4: Run tests to verify they pass.**

Run: `cd socialmedia-workspace && npx jest src/posts/publishers/discord.publisher.spec.ts`
Expected: PASS (all 3).

- [ ] **Step 5: Commit.**

```bash
git add src/posts/publishers/discord.publisher.ts src/posts/publishers/discord.publisher.spec.ts
git commit -m "feat(publishers): DiscordPublisher — single message + optional media to a chosen channel"
```

---

### Task 5: Register both publishers in `PublisherFactory`

**Files:**
- Modify: `socialmedia-workspace/src/posts/publishers/publisher.factory.ts`
- Test: `socialmedia-workspace/src/posts/publishers/publisher.factory.spec.ts` (create if absent)
- Modify: the module that provides the factory + publishers (find via Step 1 — likely `src/posts/posts.module.ts`)

**Interfaces:**
- Consumes: `SlackPublisher` (Task 3), `DiscordPublisher` (Task 4).
- Produces: `getPublisher('slack')` / `getPublisher('discord')` return the publishers instead of throwing.

- [ ] **Step 1: Locate the provider wiring.** Find where `PublisherFactory` and the existing publishers are declared as NestJS providers (grep `PublisherFactory` and `RedditPublisher` across `src/posts/`). Note the module file and confirm `SlackService`/`DiscordService` are available there (they're in `ChannelsModule`; check that `PostsModule` imports it or the services are exported — RedditPublisher already injects `RedditService` from the same ChannelsModule, so the wiring pattern exists). Record findings in the report.

- [ ] **Step 2: Write/extend the failing factory test.** Assert the two new platforms resolve. Construct the factory with mock publishers or real instances given mock services. Minimal:

```ts
// asserts getPublisher('slack') and ('discord') do not throw and return the right platform
```

Run and confirm it FAILS before wiring.

- [ ] **Step 3: Register in the factory.** Add constructor params `slackPublisher: SlackPublisher`, `discordPublisher: DiscordPublisher`, and:

```ts
    this.publishers.set('slack', this.slackPublisher);
    this.publishers.set('discord', this.discordPublisher);
```

- [ ] **Step 4: Add both to the module providers** (the file from Step 1), alongside `RedditPublisher`.

- [ ] **Step 5: Verify build + tests + boot.**

Run: `cd socialmedia-workspace && npm run build && npx jest src/posts/publishers`
Expected: build exit 0; publisher tests PASS. (Boot smoke — Nest DI resolves — is covered by build + the app's existing e2e; if a quick boot check is cheap, run it.)

- [ ] **Step 6: Commit.**

```bash
git add src/posts/publishers/publisher.factory.ts src/posts/publishers/publisher.factory.spec.ts src/posts/posts.module.ts
git commit -m "feat(publishers): register Slack + Discord publishers in the factory"
```

---

### Task 6: Campaign materializer carries the destination

**Files:**
- Modify: `socialmedia-workspace/src/campaigns/campaign-publishing.service.ts` (`MaterializeInput`, `buildTargets`, `materializeAndEnqueue`)
- Modify: `socialmedia-workspace/src/campaigns/campaigns.service.ts` (the caller that builds `MaterializeInput` from a slot — in `launch`/`resume`, ~lines 942/1054)
- Test: `socialmedia-workspace/src/campaigns/campaign-publishing.service.spec.ts` (extend)

**Interfaces:**
- Consumes: the slot's stored `ChannelDayContentJson` destination (frontend writes it — Task 9); `PostTarget.destination` (Task 1).
- Produces: launched Slack/Discord posts whose `PostTarget.destination` is set.

**Context:** `ChannelDayContentJson` is the backend jsonb type for a slot's content (`src/drizzle/schema/campaigns.schema.ts`). It must gain an optional `destination?: { id: string; name?: string }` so the composer's saved destination is stored and readable at launch. Confirm the type name in that schema file and extend it.

- [ ] **Step 1: Extend the slot content type.** In `campaigns.schema.ts`, add optional `destination?: { id: string; name?: string }` to `ChannelDayContentJson` (the per-channel-day content interface). Pure type addition (jsonb column).

- [ ] **Step 2: Write the failing test.** Extend `campaign-publishing.service.spec.ts`: when `materializeAndEnqueue` is called with a `destination`, the inserted post's `targets[0].destination` equals it. (Mock the db insert to capture the values, following the existing spec's mocking style; if the existing spec only tests `buildJobId`/`cancelSlotJob`, add a focused `buildTargets` test instead: `buildTargets('42','slack',{id:'C1',name:'#x'})` includes `destination`.)

- [ ] **Step 3: Run test to verify it fails.**

Run: `cd socialmedia-workspace && npx jest src/campaigns/campaign-publishing.service.spec.ts`
Expected: FAIL.

- [ ] **Step 4: Implement.**
  - `MaterializeInput` gains `destination?: { id: string; name?: string }`.
  - `buildTargets(channelId, platform, destination?)` includes `destination` in the returned `PostTarget` when present.
  - `materializeAndEnqueue` passes `input.destination` to `buildTargets`.
  - In `campaigns.service.ts` `launch`/`resume`, where each slot is materialized, read `content.destination` from the slot and set it on the `MaterializeInput`.

- [ ] **Step 5: Run tests + build.**

Run: `cd socialmedia-workspace && npx jest src/campaigns && npm run build`
Expected: PASS + exit 0.

- [ ] **Step 6: Commit.**

```bash
git add src/campaigns/campaign-publishing.service.ts src/campaigns/campaigns.service.ts src/campaigns/campaign-publishing.service.spec.ts src/drizzle/schema/campaigns.schema.ts
git commit -m "feat(campaigns): carry messaging destination from slot into PostTarget at launch"
```

---

## FRONTEND (only after backend tasks complete)

> All frontend paths are in worktree `socialmedia-frontend-campaigns`, branch `feat/campaign-messaging-channels`. Run FE commands with `cd socialmedia-frontend-campaigns`.

### Task 7: `'message'` post type + messaging platform config

**Files:**
- Modify: `src/features/campaigns/constants/post-types.tsx` (`PostType`, `ComposerKind`, `POST_TYPES`, `PLATFORM_POST_TYPES` slack/discord)

**Interfaces:**
- Produces: `PostType` includes `'message'`; `getPlatformPostConfig('slack'|'discord')` returns `{ types: ['message'], default: 'message' }` — consumed by Tasks 8, 9.

- [ ] **Step 1: Add the `'message'` post type.** Extend `PostType` union with `'message'`; extend `ComposerKind` with `'message'`; add a `POST_TYPES.message` entry:

```ts
  message: {
    id: 'message',
    label: 'Message',
    icon: MessageSquareText, // already imported
    composer: 'message',
    blurb: 'A single chat message with optional media.',
  },
```

- [ ] **Step 2: Enable slack + discord.** In `PLATFORM_POST_TYPES`, change `slack` and `discord` to `types: ['message'], default: 'message'` (keep their `charLimit` 40000 / 2000, `usesHashtags: false`). Leave `telegram` and `whatsapp` as `types: []` (deferred). Update the comment above them to note slack/discord are now message-enabled while telegram/whatsapp stay inbox-only.

- [ ] **Step 3: Verify build.**

Run: `cd socialmedia-frontend-campaigns && npm run build`
Expected: exit 0 (may surface `switch`/exhaustiveness spots on `ComposerKind` — fix any that error; the composer routing in Task 8 handles `'message'`).

- [ ] **Step 4: Commit.**

```bash
git add src/features/campaigns/constants/post-types.tsx
git commit -m "feat(campaigns): add 'message' post type; enable Slack + Discord as messaging targets"
```

---

### Task 8: Destination picker — API + hooks + component

**Files:**
- Create: `src/features/campaigns/api/messaging-destinations.api.ts`
- Create: `src/features/campaigns/hooks/use-messaging-destinations.ts`
- Create: `src/features/campaigns/components/create/steps/composers/destination-picker.tsx`

**Interfaces:**
- Consumes backend endpoints: `GET workspaces/:workspaceId/slack/:channelId/conversations` → `{ channels: { id, name, isMember, isPrivate, ... }[], nextCursor }`; `GET workspaces/:workspaceId/discord/:channelId/channels` → `{ channels: { id, name, type }[] }`.
- Produces: `<DestinationPicker platform channelId workspaceId value onChange />` where `value: { id, name } | undefined` — consumed by Task 9.

- [ ] **Step 1: API wrappers.** Typed `apiClient` calls (follow the existing `src/features/campaigns/api/campaigns.api.ts` style). `listSlackDestinations(workspaceId, channelId, cursor?)` and `listDiscordDestinations(workspaceId, channelId)`. Return typed `{ id: string; name: string; isMember?: boolean; isPrivate?: boolean }[]` (normalize both platforms to this shape; Discord has no isMember/isPrivate).

- [ ] **Step 2: React Query hook.** `useMessagingDestinations(platform, workspaceId, channelId)` — enabled only for slack/discord and when ids present; returns `{ destinations, isLoading, isError, refetch }`. Slack pagination: fetch first page (sufficient for v1; note in a comment that further pages are TODO if a workspace has >~100 channels).

- [ ] **Step 3: Component.** shadcn `Select` (confirm via shadcn MCP `view_items_in_registries` for the exact `Select` API in this project's `@basecn`/base-ui variant — `onValueChange` is string-only, so map the chosen id back to `{ id, name }` internally). Show channel name; for Slack disable/annotate private channels where `isMember === false` (public post fine without join). Loading → skeleton/spinner; empty → "No channels found"; error → inline message + retry. Theme tokens only.

- [ ] **Step 4: Build.**

Run: `cd socialmedia-frontend-campaigns && npm run build`
Expected: exit 0.

- [ ] **Step 5: Commit.**

```bash
git add src/features/campaigns/api/messaging-destinations.api.ts src/features/campaigns/hooks/use-messaging-destinations.ts src/features/campaigns/components/create/steps/composers/destination-picker.tsx
git commit -m "feat(campaigns): destination picker (Slack channels / Discord channels) API + hook + component"
```

---

### Task 9: `MessageComposer` + slot-content destination + routing

**Files:**
- Modify: `src/features/campaigns/types/slot-content.ts` (add `destination?`, update `isChannelDayFilled`, `emptyChannelDayContent` unaffected)
- Create: `src/features/campaigns/components/create/steps/composers/message-composer.tsx`
- Modify: `src/features/campaigns/components/create/steps/composers/channel-day-composer.tsx` (route messaging platforms to `MessageComposer`)
- Test: `src/features/campaigns/types/slot-content.spec.ts` (extend or create — `isChannelDayFilled` for `'message'`)

**Interfaces:**
- Consumes: `<DestinationPicker>` (Task 8); `ChannelDayContent` (with new `destination`); `getPlatformPostConfig` (Task 7).
- Produces: messaging slots authored via a chat composer; `ChannelDayContent.destination` persisted through the existing `updateEvent` save path (it already saves the whole `ChannelDayContent` patch).

- [ ] **Step 1: Slot-content type + filled rule.** Add `destination?: { id: string; name?: string }` to `ChannelDayContent`. In `isChannelDayFilled`, add: if `c.postType === 'message'` → filled iff `!!c.destination?.id && (c.caption.trim().length > 0 || c.media.length > 0)`. Write the failing test for this rule first.

- [ ] **Step 2: Run the filled-rule test — fails.**

Run: `cd socialmedia-frontend-campaigns && npx vitest run src/features/campaigns/types/slot-content.spec.ts`
Expected: FAIL.

- [ ] **Step 3: `MessageComposer` component.** Props: `{ platform, channelId, workspaceId, value: ChannelDayContent, onChange }`. Renders:
  - `<DestinationPicker>` (required — show a subtle "Required" hint until set).
  - One shadcn `Textarea` for the message (char counter against `getPlatformPostConfig(platform).charLimit`), writing `caption`.
  - One optional media attach, **max 1**: reuse the existing media path. Simplest reuse: render the builder's `EditorCard` media affordance OR the `MediaComposer` with `mediaMax: 1`; cap `media` to length 1 in `onChange`. Confirm which is least code by reading `channel-day-composer.tsx`'s flat `ManualBody` (it uses `EditorCard`). Prefer reusing `EditorCard` with media capped at 1 and text as the message.
  - NO mode strip, NO post-type tabs, NO platform-options, NO AI/Template.
  - Make the filled rule pass.

- [ ] **Step 4: Route in `ChannelDayComposer`.** At the top of the component body, if `getPlatformPostConfig(platform).default === 'message'` (i.e. slack/discord), return `<MessageComposer platform channelId workspaceId={useWorkspaceId()} value={current} onChange={onChange} />` instead of the mode-strip/ManualBody/PlatformOptions blocks. This applies to BOTH flat (builder) and boxed (create-wizard) paths — messaging uses the same chat composer everywhere. Non-messaging platforms fall through unchanged (byte-for-byte).

- [ ] **Step 5: Run tests + build.**

Run: `cd socialmedia-frontend-campaigns && npx vitest run src/features/campaigns && npm run build`
Expected: PASS + exit 0.

- [ ] **Step 6: Commit.**

```bash
git add src/features/campaigns/types/slot-content.ts src/features/campaigns/types/slot-content.spec.ts src/features/campaigns/components/create/steps/composers/message-composer.tsx src/features/campaigns/components/create/steps/composers/channel-day-composer.tsx
git commit -m "feat(campaigns): chat-style MessageComposer for Slack/Discord with required destination + single media"
```

---

### Task 10: Launch validation — destination required

**Files:**
- Modify: `src/features/campaigns/components/builder/preflight-summary.tsx` (or the launch mutation guard — find where launch is blocked/validated)
- Modify: `src/features/campaigns/components/builder/bonzo/channels-column.tsx` (card meta shows destination name for message slots)
- Test: extend the relevant validation spec if one exists

**Interfaces:**
- Consumes: `ChannelDayContent.destination`, `isChannelDayFilled` (Task 9).

- [ ] **Step 1: Find the launch gate.** Read `preflight-summary.tsx` and the launch mutation to see how "can this campaign launch" is computed (it likely aggregates `isChannelDayFilled`). Since `isChannelDayFilled` already requires a destination for message slots (Task 9), a destination-less message slot is already "unfilled" → confirm the launch gate blocks on unfilled slots. If it does, add a SPECIFIC message for the destination case ("Pick a destination for <channel> on <date>") rather than a generic "incomplete slot".

- [ ] **Step 2: Card meta.** In `channels-column.tsx`, for a `content.postType === 'message'` slot, render the destination name (e.g. "→ #announcements") in the meta row instead of (or alongside) the post-type chip; show it as "No destination" (muted/italic) when unset. Keep media count. Non-message slots unchanged.

- [ ] **Step 3: Build + tests.**

Run: `cd socialmedia-frontend-campaigns && npx vitest run src/features/campaigns && npm run build`
Expected: PASS + exit 0.

- [ ] **Step 4: Commit.**

```bash
git add src/features/campaigns/components/builder/preflight-summary.tsx src/features/campaigns/components/builder/bonzo/channels-column.tsx
git commit -m "feat(campaigns): require a destination for messaging slots before launch; show it on the slot card"
```

---

## Self-Review notes (for the executor)

- **Spec coverage:** Layer 1 = Tasks 1-6; Layer 2 = Tasks 7-10; Layer 3 (drip+bulk consistency) is satisfied by Task 9 Step 4 routing in the shared `ChannelDayComposer` — no separate task.
- **Type consistency:** `destination` shape is `{ id: string; name?: string }` everywhere — `PostTarget` (BE), `ChannelDayContentJson` (BE slot), `ChannelDayContent` (FE), `DestinationPicker.value` (FE). Keep it identical across all four.
- **Deferred, do NOT touch:** telegram, whatsapp (no publishers, `types: []`).
- **Verify-at-implementation flags** (each noted in its task): exact return shapes of `SlackService.postMessage`/`uploadFile` and `DiscordService.createMessage`; the module that provides `PublisherFactory`; the exact `ChannelDayContentJson` type name; the shadcn `Select` API variant; and whether `EditorCard` or `MediaComposer` is the least-code single-media reuse.
