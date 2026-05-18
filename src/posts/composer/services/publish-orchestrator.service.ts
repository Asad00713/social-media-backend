import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { ComposerService } from './composer.service';
import { PayloadResolverService } from './payload-resolver.service';
import { ComposerErrorMapperService } from './composer-error-mapper.service';
import { PublisherFactory } from '../../publishers/publisher.factory';
import { AnalyticsEventEmitter } from '../../../realtime/analytics-event-emitter.service';
import { DRIZZLE } from '../../../drizzle/drizzle.module';
import { posts } from '../../../drizzle/schema/posts.schema';
import type { ChannelTarget, DraftStatus, PublishStatus } from '../types/draft.types';

export const CHANNEL_CREDENTIALS_LOOKUP = 'CHANNEL_CREDENTIALS_LOOKUP';

export interface ChannelCredentialsLookup {
  getCredentials(workspaceId: string, channelId: string): Promise<{
    accessToken: string;
    platformAccountId: string;
    channelMetadata: Record<string, any>;
  }>;
}

export interface PublishOptions {
  channelIds?: string[];
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

    await this.updateDraftStatus(workspaceId, draftId, 'publishing');
    this.emitter.emit(workspaceId, 'composer.draft.status.changed', {
      workspaceId, draftId, status: 'publishing', updatedAt: new Date().toISOString(),
    });

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
      await this.persistChannels(workspaceId, draftId, updatedMap);
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
        await this.persistChannels(workspaceId, draftId, updatedMap);
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
        await this.persistChannels(workspaceId, draftId, updatedMap);
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

  private async persistChannels(
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
