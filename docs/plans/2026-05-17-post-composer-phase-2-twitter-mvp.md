# Post Composer Phase 2 — Twitter MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a working end-to-end Twitter publishing experience using the Phase 1 composer foundation: TipTap editor, channel selection, real Twitter preview, per-platform tab, publish-now with live status, and partial-success/retry handling.

**Architecture:** Backend gets a new `PublishOrchestratorService` (composer module) that resolves drafts via `PayloadResolverService`, calls `PublisherFactory.getPublisher('twitter').publish()` per channel, and emits per-channel state-machine events over the existing `RealtimeModule` WebSocket gateway. Frontend builds the real composer page: TipTap editor + ChannelSelector + Original/Twitter tabs + TwitterPreview + CharCounter + PublishPanel. Auto-save (already done in Phase 1) coalesces edits.

**Tech Stack:** NestJS, Drizzle ORM, BullMQ (deferred for Phase 2 — synchronous publish for MVP), socket.io, React 19, TanStack Query v5, TipTap 2, shadcn/ui, lucide-react, socket.io-client.

**Out of scope (deferred to Phase 3+):** Other platform previews, media upload UI (text-only Twitter posts only in Phase 2), media transform pipeline, AI patches, schedule-for-later (synchronous publish-now only), thread/Twitter polls UI, mentions/hashtag picker.

---

## File Structure

### Backend (`socialmedia-workspace`)

```
src/posts/composer/
├── services/
│   ├── publish-orchestrator.service.ts          # NEW — per-channel publish loop
│   ├── publish-orchestrator.service.spec.ts     # NEW — TDD tests
│   └── composer-error-mapper.service.ts         # NEW — map Publisher errors → PublishErrorCode
├── dto/
│   └── publish-draft.dto.ts                     # NEW — publish/retry request shape
└── composer.controller.ts                       # MODIFY — add POST publish/retry endpoints

src/realtime/
├── types/
│   └── composer-events.types.ts                 # NEW — composer event union
└── analytics-event-emitter.service.ts           # MODIFY — broaden generic to include composer events
└── types/analytics-events.types.ts              # MODIFY — extend AnalyticsEventName + payload map
```

### Frontend (`socialmedia-frontend`)

```
src/features/composer/
├── components/
│   ├── composer-editor.tsx                      # NEW — TipTap wrapper
│   ├── channel-selector.tsx                     # NEW — pick connected Twitter accounts
│   ├── composer-tabs.tsx                        # NEW — Original | Twitter tabs
│   ├── original-tab.tsx                         # NEW — base content editor
│   ├── twitter-tab.tsx                          # NEW — Twitter override editor + preview
│   ├── twitter-preview.tsx                      # NEW — fidelity preview
│   ├── char-counter.tsx                         # NEW — visual counter w/ warning ring
│   ├── publish-panel.tsx                        # NEW — Publish button + per-channel status
│   └── publish-status-row.tsx                   # NEW — per-channel status pill
├── hooks/
│   ├── use-publish-draft.ts                     # NEW — mutation to POST publish
│   ├── use-retry-channel.ts                     # NEW — mutation to retry single channel
│   ├── use-publish-status.ts                    # NEW — WebSocket subscription
│   └── use-connected-channels.ts                # NEW — fetch workspace channels (filter by platform)
├── lib/
│   ├── twitter-renderer.ts                      # NEW — tweet-like text formatting (URLs, @, #)
│   └── realtime-client.ts                       # NEW — socket.io singleton w/ subscribe helpers
├── pages/
│   └── composer-page.tsx                        # MODIFY — wire real UI
└── types/
    └── draft.types.ts                           # MODIFY — add PublishStatusEvent type
```

---

## Backend Tasks

### Task 1: Composer event types (Realtime extension)

**Files:**
- Modify: `src/realtime/types/analytics-events.types.ts`
- Create: `src/realtime/types/composer-events.types.ts`

- [ ] **Step 1: Write composer-events types**

```ts
// src/realtime/types/composer-events.types.ts
import type { PublishStatus, PublishErrorCode } from '../../posts/composer/types/draft.types';
import type { SupportedPlatform } from '../../drizzle/schema/channels.schema';

export interface ComposerPublishStateChangedPayload {
  workspaceId: string;
  draftId: string;
  channelId: string;
  platform: SupportedPlatform;
  status: PublishStatus;
  platformPostId?: string;
  platformPostUrl?: string;
  errorCode?: PublishErrorCode;
  errorMessage?: string;
  attemptedAt: string;
  retryCount: number;
}

export interface ComposerDraftStatusChangedPayload {
  workspaceId: string;
  draftId: string;
  status: 'publishing' | 'published' | 'partial_success' | 'failed';
  updatedAt: string;
}
```

- [ ] **Step 2: Extend the analytics-events union**

Modify `src/realtime/types/analytics-events.types.ts` — add the two composer event names and merge their payloads into the map:

```ts
import type {
  ComposerPublishStateChangedPayload,
  ComposerDraftStatusChangedPayload,
} from './composer-events.types';

export type AnalyticsEventName =
  | 'channel.snapshot.updated'
  | 'post.metrics.updated'
  | 'channel.sync.state.changed'
  | 'composer.publish.state.changed'
  | 'composer.draft.status.changed';

// ...existing payloads unchanged

export type AnalyticsEventPayloadMap = {
  'channel.snapshot.updated': ChannelSnapshotUpdatedPayload;
  'post.metrics.updated': PostMetricsUpdatedPayload;
  'channel.sync.state.changed': ChannelSyncStateChangedPayload;
  'composer.publish.state.changed': ComposerPublishStateChangedPayload;
  'composer.draft.status.changed': ComposerDraftStatusChangedPayload;
};
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npm run build` from `socialmedia-workspace/`
Expected: PASS — no type errors. The emitter `emit<K>(workspaceId, eventName, payload)` automatically accepts the new keys.

- [ ] **Step 4: Commit**

```bash
git add src/realtime/types/composer-events.types.ts src/realtime/types/analytics-events.types.ts
git commit -m "feat(composer): extend realtime event map with composer publish events"
```

---

### Task 2: Error mapper service (TDD)

**Files:**
- Create: `src/posts/composer/services/composer-error-mapper.service.ts`
- Test: `src/posts/composer/services/composer-error-mapper.service.spec.ts`

- [ ] **Step 1: Write failing tests**

```ts
// composer-error-mapper.service.spec.ts
import { ComposerErrorMapperService } from './composer-error-mapper.service';

describe('ComposerErrorMapperService', () => {
  let mapper: ComposerErrorMapperService;
  beforeEach(() => {
    mapper = new ComposerErrorMapperService();
  });

  it('maps Twitter 401 messages to auth_failed', () => {
    const e = new Error('Request failed with status 401: invalid_token');
    expect(mapper.classify(e)).toEqual({ code: 'auth_failed', retryable: false });
  });

  it('maps "rate limit" messages to rate_limited (retryable)', () => {
    const e = new Error('Twitter API: 429 Too Many Requests');
    expect(mapper.classify(e)).toEqual({ code: 'rate_limited', retryable: true });
  });

  it('maps "media" validation errors to media_invalid', () => {
    const e = new Error('Failed to upload media to Twitter: file too large');
    expect(mapper.classify(e)).toEqual({ code: 'media_invalid', retryable: false });
  });

  it('maps duplicate content rejections to content_rejected', () => {
    const e = new Error('Status is a duplicate');
    expect(mapper.classify(e)).toEqual({ code: 'content_rejected', retryable: false });
  });

  it('maps network/timeout errors to transient (retryable)', () => {
    const e = new Error('ETIMEDOUT connecting to api.twitter.com');
    expect(mapper.classify(e)).toEqual({ code: 'transient', retryable: true });
  });

  it('defaults to permanent for unknown errors', () => {
    const e = new Error('Wat');
    expect(mapper.classify(e)).toEqual({ code: 'permanent', retryable: false });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- composer-error-mapper`
Expected: FAIL — service does not exist.

- [ ] **Step 3: Implement the service**

```ts
// composer-error-mapper.service.ts
import { Injectable } from '@nestjs/common';
import type { PublishErrorCode } from '../types/draft.types';

export interface ClassifiedError {
  code: PublishErrorCode;
  retryable: boolean;
}

@Injectable()
export class ComposerErrorMapperService {
  classify(err: unknown): ClassifiedError {
    const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();

    if (msg.includes('401') || msg.includes('invalid_token') || msg.includes('unauthorized')) {
      return { code: 'auth_failed', retryable: false };
    }
    if (msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests')) {
      return { code: 'rate_limited', retryable: true };
    }
    if (msg.includes('media') && (msg.includes('upload') || msg.includes('invalid') || msg.includes('too large') || msg.includes('exceeds'))) {
      return { code: 'media_invalid', retryable: false };
    }
    if (msg.includes('duplicate') || msg.includes('rejected') || msg.includes('forbidden content')) {
      return { code: 'content_rejected', retryable: false };
    }
    if (msg.includes('etimedout') || msg.includes('econnreset') || msg.includes('network') || msg.includes('socket hang up')) {
      return { code: 'transient', retryable: true };
    }
    return { code: 'permanent', retryable: false };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- composer-error-mapper`
Expected: PASS — 6/6.

- [ ] **Step 5: Commit**

```bash
git add src/posts/composer/services/composer-error-mapper.service.ts src/posts/composer/services/composer-error-mapper.service.spec.ts
git commit -m "feat(composer): error mapper classifies publisher errors into PublishErrorCode"
```

---

### Task 3: PublishOrchestratorService (TDD core)

**Files:**
- Create: `src/posts/composer/services/publish-orchestrator.service.ts`
- Test: `src/posts/composer/services/publish-orchestrator.service.spec.ts`
- Create: `src/posts/composer/dto/publish-draft.dto.ts`

This orchestrator owns the per-channel publish state machine. It:
1. Loads the draft.
2. For each channel target — resolves payload, looks up channel credentials, calls `PublisherFactory.getPublisher(platform).publish()`, classifies errors, updates `ChannelTarget` in posts.targets jsonb, emits WebSocket events at each transition.
3. After all channels, computes overall draft status (`published` / `partial_success` / `failed`).

It does NOT touch rate limiting in Phase 2 (legacy `PostService` has that — we'll merge later in Phase 5).

- [ ] **Step 1: Write the publish DTO**

```ts
// src/posts/composer/dto/publish-draft.dto.ts
import { IsArray, IsOptional, IsString } from 'class-validator';

export class PublishDraftDto {
  // Optional: publish only a subset of channels (used by retry). Omitting = publish all.
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  channelIds?: string[];
}
```

- [ ] **Step 2: Write failing tests**

```ts
// publish-orchestrator.service.spec.ts
import { Test } from '@nestjs/testing';
import { PublishOrchestratorService } from './publish-orchestrator.service';
import { ComposerService } from './composer.service';
import { PayloadResolverService } from './payload-resolver.service';
import { ComposerErrorMapperService } from './composer-error-mapper.service';
import { PublisherFactory } from '../../publishers/publisher.factory';
import { AnalyticsEventEmitter } from '../../../realtime/analytics-event-emitter.service';
import type { Draft } from '../types/draft.types';

const baseDraft = (): Draft => ({
  id: 'd1',
  workspaceId: 'w1',
  createdById: 'u1',
  status: 'draft',
  base: { text: 'hello world', mediaItems: [], hashtags: [], mentions: [] },
  perPlatform: {},
  channels: [
    {
      channelId: 'c1',
      platform: 'twitter',
      publishStatus: 'queued',
      retryCount: 0,
    },
  ],
  schedule: { mode: 'now' },
  createdAt: '2026-05-17T00:00:00Z',
  updatedAt: '2026-05-17T00:00:00Z',
});

describe('PublishOrchestratorService', () => {
  let svc: PublishOrchestratorService;
  let composer: { findById: jest.Mock; updateChannelTarget: jest.Mock; updateStatus: jest.Mock };
  let publisher: { publish: jest.Mock };
  let factory: { getPublisher: jest.Mock };
  let emitter: { emit: jest.Mock };
  let channelLookup: { getCredentials: jest.Mock };

  beforeEach(async () => {
    composer = {
      findById: jest.fn().mockResolvedValue(baseDraft()),
      updateChannelTarget: jest.fn().mockImplementation((_w, _d, ct) => ct),
      updateStatus: jest.fn(),
    };
    publisher = { publish: jest.fn() };
    factory = { getPublisher: jest.fn().mockReturnValue(publisher) };
    emitter = { emit: jest.fn() };
    channelLookup = {
      getCredentials: jest.fn().mockResolvedValue({
        accessToken: 'tok',
        platformAccountId: 'tw-1',
        channelMetadata: {},
      }),
    };

    const mod = await Test.createTestingModule({
      providers: [
        PublishOrchestratorService,
        { provide: ComposerService, useValue: composer },
        { provide: PayloadResolverService, useValue: { resolve: (d: Draft, c: any) => ({ channelId: c.channelId, platform: c.platform, text: d.base.text, mediaItems: [], hashtags: [], mentions: [], platformSpecific: {} }) } },
        { provide: ComposerErrorMapperService, useValue: new ComposerErrorMapperService() },
        { provide: PublisherFactory, useValue: factory },
        { provide: AnalyticsEventEmitter, useValue: emitter },
        { provide: 'CHANNEL_CREDENTIALS_LOOKUP', useValue: channelLookup },
      ],
    }).compile();

    svc = mod.get(PublishOrchestratorService);
  });

  it('publishes a single Twitter channel successfully and emits state events', async () => {
    publisher.publish.mockResolvedValue({ platformPostId: 'tid_1', platformPostUrl: 'https://x.com/i/web/status/tid_1' });

    const result = await svc.publishDraft('w1', 'd1');

    expect(result.draftStatus).toBe('published');
    expect(result.channels[0]).toMatchObject({
      channelId: 'c1',
      publishStatus: 'published',
      platformPostId: 'tid_1',
    });
    // Two transitions: publishing, published — plus draft.status.changed twice (publishing + published)
    const stateEvents = emitter.emit.mock.calls.filter((c) => c[1] === 'composer.publish.state.changed');
    expect(stateEvents.length).toBe(2);
    expect(stateEvents[0][2].status).toBe('publishing');
    expect(stateEvents[1][2].status).toBe('published');
  });

  it('marks channel failed with classified error and overall failed', async () => {
    publisher.publish.mockRejectedValue(new Error('Request failed with status 401: invalid_token'));

    const result = await svc.publishDraft('w1', 'd1');

    expect(result.draftStatus).toBe('failed');
    expect(result.channels[0]).toMatchObject({
      publishStatus: 'failed',
      errorCode: 'auth_failed',
    });
  });

  it('mixed success/failure → partial_success', async () => {
    composer.findById.mockResolvedValue({
      ...baseDraft(),
      channels: [
        { channelId: 'c1', platform: 'twitter', publishStatus: 'queued', retryCount: 0 },
        { channelId: 'c2', platform: 'twitter', publishStatus: 'queued', retryCount: 0 },
      ],
    });
    publisher.publish
      .mockResolvedValueOnce({ platformPostId: 'tid_1', platformPostUrl: 'u1' })
      .mockRejectedValueOnce(new Error('429 rate limit'));

    const result = await svc.publishDraft('w1', 'd1');

    expect(result.draftStatus).toBe('partial_success');
    expect(result.channels[0].publishStatus).toBe('published');
    expect(result.channels[1].publishStatus).toBe('failed');
    expect(result.channels[1].errorCode).toBe('rate_limited');
  });

  it('retry filters to specified channelIds and increments retryCount', async () => {
    composer.findById.mockResolvedValue({
      ...baseDraft(),
      channels: [
        { channelId: 'c1', platform: 'twitter', publishStatus: 'published', retryCount: 0, platformPostId: 'tid_1' },
        { channelId: 'c2', platform: 'twitter', publishStatus: 'failed', retryCount: 1, errorCode: 'rate_limited' },
      ],
    });
    publisher.publish.mockResolvedValue({ platformPostId: 'tid_2', platformPostUrl: 'u2' });

    const result = await svc.publishDraft('w1', 'd1', { channelIds: ['c2'] });

    expect(publisher.publish).toHaveBeenCalledTimes(1);
    expect(result.channels.find((c) => c.channelId === 'c2')?.retryCount).toBe(2);
    expect(result.channels.find((c) => c.channelId === 'c2')?.publishStatus).toBe('published');
    expect(result.channels.find((c) => c.channelId === 'c1')?.publishStatus).toBe('published'); // untouched
  });

  it('throws if draft has no channels', async () => {
    composer.findById.mockResolvedValue({ ...baseDraft(), channels: [] });
    await expect(svc.publishDraft('w1', 'd1')).rejects.toThrow(/no channels/i);
  });
});

// inline import so the test file compiles
import { ComposerErrorMapperService } from './composer-error-mapper.service';
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- publish-orchestrator`
Expected: FAIL — service does not exist.

- [ ] **Step 4: Implement the orchestrator**

```ts
// publish-orchestrator.service.ts
import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { eq, and } from 'drizzle-orm';
import { ComposerService } from './composer.service';
import { PayloadResolverService } from './payload-resolver.service';
import { ComposerErrorMapperService } from './composer-error-mapper.service';
import { PublisherFactory } from '../../publishers/publisher.factory';
import { AnalyticsEventEmitter } from '../../../realtime/analytics-event-emitter.service';
import { DRIZZLE } from '../../../drizzle/drizzle.module';
import { posts } from '../../../drizzle/schema/posts.schema';
import type { ChannelTarget, Draft, DraftStatus, PublishStatus } from '../types/draft.types';

export const CHANNEL_CREDENTIALS_LOOKUP = 'CHANNEL_CREDENTIALS_LOOKUP';

export interface ChannelCredentialsLookup {
  getCredentials(workspaceId: string, channelId: string): Promise<{
    accessToken: string;
    platformAccountId: string;
    channelMetadata: Record<string, any>;
  }>;
}

export interface PublishOptions {
  channelIds?: string[]; // when provided, only publish/retry these
}

export interface PublishResultSummary {
  draftStatus: 'published' | 'partial_success' | 'failed';
  channels: ChannelTarget[];
}

@Injectable()
export class PublishOrchestratorService {
  private readonly logger = new Logger(PublishOrchestratorService.name);

  constructor(
    private readonly composer: ComposerService,
    private readonly resolver: PayloadResolverService,
    private readonly errorMapper: ComposerErrorMapperService,
    private readonly publisherFactory: PublisherFactory,
    private readonly emitter: AnalyticsEventEmitter,
    @Inject(CHANNEL_CREDENTIALS_LOOKUP) private readonly credentials: ChannelCredentialsLookup,
    @Inject(DRIZZLE) private readonly db: any,
  ) {}

  async publishDraft(
    workspaceId: string,
    draftId: string,
    opts: PublishOptions = {},
  ): Promise<PublishResultSummary> {
    const draft = await this.composer.findById(workspaceId, draftId);
    if (!draft.channels?.length) {
      throw new BadRequestException('Draft has no channels selected');
    }

    const isRetry = Boolean(opts.channelIds?.length);
    const targets = isRetry
      ? draft.channels.filter((c) => opts.channelIds!.includes(c.channelId))
      : draft.channels;

    if (isRetry && targets.length === 0) {
      throw new BadRequestException('None of the specified channelIds match draft channels');
    }

    // Mark draft as publishing + broadcast
    await this.updateDraftStatus(workspaceId, draftId, 'publishing');
    this.emitter.emit(workspaceId, 'composer.draft.status.changed', {
      workspaceId, draftId, status: 'publishing', updatedAt: new Date().toISOString(),
    });

    // Walk channels sequentially — keeps semantics simple and avoids hammering Twitter
    const updatedMap = new Map<string, ChannelTarget>();
    for (const c of draft.channels) updatedMap.set(c.channelId, c);

    for (const target of targets) {
      const next: ChannelTarget = {
        ...target,
        publishStatus: 'publishing',
        attemptedAt: new Date().toISOString(),
        retryCount: isRetry ? target.retryCount + 1 : target.retryCount,
        errorCode: undefined,
        errorMessage: undefined,
      };
      updatedMap.set(target.channelId, next);
      await this.persistChannel(workspaceId, draftId, updatedMap);
      this.emitState(workspaceId, draftId, next);

      try {
        const payload = this.resolver.resolve(draft, target);
        const creds = await this.credentials.getCredentials(workspaceId, target.channelId);
        const publisher = this.publisherFactory.getPublisher(target.platform);

        const result = await publisher.publish({
          content: payload.text,
          mediaItems: payload.mediaItems as any,
          metadata: payload.platformSpecific,
          accessToken: creds.accessToken,
          platformAccountId: creds.platformAccountId,
          channelMetadata: creds.channelMetadata,
        });

        const ok: ChannelTarget = {
          ...next,
          publishStatus: 'published',
          platformPostId: result.platformPostId,
          platformPostUrl: result.platformPostUrl,
          publishedAt: new Date().toISOString(),
        };
        updatedMap.set(target.channelId, ok);
        await this.persistChannel(workspaceId, draftId, updatedMap);
        this.emitState(workspaceId, draftId, ok);
      } catch (err) {
        const classified = this.errorMapper.classify(err);
        const failed: ChannelTarget = {
          ...next,
          publishStatus: 'failed',
          errorCode: classified.code,
          errorMessage: err instanceof Error ? err.message : String(err),
        };
        updatedMap.set(target.channelId, failed);
        await this.persistChannel(workspaceId, draftId, updatedMap);
        this.emitState(workspaceId, draftId, failed);
        this.logger.warn(`Channel ${target.channelId} (${target.platform}) failed: ${failed.errorMessage}`);
      }
    }

    const finalChannels = Array.from(updatedMap.values());
    const draftStatus = this.computeDraftStatus(finalChannels);
    const dbStatus: DraftStatus =
      draftStatus === 'published' ? 'published' :
      draftStatus === 'partial_success' ? 'partial_success' : 'failed';

    await this.updateDraftStatus(workspaceId, draftId, dbStatus);
    this.emitter.emit(workspaceId, 'composer.draft.status.changed', {
      workspaceId, draftId, status: draftStatus, updatedAt: new Date().toISOString(),
    });

    return { draftStatus, channels: finalChannels };
  }

  private emitState(workspaceId: string, draftId: string, target: ChannelTarget): void {
    this.emitter.emit(workspaceId, 'composer.publish.state.changed', {
      workspaceId,
      draftId,
      channelId: target.channelId,
      platform: target.platform,
      status: target.publishStatus,
      platformPostId: target.platformPostId,
      platformPostUrl: target.platformPostUrl,
      errorCode: target.errorCode,
      errorMessage: target.errorMessage,
      attemptedAt: target.attemptedAt ?? new Date().toISOString(),
      retryCount: target.retryCount,
    });
  }

  private async persistChannel(
    workspaceId: string,
    draftId: string,
    map: Map<string, ChannelTarget>,
  ): Promise<void> {
    const targets = Array.from(map.values());
    await this.db
      .update(posts)
      .set({ targets: targets as any, updatedAt: new Date() })
      .where(and(eq(posts.id, draftId), eq(posts.workspaceId, workspaceId)));
  }

  private async updateDraftStatus(
    workspaceId: string,
    draftId: string,
    status: DraftStatus | 'publishing',
  ): Promise<void> {
    await this.db
      .update(posts)
      .set({ status, updatedAt: new Date() })
      .where(and(eq(posts.id, draftId), eq(posts.workspaceId, workspaceId)));
  }

  private computeDraftStatus(channels: ChannelTarget[]): 'published' | 'partial_success' | 'failed' {
    const statuses: PublishStatus[] = channels.map((c) => c.publishStatus);
    const allPublished = statuses.every((s) => s === 'published');
    const anyPublished = statuses.some((s) => s === 'published');
    if (allPublished) return 'published';
    if (anyPublished) return 'partial_success';
    return 'failed';
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- publish-orchestrator`
Expected: PASS — 5/5.

- [ ] **Step 6: Commit**

```bash
git add src/posts/composer/services/publish-orchestrator.service.ts src/posts/composer/services/publish-orchestrator.service.spec.ts src/posts/composer/dto/publish-draft.dto.ts
git commit -m "feat(composer): publish orchestrator with per-channel state machine and realtime events"
```

---

### Task 4: Channel credentials lookup adapter

The orchestrator depends on a `ChannelCredentialsLookup` provider. We adapt the existing `ChannelsService` (which already loads channels by id) without re-implementing token handling.

**Files:**
- Create: `src/posts/composer/services/channel-credentials.adapter.ts`

- [ ] **Step 1: Identify the existing channels service**

Run: `npm test -- --listTests | grep -i channels` is not needed — search the codebase:

```bash
# (run from socialmedia-workspace/)
grep -r "class ChannelsService" src/ --include="*.ts" -l | head
```

You should find `src/channels/channels.service.ts`. Open it to find a method that returns a channel by id with its `accessToken`, `platformAccountId`, and `metadata`. If a suitable method does not exist, create one in `channels.service.ts` named `getChannelForPublishing(workspaceId, channelId)` returning `{ accessToken, platformAccountId, channelMetadata }`.

- [ ] **Step 2: Write the adapter**

```ts
// src/posts/composer/services/channel-credentials.adapter.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { ChannelsService } from '../../../channels/channels.service';
import type { ChannelCredentialsLookup } from './publish-orchestrator.service';

@Injectable()
export class ChannelCredentialsAdapter implements ChannelCredentialsLookup {
  constructor(private readonly channels: ChannelsService) {}

  async getCredentials(workspaceId: string, channelId: string) {
    const channel = await this.channels.getChannelForPublishing(workspaceId, channelId);
    if (!channel) throw new NotFoundException(`Channel ${channelId} not found`);
    return {
      accessToken: channel.accessToken,
      platformAccountId: channel.platformAccountId,
      channelMetadata: channel.metadata ?? {},
    };
  }
}
```

If `ChannelsService` lacks `getChannelForPublishing`, add it now in the same task:

```ts
// inside ChannelsService — keep accessToken decryption logic consistent with existing code
async getChannelForPublishing(workspaceId: string, channelId: string) {
  const numericId = Number(channelId);
  const [row] = await db
    .select()
    .from(channels)
    .where(and(eq(channels.id, numericId), eq(channels.workspaceId, workspaceId)))
    .limit(1);
  if (!row) return null;
  return {
    accessToken: row.accessToken, // reuse existing token retrieval; do not bypass any existing decryption
    platformAccountId: row.platformAccountId,
    metadata: row.metadata ?? {},
  };
}
```

(If channels are already loaded with decryption elsewhere, mirror that pattern instead of duplicating — read 5–10 lines of an existing call site first to copy the convention.)

- [ ] **Step 3: Commit**

```bash
git add src/posts/composer/services/channel-credentials.adapter.ts src/channels/channels.service.ts
git commit -m "feat(composer): channel credentials adapter bridging composer orchestrator and channels service"
```

---

### Task 5: Wire the controller endpoints

**Files:**
- Modify: `src/posts/composer/composer.controller.ts`

- [ ] **Step 1: Add publish + retry endpoints**

```ts
// at top — add imports
import { PublishOrchestratorService } from './services/publish-orchestrator.service';
import { PublishDraftDto } from './dto/publish-draft.dto';

// constructor — add: private readonly orchestrator: PublishOrchestratorService

// new methods at end of class:
  @Post('drafts/:draftId/publish')
  async publishDraft(
    @Param('wsId') wsId: string,
    @Param('draftId') draftId: string,
    @Body() dto: PublishDraftDto,
  ) {
    return this.orchestrator.publishDraft(wsId, draftId, { channelIds: dto.channelIds });
  }

  @Post('drafts/:draftId/retry')
  async retryDraft(
    @Param('wsId') wsId: string,
    @Param('draftId') draftId: string,
    @Body() dto: PublishDraftDto,
  ) {
    if (!dto.channelIds?.length) {
      throw new BadRequestException('retry requires channelIds');
    }
    return this.orchestrator.publishDraft(wsId, draftId, { channelIds: dto.channelIds });
  }
```

- [ ] **Step 2: Commit**

```bash
git add src/posts/composer/composer.controller.ts
git commit -m "feat(composer): expose POST /publish and /retry endpoints"
```

---

### Task 6: Wire the ComposerModule

**Files:**
- Modify: `src/posts/composer/composer.module.ts`

- [ ] **Step 1: Register new providers + import dependencies**

```ts
import { Module } from '@nestjs/common';
import { ComposerController } from './composer.controller';
import { ComposerService } from './services/composer.service';
import { ComposerValidatorService } from './services/composer-validator.service';
import { MediaValidatorService } from './services/media-validator.service';
import { PayloadResolverService } from './services/payload-resolver.service';
import { ComposerErrorMapperService } from './services/composer-error-mapper.service';
import { PublishOrchestratorService, CHANNEL_CREDENTIALS_LOOKUP } from './services/publish-orchestrator.service';
import { ChannelCredentialsAdapter } from './services/channel-credentials.adapter';
import { ChannelsModule } from '../../channels/channels.module';
import { PublishersModule } from '../publishers/publishers.module'; // if exists, else import directly

@Module({
  imports: [ChannelsModule /*, PublishersModule */],
  controllers: [ComposerController],
  providers: [
    ComposerService,
    ComposerValidatorService,
    MediaValidatorService,
    PayloadResolverService,
    ComposerErrorMapperService,
    PublishOrchestratorService,
    ChannelCredentialsAdapter,
    { provide: CHANNEL_CREDENTIALS_LOOKUP, useExisting: ChannelCredentialsAdapter },
  ],
  exports: [ComposerService, ComposerValidatorService, PayloadResolverService],
})
export class ComposerModule {}
```

If `PublishersModule` does not exist as a standalone module, the `PublisherFactory` providers are already wired inside `PostsModule`. In that case, **import `PostsModule` here** OR move `PublisherFactory` + all `*Publisher` classes into a small `PublishersModule` that both `PostsModule` and `ComposerModule` import. Choose the smaller-diff option: if PublisherFactory is already exported from PostsModule, just add `PostsModule` to the imports. Otherwise create `PublishersModule`.

- [ ] **Step 2: Verify backend builds**

Run: `npm run build` from `socialmedia-workspace/`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/posts/composer/composer.module.ts src/posts/publishers/publishers.module.ts
git commit -m "feat(composer): wire publish orchestrator and credentials adapter into ComposerModule"
```

---

## Frontend Tasks

### Task 7: Install TipTap and socket.io-client

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install dependencies**

Run from `socialmedia-frontend/`:

```bash
npm install @tiptap/react @tiptap/pm @tiptap/starter-kit @tiptap/extension-character-count @tiptap/extension-placeholder @tiptap/extension-link socket.io-client
```

- [ ] **Step 2: Verify peer dependency compatibility**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(composer): install tiptap + socket.io-client for Phase 2 UI"
```

---

### Task 8: Realtime client singleton

**Files:**
- Create: `src/features/composer/lib/realtime-client.ts`

The realtime gateway lives at namespace `/realtime` and authenticates via the access token. We share one socket per app instance.

- [ ] **Step 1: Write the client**

```ts
// realtime-client.ts
import { io, Socket } from 'socket.io-client'
import { getAccessToken } from '@/lib/auth-token'

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000'

let socket: Socket | null = null

export function getRealtimeSocket(): Socket {
  if (socket && socket.connected) return socket
  if (socket) return socket

  socket = io(`${API_BASE}/realtime`, {
    autoConnect: true,
    transports: ['websocket', 'polling'],
    auth: () => ({ token: getAccessToken() ?? '' }),
  })
  return socket
}

export function subscribeWorkspace(workspaceId: string): () => void {
  const s = getRealtimeSocket()
  const join = () => s.emit('subscribe:workspace', { workspaceId })
  if (s.connected) join()
  else s.once('connect', join)
  return () => {
    s.emit('unsubscribe:workspace', { workspaceId })
  }
}
```

Confirm the auth-token helper file name. The Phase 1 codebase uses `src/lib/auth-token.ts` (kebab-case per the project's naming rule) — if the exported function is `getToken` or similar, adapt the import.

- [ ] **Step 2: Commit**

```bash
git add src/features/composer/lib/realtime-client.ts
git commit -m "feat(composer): realtime socket.io client singleton"
```

---

### Task 9: use-publish-status hook

**Files:**
- Create: `src/features/composer/hooks/use-publish-status.ts`
- Modify: `src/features/composer/types/draft.types.ts`

- [ ] **Step 1: Add event types to the frontend mirror**

In `src/features/composer/types/draft.types.ts`, append:

```ts
export interface ComposerPublishStateEvent {
  workspaceId: string
  draftId: string
  channelId: string
  platform: SupportedPlatform
  status: PublishStatus
  platformPostId?: string
  platformPostUrl?: string
  errorCode?: PublishErrorCode
  errorMessage?: string
  attemptedAt: string
  retryCount: number
}

export interface ComposerDraftStatusEvent {
  workspaceId: string
  draftId: string
  status: 'publishing' | 'published' | 'partial_success' | 'failed'
  updatedAt: string
}
```

- [ ] **Step 2: Write the hook**

```ts
// use-publish-status.ts
import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { getRealtimeSocket, subscribeWorkspace } from '../lib/realtime-client'
import { queryKeys } from '@/lib/query-client'
import type { ComposerPublishStateEvent, ComposerDraftStatusEvent } from '../types/draft.types'

export interface PublishStatusState {
  draftStatus?: ComposerDraftStatusEvent['status']
  channels: Record<string, ComposerPublishStateEvent>
}

export function usePublishStatus(workspaceId: string | null, draftId: string | undefined) {
  const qc = useQueryClient()
  const [state, setState] = useState<PublishStatusState>({ channels: {} })

  useEffect(() => {
    if (!workspaceId || !draftId) return
    const socket = getRealtimeSocket()
    const unsub = subscribeWorkspace(workspaceId)

    const onChannel = (p: ComposerPublishStateEvent) => {
      if (p.draftId !== draftId) return
      setState((prev) => ({ ...prev, channels: { ...prev.channels, [p.channelId]: p } }))
      // Invalidate to pull authoritative draft from server (covers reconnect / missed events)
      qc.invalidateQueries({ queryKey: queryKeys.composer.draft(workspaceId, draftId) })
    }
    const onDraft = (p: ComposerDraftStatusEvent) => {
      if (p.draftId !== draftId) return
      setState((prev) => ({ ...prev, draftStatus: p.status }))
    }

    socket.on('composer.publish.state.changed', onChannel)
    socket.on('composer.draft.status.changed', onDraft)

    return () => {
      socket.off('composer.publish.state.changed', onChannel)
      socket.off('composer.draft.status.changed', onDraft)
      unsub()
    }
  }, [workspaceId, draftId, qc])

  return state
}
```

- [ ] **Step 3: Commit**

```bash
git add src/features/composer/hooks/use-publish-status.ts src/features/composer/types/draft.types.ts
git commit -m "feat(composer): realtime publish status hook"
```

---

### Task 10: use-publish-draft + use-retry-channel + use-connected-channels

**Files:**
- Modify: `src/features/composer/api/composer.api.ts`
- Create: `src/features/composer/hooks/use-publish-draft.ts`
- Create: `src/features/composer/hooks/use-retry-channel.ts`
- Create: `src/features/composer/hooks/use-connected-channels.ts`

- [ ] **Step 1: Extend the API**

Add to `composer.api.ts`:

```ts
export interface PublishDraftPayload {
  channelIds?: string[]
}

export interface PublishDraftResult {
  draftStatus: 'published' | 'partial_success' | 'failed'
  channels: ChannelTarget[]
}

export const composerApi = {
  // ...existing
  async publish(workspaceId: string, draftId: string, payload: PublishDraftPayload = {}): Promise<PublishDraftResult> {
    return apiClient.post(`/posts/workspaces/${workspaceId}/composer/drafts/${draftId}/publish`, payload)
  },
  async retry(workspaceId: string, draftId: string, channelIds: string[]): Promise<PublishDraftResult> {
    return apiClient.post(`/posts/workspaces/${workspaceId}/composer/drafts/${draftId}/retry`, { channelIds })
  },
}
```

- [ ] **Step 2: Write use-publish-draft**

```ts
// use-publish-draft.ts
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { composerApi } from '../api/composer.api'
import { queryKeys } from '@/lib/query-client'

export function usePublishDraft(workspaceId: string, draftId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => composerApi.publish(workspaceId, draftId),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: queryKeys.composer.draft(workspaceId, draftId) })
      if (result.draftStatus === 'published') toast.success('Post published')
      else if (result.draftStatus === 'partial_success') toast.warning('Some channels failed — review and retry')
      else toast.error('Publishing failed')
    },
    onError: (e: Error) => toast.error(e.message ?? 'Publish failed'),
  })
}
```

- [ ] **Step 3: Write use-retry-channel**

```ts
// use-retry-channel.ts
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { composerApi } from '../api/composer.api'
import { queryKeys } from '@/lib/query-client'

export function useRetryChannel(workspaceId: string, draftId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (channelId: string) => composerApi.retry(workspaceId, draftId, [channelId]),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.composer.draft(workspaceId, draftId) }),
    onError: (e: Error) => toast.error(e.message ?? 'Retry failed'),
  })
}
```

- [ ] **Step 4: Write use-connected-channels**

This hook should reuse the existing channels API (Phase 0 already shipped channel CRUD). Confirm the path:

```ts
// use-connected-channels.ts
import { useQuery } from '@tanstack/react-query'
import { channelsApi } from '@/features/channels/api/channels.api' // adapt to actual location
import { queryKeys } from '@/lib/query-client'

export function useConnectedChannels(workspaceId: string | null) {
  return useQuery({
    queryKey: workspaceId ? queryKeys.channels.list(workspaceId) : ['channels', 'unauthed'],
    queryFn: () => (workspaceId ? channelsApi.list(workspaceId) : Promise.resolve([])),
    enabled: Boolean(workspaceId),
    staleTime: 60_000,
  })
}
```

If the channels API helper is not yet built or the query key factory does not include `channels.list`, build the minimal viable version (a GET to the existing channels list endpoint) inline rather than blocking on it. Search first: `grep -r "channels.list" socialmedia-frontend/src/lib/query-client.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/features/composer/api/composer.api.ts src/features/composer/hooks/use-publish-draft.ts src/features/composer/hooks/use-retry-channel.ts src/features/composer/hooks/use-connected-channels.ts
git commit -m "feat(composer): publish + retry mutations and connected-channels query"
```

---

### Task 11: ComposerEditor (TipTap wrapper)

**Files:**
- Create: `src/features/composer/components/composer-editor.tsx`

Per CLAUDE.md: the editor surface (border, focus ring) is visual chrome — wrap in shadcn's already-installed primitive area. Use `@/components/ui/textarea` styling tokens via a plain `div` with theme-token classes. Editor body itself is TipTap's `EditorContent`.

- [ ] **Step 1: Write the component**

```tsx
// composer-editor.tsx
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import CharacterCount from '@tiptap/extension-character-count'
import { useEffect } from 'react'
import { cn } from '@/lib/utils'

interface ComposerEditorProps {
  value: string
  onChange: (text: string) => void
  placeholder?: string
  maxLength?: number
  className?: string
}

export function ComposerEditor({
  value,
  onChange,
  placeholder = "What's on your mind?",
  maxLength,
  className,
}: ComposerEditorProps) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: false, bulletList: false, orderedList: false, codeBlock: false }),
      Placeholder.configure({ placeholder }),
      ...(maxLength ? [CharacterCount.configure({ limit: maxLength })] : [CharacterCount]),
    ],
    content: value,
    onUpdate: ({ editor }) => {
      onChange(editor.getText())
    },
    editorProps: {
      attributes: {
        class: 'prose prose-sm max-w-none focus:outline-none min-h-32',
      },
    },
  })

  // Keep editor in sync with external value (drafts loaded after mount)
  useEffect(() => {
    if (!editor) return
    if (editor.getText() === value) return
    editor.commands.setContent(value, { emitUpdate: false })
  }, [value, editor])

  return (
    <div className={cn('rounded-md border border-input bg-background px-3 py-2 focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2', className)}>
      <EditorContent editor={editor} />
    </div>
  )
}
```

- [ ] **Step 2: Verify lint**

Run: `npm run lint` from `socialmedia-frontend/`
Expected: no errors (warnings ok if pre-existing).

- [ ] **Step 3: Commit**

```bash
git add src/features/composer/components/composer-editor.tsx
git commit -m "feat(composer): TipTap-based ComposerEditor primitive"
```

---

### Task 12: CharCounter component

**Files:**
- Create: `src/features/composer/components/char-counter.tsx`

- [ ] **Step 1: Build the counter**

```tsx
// char-counter.tsx
import { cn } from '@/lib/utils'

interface CharCounterProps {
  current: number
  limit: number
  className?: string
}

export function CharCounter({ current, limit, className }: CharCounterProps) {
  const remaining = limit - current
  const pct = Math.min(current / limit, 1.2)
  const isOver = current > limit
  const isWarning = !isOver && pct >= 0.9

  const ringColor = isOver
    ? 'text-destructive'
    : isWarning
    ? 'text-amber-500'
    : 'text-muted-foreground'

  const circumference = 2 * Math.PI * 9
  const dashOffset = circumference * (1 - Math.min(current / limit, 1))

  return (
    <div className={cn('flex items-center gap-2 text-xs', ringColor, className)}>
      <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden>
        <circle cx="11" cy="11" r="9" fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2" />
        <circle
          cx="11" cy="11" r="9" fill="none"
          stroke="currentColor" strokeWidth="2" strokeLinecap="round"
          strokeDasharray={circumference} strokeDashoffset={dashOffset}
          transform="rotate(-90 11 11)"
        />
      </svg>
      <span aria-live="polite">{isOver ? remaining : `${current}/${limit}`}</span>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/features/composer/components/char-counter.tsx
git commit -m "feat(composer): char counter with progress ring and warning/over states"
```

---

### Task 13: ChannelSelector

**Files:**
- Create: `src/features/composer/components/channel-selector.tsx`

Use shadcn `Popover` + `Command` (combobox pattern). Install via shadcn MCP if not present:

```bash
# preflight (only if missing)
npx shadcn@latest add popover command
```

- [ ] **Step 1: Implement**

```tsx
// channel-selector.tsx
import { Check, Plus } from 'lucide-react'
import { useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useConnectedChannels } from '../hooks/use-connected-channels'
import type { ChannelTarget } from '../types/draft.types'

interface ChannelSelectorProps {
  workspaceId: string
  value: ChannelTarget[]
  onChange: (next: ChannelTarget[]) => void
  platformFilter?: 'twitter' // Phase 2 hardcodes twitter
}

export function ChannelSelector({ workspaceId, value, onChange, platformFilter = 'twitter' }: ChannelSelectorProps) {
  const [open, setOpen] = useState(false)
  const { data: channels = [], isLoading } = useConnectedChannels(workspaceId)
  const available = channels.filter((c) => c.platform === platformFilter)
  const selectedIds = new Set(value.map((c) => c.channelId))

  const toggle = (channelId: string, platform: 'twitter') => {
    if (selectedIds.has(channelId)) {
      onChange(value.filter((c) => c.channelId !== channelId))
    } else {
      onChange([
        ...value,
        { channelId, platform, publishStatus: 'queued', retryCount: 0 },
      ])
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {value.map((c) => {
        const ch = available.find((a) => String(a.id) === c.channelId)
        return (
          <Badge key={c.channelId} variant="secondary" className="gap-1.5">
            {ch?.displayName ?? c.channelId}
          </Badge>
        )
      })}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="gap-1.5">
            <Plus className="size-3.5" />
            Add channel
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-0" align="start">
          <Command>
            <CommandInput placeholder="Search channels..." />
            <CommandList>
              <CommandEmpty>
                {isLoading ? 'Loading...' : 'No connected Twitter accounts'}
              </CommandEmpty>
              <CommandGroup>
                {available.map((ch) => {
                  const id = String(ch.id)
                  const selected = selectedIds.has(id)
                  return (
                    <CommandItem
                      key={id}
                      onSelect={() => toggle(id, 'twitter')}
                      className="flex items-center gap-2"
                    >
                      <span className="flex-1">{ch.displayName ?? ch.platformAccountId}</span>
                      {selected ? <Check className="size-4" /> : null}
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  )
}
```

Confirm the actual channel shape returned by `useConnectedChannels` — adjust the field accesses (`ch.displayName`, `ch.id`, etc.) to match. Read the channels API response type first.

- [ ] **Step 2: Commit**

```bash
git add src/features/composer/components/channel-selector.tsx
git commit -m "feat(composer): channel selector for twitter accounts"
```

---

### Task 14: TwitterPreview

**Files:**
- Create: `src/features/composer/components/twitter-preview.tsx`
- Create: `src/features/composer/lib/twitter-renderer.ts`

- [ ] **Step 1: Implement the text renderer**

```ts
// twitter-renderer.ts
// Lightweight tokenizer — urls, mentions, hashtags become styled spans
export type TwitterToken =
  | { type: 'text'; value: string }
  | { type: 'url'; value: string }
  | { type: 'mention'; value: string }
  | { type: 'hashtag'; value: string }

const URL_RE = /https?:\/\/[^\s]+/g
const MENTION_RE = /(^|\s)@(\w{1,15})/g
const HASHTAG_RE = /(^|\s)#(\w+)/g

export function tokenize(text: string): TwitterToken[] {
  // Pass: replace tokens with sentinels, then split. Simple but predictable.
  const placeholders: TwitterToken[] = []
  let s = text
    .replace(URL_RE, (m) => {
      placeholders.push({ type: 'url', value: m })
      return ` ${placeholders.length - 1} `
    })
    .replace(MENTION_RE, (_, pre, h) => {
      placeholders.push({ type: 'mention', value: `@${h}` })
      return `${pre} ${placeholders.length - 1} `
    })
    .replace(HASHTAG_RE, (_, pre, h) => {
      placeholders.push({ type: 'hashtag', value: `#${h}` })
      return `${pre} ${placeholders.length - 1} `
    })

  const parts: TwitterToken[] = []
  const segs = s.split(/ (\d+) /)
  for (let i = 0; i < segs.length; i++) {
    if (i % 2 === 0) {
      if (segs[i]) parts.push({ type: 'text', value: segs[i] })
    } else {
      parts.push(placeholders[Number(segs[i])])
    }
  }
  return parts
}
```

- [ ] **Step 2: Implement the preview**

```tsx
// twitter-preview.tsx
import { tokenize } from '../lib/twitter-renderer'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Heart, MessageCircle, Repeat2, Share } from 'lucide-react'

interface TwitterPreviewProps {
  text: string
  authorName?: string
  authorHandle?: string
  authorAvatarUrl?: string
}

export function TwitterPreview({ text, authorName = 'Your Brand', authorHandle = 'yourbrand', authorAvatarUrl }: TwitterPreviewProps) {
  const tokens = tokenize(text)

  return (
    <article className="rounded-2xl border border-border bg-background p-4">
      <div className="flex items-start gap-3">
        <Avatar className="size-10">
          {authorAvatarUrl ? <AvatarImage src={authorAvatarUrl} alt="" /> : null}
          <AvatarFallback>{authorName.slice(0, 1).toUpperCase()}</AvatarFallback>
        </Avatar>
        <div className="flex-1 min-w-0">
          <header className="flex items-baseline gap-1.5 text-sm">
            <span className="font-semibold text-foreground">{authorName}</span>
            <span className="text-muted-foreground">@{authorHandle}</span>
            <span className="text-muted-foreground">· now</span>
          </header>
          <p className="mt-1 whitespace-pre-wrap break-words text-[15px] leading-snug text-foreground">
            {tokens.map((t, i) => {
              if (t.type === 'text') return <span key={i}>{t.value}</span>
              return <span key={i} className="text-sky-600 dark:text-sky-400">{t.value}</span>
            })}
          </p>
          <footer className="mt-3 flex items-center justify-between text-muted-foreground">
            <button className="flex items-center gap-1.5 text-xs hover:text-foreground" type="button">
              <MessageCircle className="size-4" />
            </button>
            <button className="flex items-center gap-1.5 text-xs hover:text-foreground" type="button">
              <Repeat2 className="size-4" />
            </button>
            <button className="flex items-center gap-1.5 text-xs hover:text-foreground" type="button">
              <Heart className="size-4" />
            </button>
            <button className="flex items-center gap-1.5 text-xs hover:text-foreground" type="button">
              <Share className="size-4" />
            </button>
          </footer>
        </div>
      </div>
    </article>
  )
}
```

- [ ] **Step 3: Commit**

```bash
git add src/features/composer/components/twitter-preview.tsx src/features/composer/lib/twitter-renderer.ts
git commit -m "feat(composer): twitter-fidelity preview with mention/hashtag/url highlighting"
```

---

### Task 15: ComposerTabs + OriginalTab + TwitterTab

**Files:**
- Create: `src/features/composer/components/composer-tabs.tsx`
- Create: `src/features/composer/components/original-tab.tsx`
- Create: `src/features/composer/components/twitter-tab.tsx`

The composer's central control. Tab list shows `Original` and `Twitter (N)` where N = number of selected Twitter channels.

- [ ] **Step 1: Tabs shell**

```tsx
// composer-tabs.tsx
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import type { Draft } from '../types/draft.types'
import { OriginalTab } from './original-tab'
import { TwitterTab } from './twitter-tab'

interface ComposerTabsProps {
  draft: Draft
  onBaseChange: (text: string) => void
  onTwitterOverrideChange: (text: string | null) => void // null => clear override
}

export function ComposerTabs({ draft, onBaseChange, onTwitterOverrideChange }: ComposerTabsProps) {
  const twitterChannels = draft.channels.filter((c) => c.platform === 'twitter')

  return (
    <Tabs defaultValue="original" className="w-full">
      <TabsList>
        <TabsTrigger value="original">Original</TabsTrigger>
        {twitterChannels.length > 0 ? (
          <TabsTrigger value="twitter">Twitter ({twitterChannels.length})</TabsTrigger>
        ) : null}
      </TabsList>
      <TabsContent value="original" className="mt-4">
        <OriginalTab draft={draft} onChange={onBaseChange} />
      </TabsContent>
      {twitterChannels.length > 0 ? (
        <TabsContent value="twitter" className="mt-4">
          <TwitterTab draft={draft} onOverrideChange={onTwitterOverrideChange} />
        </TabsContent>
      ) : null}
    </Tabs>
  )
}
```

- [ ] **Step 2: Original tab**

```tsx
// original-tab.tsx
import { ComposerEditor } from './composer-editor'
import type { Draft } from '../types/draft.types'

interface OriginalTabProps {
  draft: Draft
  onChange: (text: string) => void
}

export function OriginalTab({ draft, onChange }: OriginalTabProps) {
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        This is the base content. Per-platform tabs inherit from here unless you override.
      </p>
      <ComposerEditor value={draft.base.text} onChange={onChange} placeholder="What's on your mind?" />
    </div>
  )
}
```

- [ ] **Step 3: Twitter tab**

```tsx
// twitter-tab.tsx
import { useMemo } from 'react'
import { ComposerEditor } from './composer-editor'
import { CharCounter } from './char-counter'
import { TwitterPreview } from './twitter-preview'
import { Button } from '@/components/ui/button'
import type { Draft } from '../types/draft.types'

interface TwitterTabProps {
  draft: Draft
  onOverrideChange: (text: string | null) => void
}

const TWITTER_LIMIT = 280

export function TwitterTab({ draft, onOverrideChange }: TwitterTabProps) {
  const override = draft.perPlatform?.twitter?.overrides?.text
  const hasOverride = typeof override === 'string'
  const effective = hasOverride ? override! : draft.base.text
  const count = useMemo(() => effective.length, [effective])

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium">Twitter</h3>
            <p className="text-xs text-muted-foreground">
              {hasOverride ? 'Customized — different from Original' : 'Inheriting from Original'}
            </p>
          </div>
          {hasOverride ? (
            <Button variant="ghost" size="sm" onClick={() => onOverrideChange(null)}>
              Reset to Original
            </Button>
          ) : null}
        </div>
        <ComposerEditor
          value={effective}
          onChange={(t) => onOverrideChange(t === draft.base.text ? null : t)}
          maxLength={TWITTER_LIMIT}
          placeholder="Tweet text..."
        />
        <CharCounter current={count} limit={TWITTER_LIMIT} />
      </section>
      <section className="space-y-2">
        <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Preview</h4>
        <TwitterPreview text={effective} />
      </section>
    </div>
  )
}
```

- [ ] **Step 4: Commit**

```bash
git add src/features/composer/components/composer-tabs.tsx src/features/composer/components/original-tab.tsx src/features/composer/components/twitter-tab.tsx
git commit -m "feat(composer): tabs (Original + Twitter) with override-aware editor and preview"
```

---

### Task 16: PublishPanel + PublishStatusRow

**Files:**
- Create: `src/features/composer/components/publish-status-row.tsx`
- Create: `src/features/composer/components/publish-panel.tsx`

- [ ] **Step 1: Status row**

```tsx
// publish-status-row.tsx
import { Loader2, CheckCircle2, XCircle, Clock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import type { ChannelTarget } from '../types/draft.types'

interface PublishStatusRowProps {
  target: ChannelTarget
  channelLabel: string
  onRetry?: () => void
  retrying?: boolean
}

export function PublishStatusRow({ target, channelLabel, onRetry, retrying }: PublishStatusRowProps) {
  const icon =
    target.publishStatus === 'publishing'
      ? <Loader2 className="size-4 animate-spin text-muted-foreground" />
      : target.publishStatus === 'published'
      ? <CheckCircle2 className="size-4 text-emerald-500" />
      : target.publishStatus === 'failed'
      ? <XCircle className="size-4 text-destructive" />
      : <Clock className="size-4 text-muted-foreground" />

  return (
    <li className="flex items-center justify-between rounded-md border border-border bg-background p-3">
      <div className="flex items-center gap-3 min-w-0">
        {icon}
        <div className="min-w-0">
          <p className="text-sm font-medium truncate">{channelLabel}</p>
          <p className="text-xs text-muted-foreground truncate">
            {target.publishStatus === 'failed'
              ? target.errorMessage ?? `Failed: ${target.errorCode}`
              : target.publishStatus === 'published' && target.platformPostUrl
              ? <a href={target.platformPostUrl} target="_blank" rel="noreferrer" className="hover:underline">View post</a>
              : target.publishStatus}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        {target.publishStatus === 'failed' && onRetry ? (
          <Button size="sm" variant="outline" onClick={onRetry} disabled={retrying}>
            {retrying ? <Loader2 className="size-3.5 animate-spin" /> : 'Retry'}
          </Button>
        ) : null}
        {target.retryCount > 0 ? <Badge variant="outline" className="text-xs">retries: {target.retryCount}</Badge> : null}
      </div>
    </li>
  )
}
```

- [ ] **Step 2: Publish panel**

```tsx
// publish-panel.tsx
import { Send, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { Draft } from '../types/draft.types'
import { usePublishDraft } from '../hooks/use-publish-draft'
import { useRetryChannel } from '../hooks/use-retry-channel'
import { usePublishStatus } from '../hooks/use-publish-status'
import { PublishStatusRow } from './publish-status-row'

interface PublishPanelProps {
  draft: Draft
  workspaceId: string
}

export function PublishPanel({ draft, workspaceId }: PublishPanelProps) {
  const publish = usePublishDraft(workspaceId, draft.id)
  const retry = useRetryChannel(workspaceId, draft.id)
  const live = usePublishStatus(workspaceId, draft.id)

  const canPublish = draft.channels.length > 0 && draft.base.text.trim().length > 0
  const isBusy = publish.isPending || draft.status === 'publishing'

  // Merge draft.channels with live events (live wins)
  const merged = draft.channels.map((c) => {
    const live$ = live.channels[c.channelId]
    return live$
      ? { ...c, publishStatus: live$.status, platformPostId: live$.platformPostId, platformPostUrl: live$.platformPostUrl, errorCode: live$.errorCode, errorMessage: live$.errorMessage, retryCount: live$.retryCount, attemptedAt: live$.attemptedAt }
      : c
  })

  return (
    <aside className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Publish</h3>
        <Button
          size="sm"
          disabled={!canPublish || isBusy}
          onClick={() => publish.mutate()}
          className="gap-1.5"
        >
          {isBusy ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
          Publish now
        </Button>
      </div>

      {merged.length === 0 ? (
        <p className="text-sm text-muted-foreground">Select at least one channel to publish.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {merged.map((target) => (
            <PublishStatusRow
              key={target.channelId}
              target={target}
              channelLabel={target.channelId} // refine to channel display name lookup in Task 17
              onRetry={target.publishStatus === 'failed' ? () => retry.mutate(target.channelId) : undefined}
              retrying={retry.isPending && retry.variables === target.channelId}
            />
          ))}
        </ul>
      )}
    </aside>
  )
}
```

- [ ] **Step 3: Commit**

```bash
git add src/features/composer/components/publish-status-row.tsx src/features/composer/components/publish-panel.tsx
git commit -m "feat(composer): publish panel + per-channel status row with retry"
```

---

### Task 17: Wire ComposerPage with real UI

**Files:**
- Modify: `src/features/composer/pages/composer-page.tsx`

- [ ] **Step 1: Replace the placeholder body**

```tsx
import { useEffect, useMemo } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router'
import { ArrowLeft, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useDraft } from '../hooks/use-draft'
import { useCreateDraft } from '../hooks/use-create-draft'
import { useUpdateDraft } from '../hooks/use-update-draft'
import { useWorkspaceId } from '@/hooks/use-workspace-id'
import { wsPath } from '@/lib/workspace-path'
import { ComposerTabs } from '../components/composer-tabs'
import { ChannelSelector } from '../components/channel-selector'
import { PublishPanel } from '../components/publish-panel'

export function ComposerPage() {
  const { draftId } = useParams<{ draftId?: string }>()
  const workspaceId = useWorkspaceId()
  const navigate = useNavigate()
  const createDraft = useCreateDraft()
  const draft = useDraft(draftId)
  const update = useUpdateDraft(workspaceId ?? '', draftId ?? '')

  useEffect(() => {
    if (!workspaceId || draftId) return
    if (createDraft.isPending || createDraft.isSuccess) return
    createDraft.mutate(undefined, {
      onSuccess: (newDraft) => {
        navigate(wsPath(workspaceId, `posts/${newDraft.id}/edit`), { replace: true })
      },
    })
  }, [workspaceId, draftId, createDraft, navigate])

  if (!workspaceId) return <Navigate to="/" replace />

  if (!draftId || createDraft.isPending) {
    return (
      <div className="flex min-h-svh items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-center">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Creating a new draft...</p>
        </div>
      </div>
    )
  }

  if (draft.isLoading) {
    return (
      <div className="mx-auto max-w-6xl p-6">
        <Skeleton className="h-8 w-40" />
        <div className="mt-6 grid grid-cols-2 gap-6">
          <Skeleton className="h-80 w-full" />
          <Skeleton className="h-80 w-full" />
        </div>
      </div>
    )
  }

  if (draft.error || !draft.data) {
    return (
      <div className="flex min-h-svh items-center justify-center px-4 text-center">
        <div className="flex flex-col items-center gap-3">
          <p className="text-sm font-medium text-destructive">Could not load this draft</p>
          <Button variant="outline" size="sm" onClick={() => navigate(-1)}>Go back</Button>
        </div>
      </div>
    )
  }

  const data = draft.data
  const handleBaseChange = (text: string) =>
    update.patch({ base: { ...data.base, text } })

  const handleTwitterOverride = (text: string | null) => {
    const existing = data.perPlatform?.twitter
    if (text === null) {
      // Reset: drop overrides.text but keep platformSpecific/inheritsFromBase
      const next = existing
        ? { ...existing, overrides: { ...(existing.overrides ?? {}), text: undefined } }
        : undefined
      update.patch({ perPlatform: { ...data.perPlatform, twitter: next } })
    } else {
      update.patch({
        perPlatform: {
          ...data.perPlatform,
          twitter: {
            inheritsFromBase: existing?.inheritsFromBase ?? true,
            overrides: { ...(existing?.overrides ?? {}), text },
            platformSpecific: existing?.platformSpecific ?? {},
          },
        },
      })
    }
  }

  const handleChannelsChange = (next: typeof data.channels) =>
    update.patch({ channels: next })

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-6">
      <header className="flex items-center justify-between gap-3">
        <Button variant="ghost" size="sm" onClick={() => navigate(-1)} className="gap-1.5">
          <ArrowLeft className="size-4" />
          Back
        </Button>
        <span className="text-xs text-muted-foreground">
          Draft <span className="font-mono">{data.id.slice(0, 8)}</span>
          {update.isSaving ? ' · saving...' : ' · saved'}
        </span>
      </header>

      <div className="mt-6 grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6">
        <main className="space-y-6">
          <section className="space-y-2">
            <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Channels</h2>
            <ChannelSelector
              workspaceId={workspaceId}
              value={data.channels}
              onChange={handleChannelsChange}
            />
          </section>
          <section>
            <ComposerTabs
              draft={data}
              onBaseChange={handleBaseChange}
              onTwitterOverrideChange={handleTwitterOverride}
            />
          </section>
        </main>
        <PublishPanel draft={data} workspaceId={workspaceId} />
      </div>
    </div>
  )
}
```

Verify `useUpdateDraft` exposes both `patch(partial)` (the debounced API) and `isSaving`. If the existing hook does not, expose those before continuing — the Phase 1 hook builds the debounced patch coalescer; this is the consumer surface for it.

- [ ] **Step 2: Lint + build**

```bash
npm run lint
npm run build
```

Expected: PASS.

- [ ] **Step 3: Manual smoke test in browser**

Run: `npm run dev` (from `socialmedia-frontend/`)
Pre-req: backend running on port 3000, at least one Twitter channel connected.

Verify:
- Navigate to `/w/<wsId>/posts/new` → redirects to `posts/<draftId>/edit`
- Type in Original editor → auto-saves (header shows "saving..." → "saved")
- Click "Add channel" → see connected Twitter accounts → select one → tab "Twitter (1)" appears
- Switch to Twitter tab → edit text → preview updates → counter shows progress
- Click "Reset to Original" → override clears, inherits base text
- Click "Publish now" → status row shows publishing → published with link to tweet
- Disconnect token / revoke → retry → see "Retry" button → click → state transitions visible via WebSocket

- [ ] **Step 4: Commit**

```bash
git add src/features/composer/pages/composer-page.tsx
git commit -m "feat(composer): wire Phase 2 UI — tabs, channel selector, publish panel"
```

---

### Task 18: Tag the phase

- [ ] **Step 1: Tag the commit**

```bash
git tag phase-2-post-composer-twitter-mvp
```

- [ ] **Step 2: Update todo**

Mark "Execute Phase 2" complete in the TodoWrite tracker. The publisher integration shaped Phase 3's pattern (per-platform tabs + previews + capability-driven validation), so move on to Phase 3 only after this tag exists and the browser smoke test passes.

---

## Risks and tradeoffs

- **Synchronous publish path:** Phase 2 calls `publisher.publish()` in-process on the controller request. For Twitter this is fast (~1–2 s) and acceptable. For Phase 3 (YouTube/Instagram) we'll re-route through BullMQ to handle long-running uploads. Building both now would duplicate work — defer.

- **No rate limiting in orchestrator:** The legacy `PostService.publishPost` has `RateLimiterService` checks. Phase 2 omits them — Twitter's per-app limits are generous and we publish one tweet per click. Phase 5 (or sooner if abuse appears) unifies the two publish paths and adds rate limiting to the orchestrator.

- **TipTap getText() loses formatting:** Phase 2 stores plain text in `BaseContent.text`. When Phase 3 introduces LinkedIn (which supports rich text/links), we'll switch to storing TipTap JSON and rendering per-platform. Migration is one DB-level transform.

- **Channel credentials adapter assumes plaintext access tokens:** If access tokens are encrypted at rest, the adapter must use the existing decryption path. Verify this when implementing Task 4 — do NOT bypass any existing decryption helper.

- **WebSocket auth uses a token snapshot:** `auth: () => ({ token: getAccessToken() })` only re-reads on reconnect. If the user's access token rotates mid-session, the socket may drift. The Phase 1 axios client already handles HTTP refresh; we re-evaluate the WS reconnect-on-401 path in Phase 3.

## Success criteria

1. From a fresh draft, the user can: select ≥1 Twitter account, type or paste text, see a fidelity preview update live, click Publish, and within a few seconds see "Published" with a working link to twitter.com.
2. If publish fails for a channel, the failure shows the cause (auth/rate/media/etc.), and the Retry button re-runs only that channel.
3. Mixed multi-account publish (e.g. 2 Twitter accounts, one valid token + one revoked) ends in `partial_success` and surfaces both states.
4. All new backend tests green: `npm test -- composer` shows ≥24 passing tests (Phase 1's 19 + Phase 2's 5+ from orchestrator + 6 from error mapper).
5. Frontend builds clean: `npm run build` produces no type errors.
