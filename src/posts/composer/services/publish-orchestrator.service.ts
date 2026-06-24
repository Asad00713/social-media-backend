import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { PayloadResolverService } from './payload-resolver.service';
import { ComposerErrorMapperService } from './composer-error-mapper.service';
import { PublisherFactory } from '../../publishers/publisher.factory';
import { AnalyticsEventEmitter } from '../../../realtime/analytics-event-emitter.service';
import { DRIZZLE } from '../../../drizzle/drizzle.module';
import { posts } from '../../../drizzle/schema/posts.schema';
import { socialMediaChannels } from '../../../drizzle/schema/channels.schema';
import { channelSyncState } from '../../../drizzle/schema/channel-sync-state.schema';
import type {
  BaseContent,
  ChannelTarget,
  Draft,
  PlatformOverrides,
  PublishStatus,
  ScheduleConfig,
} from '../types/draft.types';

export const CHANNEL_CREDENTIALS_LOOKUP = 'CHANNEL_CREDENTIALS_LOOKUP';

export interface ChannelCredentialsLookup {
  getCredentials(
    workspaceId: string,
    channelId: string,
  ): Promise<{
    accessToken: string;
    platformAccountId: string;
    channelMetadata: Record<string, any>;
  }>;
}

export interface InlinePublishInput {
  draftId: string;
  base: BaseContent;
  perPlatform?: PlatformOverrides;
  channels: ChannelTarget[];
  schedule?: ScheduleConfig;
  retryChannelIds?: string[];
}

export interface PublishResultSummary {
  draftStatus: 'published' | 'partial_success' | 'failed';
  channels: ChannelTarget[];
  postId: string;
}

/**
 * Publishes (or retries publishing) a draft that lives entirely in the
 * browser. We never store an in-progress draft on the server — the row in
 * the `posts` table is created (or updated) only when the user clicks
 * Publish. Retries operate on the existing posts row identified by
 * `draftId` (the client-generated UUID, persisted in posts.id).
 */
@Injectable()
export class PublishOrchestratorService {
  private readonly logger = new Logger(PublishOrchestratorService.name);

  constructor(
    private readonly resolver: PayloadResolverService,
    private readonly errorMapper: ComposerErrorMapperService,
    private readonly publisherFactory: PublisherFactory,
    private readonly emitter: AnalyticsEventEmitter,
    @Inject(CHANNEL_CREDENTIALS_LOOKUP)
    private readonly credentials: ChannelCredentialsLookup,
    @Inject(DRIZZLE) private readonly db: any,
  ) {}

  async publishInline(
    workspaceId: string,
    userId: string,
    input: InlinePublishInput,
  ): Promise<PublishResultSummary> {
    if (!input.channels?.length) {
      throw new BadRequestException('Draft has no channels selected');
    }

    const isRetry = Boolean(input.retryChannelIds?.length);
    const targets = isRetry
      ? input.channels.filter((c) =>
          input.retryChannelIds!.includes(c.channelId),
        )
      : input.channels;

    if (isRetry && targets.length === 0) {
      throw new BadRequestException(
        'None of the specified channelIds match draft channels',
      );
    }

    // Build the in-memory Draft object used by the resolver. We don't
    // need a DB row for resolution — just the structure.
    const now = new Date().toISOString();
    const draft: Draft = {
      id: input.draftId,
      workspaceId,
      createdById: userId,
      status: 'publishing',
      base: input.base,
      perPlatform: input.perPlatform ?? {},
      channels: input.channels,
      schedule: input.schedule ?? { mode: 'now' },
      createdAt: now,
      updatedAt: now,
    };

    // Upsert the posts row. On first publish this inserts; on retry the
    // row already exists with the same id (client UUID) and we update it.
    await this.upsertPostsRow(workspaceId, userId, draft);

    this.emitter.emit(workspaceId, 'composer.draft.status.changed', {
      workspaceId,
      draftId: draft.id,
      status: 'publishing',
      updatedAt: now,
    });

    const updatedMap = new Map<string, ChannelTarget>();
    for (const c of input.channels) updatedMap.set(c.channelId, c);

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
      await this.persistChannels(workspaceId, draft.id, updatedMap);
      this.emitState(workspaceId, draft.id, next);

      try {
        const payload = this.resolver.resolve(
          { ...draft, channels: input.channels },
          target,
        );
        const creds = await this.credentials.getCredentials(
          workspaceId,
          target.channelId,
        );
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
        await this.persistChannels(workspaceId, draft.id, updatedMap);
        this.emitState(workspaceId, draft.id, ok);

        // Empirical heal: a successful publish proves the channel token
        // works, so reset any stale "expired" / "error" connectionStatus
        // that the analytics layer may have mis-classified. Trust real
        // outcomes over inferred sync failures.
        await this.healChannelStatus(target.channelId);
      } catch (err) {
        const classified = this.errorMapper.classify(err);
        const failed: ChannelTarget = {
          ...next,
          publishStatus: 'failed',
          errorCode: classified.code,
          errorMessage: err instanceof Error ? err.message : String(err),
        };
        updatedMap.set(target.channelId, failed);
        await this.persistChannels(workspaceId, draft.id, updatedMap);
        this.emitState(workspaceId, draft.id, failed);
        this.logger.warn(
          `Channel ${target.channelId} (${target.platform}) failed: ${failed.errorMessage}`,
        );
      }
    }

    const finalChannels = Array.from(updatedMap.values());
    const draftStatus = this.computeDraftStatus(finalChannels);
    // Legacy posts.status enum is the source of truth: ('draft' | 'scheduled'
    // | 'publishing' | 'published' | 'failed' | 'partially_published'). Map
    // our composer naming to legacy.
    const dbStatus =
      draftStatus === 'published'
        ? 'published'
        : draftStatus === 'partial_success'
          ? 'partially_published'
          : 'failed';
    const anySuccess = finalChannels.some(
      (c) => c.publishStatus === 'published',
    );

    await this.updateDraftStatus(workspaceId, draft.id, dbStatus, anySuccess);
    this.emitter.emit(workspaceId, 'composer.draft.status.changed', {
      workspaceId,
      draftId: draft.id,
      status: draftStatus,
      updatedAt: new Date().toISOString(),
    });

    return { draftStatus, channels: finalChannels, postId: draft.id };
  }

  private emitState(
    workspaceId: string,
    draftId: string,
    target: ChannelTarget,
  ): void {
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

  private async upsertPostsRow(
    workspaceId: string,
    userId: string,
    draft: Draft,
  ): Promise<void> {
    // Project to legacy PostTarget shape (with `status` field).
    const legacyTargets = draft.channels.map((c) => ({
      ...c,
      status: 'publishing',
    }));

    const metadata = {
      hashtags: draft.base.hashtags,
      mentions: draft.base.mentions,
      linkPreview: draft.base.linkPreview,
      schedule: draft.schedule,
    };

    // True upsert. Handles three scenarios:
    //   1) Fresh publish — row doesn't exist → INSERT
    //   2) Retry after partial_success — row exists → UPDATE the channel state
    //   3) Re-publish after a failed first attempt (validation, auth, etc.) —
    //      row exists with status='failed'; user fixed input and clicked
    //      Publish again. Without ON CONFLICT this throws unique-key on
    //      posts_pkey because we use the client-generated UUID as primary key.
    await this.db
      .insert(posts)
      .values({
        id: draft.id,
        workspaceId,
        createdById: userId,
        content: draft.base.text,
        mediaItems: draft.base.mediaItems as any,
        targets: legacyTargets as any,
        status: 'publishing',
        publishedAt: null,
        platformContent: draft.perPlatform as any,
        metadata: metadata as any,
      })
      .onConflictDoUpdate({
        target: posts.id,
        set: {
          content: draft.base.text,
          mediaItems: draft.base.mediaItems as any,
          targets: legacyTargets as any,
          status: 'publishing',
          publishedAt: null,
          platformContent: draft.perPlatform as any,
          metadata: metadata as any,
          updatedAt: new Date(),
          lastError: null,
        },
      });
  }

  private async persistChannels(
    workspaceId: string,
    draftId: string,
    map: Map<string, ChannelTarget>,
  ): Promise<void> {
    // Project to the legacy PostTarget shape that the analytics layer
    // and existing tooling (post-publish.processor, channel-detail page)
    // already understand. The legacy contract uses `status`, not
    // `publishStatus`. We mirror the value so both new composer code and
    // the legacy analytics query (which does `targets @> [{status:'published'}]`)
    // see the same truth.
    const targets = Array.from(map.values()).map((t) => ({
      ...t,
      status:
        t.publishStatus === 'published'
          ? 'published'
          : t.publishStatus === 'failed'
            ? 'failed'
            : t.publishStatus === 'publishing'
              ? 'publishing'
              : 'draft',
    }));
    await this.db
      .update(posts)
      .set({ targets: targets as any, updatedAt: new Date() })
      .where(and(eq(posts.id, draftId), eq(posts.workspaceId, workspaceId)));
  }

  /**
   * Resets a channel to a healthy state after a confirmed-working publish.
   * Idempotent: noop if the channel is already 'connected'. Clears stale
   * lastError and zeroes the consecutive-failure counter so the analytics
   * watchdog doesn't immediately re-flip the channel on the next sync.
   */
  private async healChannelStatus(channelIdStr: string): Promise<void> {
    const numericId = Number(channelIdStr);
    if (!Number.isFinite(numericId)) return;

    try {
      await this.db
        .update(socialMediaChannels)
        .set({
          connectionStatus: 'connected',
          lastError: null,
        })
        .where(eq(socialMediaChannels.id, numericId));

      await this.db
        .update(channelSyncState)
        .set({ consecutiveFailures: 0 })
        .where(eq(channelSyncState.channelId, numericId));
    } catch (err) {
      // Don't let healing failures break the publish flow.
      this.logger.warn(
        `healChannelStatus failed for channel ${channelIdStr}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private async updateDraftStatus(
    workspaceId: string,
    draftId: string,
    status: string,
    setPublishedAt = false,
  ): Promise<void> {
    // published_at is the column the analytics layer filters on. Set it
    // when at least one channel published successfully — analytics queries
    // (`published_at BETWEEN start AND end`) won't see the row otherwise.
    const patch: Record<string, unknown> = {
      status: status as any,
      updatedAt: new Date(),
    };
    if (setPublishedAt) patch.publishedAt = new Date();

    await this.db
      .update(posts)
      .set(patch)
      .where(and(eq(posts.id, draftId), eq(posts.workspaceId, workspaceId)));
  }

  private computeDraftStatus(
    channels: ChannelTarget[],
  ): 'published' | 'partial_success' | 'failed' {
    const statuses: PublishStatus[] = channels.map((c) => c.publishStatus);
    const allPublished = statuses.every((s) => s === 'published');
    const anyPublished = statuses.some((s) => s === 'published');
    if (allPublished) return 'published';
    if (anyPublished) return 'partial_success';
    return 'failed';
  }
}
