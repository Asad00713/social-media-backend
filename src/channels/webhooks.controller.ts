import {
  Controller,
  Get,
  Post,
  Query,
  Body,
  HttpCode,
  HttpStatus,
  Logger,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { InboxService } from '../inbox/inbox.service';
import type { SupportedPlatform } from '../drizzle/schema/channels.schema';

/**
 * Webhooks Controller — receives push events from social platforms.
 *
 * Public (no JWT auth) since events come from external services. Webhook
 * authenticity is verified per-platform:
 *   - Meta (FB/IG/Threads): hub.verify_token on registration; HMAC signature
 *     verification of POST body for production (TODO — Phase 1 skips and
 *     relies on the verify_token + IP allowlist).
 *
 * Registered in `InboxModule` (not ChannelsModule) so it can inject
 * InboxService without a circular dep.
 */
@Controller('webhooks')
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  private readonly META_VERIFY_TOKEN =
    process.env.META_WEBHOOK_VERIFY_TOKEN || 'webondev_verify_123';

  constructor(private readonly inbox: InboxService) {}

  // ==========================================================================
  // Meta (Facebook / Instagram / Threads) — verification challenges
  // ==========================================================================

  @Get('instagram')
  @HttpCode(HttpStatus.OK)
  verifyInstagramWebhook(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
    @Res() res: Response,
  ) {
    return this.respondToVerify('instagram', mode, token, challenge, res);
  }

  @Get('facebook')
  @HttpCode(HttpStatus.OK)
  verifyFacebookWebhook(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
    @Res() res: Response,
  ) {
    return this.respondToVerify('facebook', mode, token, challenge, res);
  }

  @Get('threads')
  @HttpCode(HttpStatus.OK)
  verifyThreadsWebhook(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
    @Res() res: Response,
  ) {
    return this.respondToVerify('threads', mode, token, challenge, res);
  }

  private respondToVerify(
    source: string,
    mode: string,
    token: string,
    challenge: string,
    res: Response,
  ) {
    this.logger.log(
      `${source} webhook verification: mode=${mode}, token=${token ? 'present' : 'missing'}`,
    );
    if (mode === 'subscribe' && token === this.META_VERIFY_TOKEN) {
      this.logger.log(`${source} webhook verified successfully`);
      return res.status(200).send(challenge);
    }
    this.logger.warn(`${source} webhook verification failed`);
    return res.status(403).send('Verification failed');
  }

  // ==========================================================================
  // Meta — event delivery
  // ==========================================================================

  @Post('instagram')
  @HttpCode(HttpStatus.OK)
  async handleInstagramWebhook(@Body() body: any, @Res() res: Response) {
    // Meta requires a fast 200; everything heavy happens async.
    res.status(200).send('EVENT_RECEIVED');
    try {
      await this.processMetaWebhook(body, 'instagram');
    } catch (error) {
      this.logger.error('Error processing Instagram webhook:', error);
    }
  }

  @Post('facebook')
  @HttpCode(HttpStatus.OK)
  async handleFacebookWebhook(@Body() body: any, @Res() res: Response) {
    res.status(200).send('EVENT_RECEIVED');
    try {
      await this.processMetaWebhook(body, 'facebook');
    } catch (error) {
      this.logger.error('Error processing Facebook webhook:', error);
    }
  }

  @Post('threads')
  @HttpCode(HttpStatus.OK)
  async handleThreadsWebhook(@Body() body: any, @Res() res: Response) {
    res.status(200).send('EVENT_RECEIVED');
    try {
      await this.processMetaWebhook(body, 'threads');
    } catch (error) {
      this.logger.error('Error processing Threads webhook:', error);
    }
  }

  // ==========================================================================
  // Dispatch
  // ==========================================================================

  private async processMetaWebhook(
    payload: any,
    source: 'instagram' | 'facebook' | 'threads',
  ): Promise<void> {
    const entries = payload?.entry ?? [];
    for (const entry of entries) {
      const accountId = entry.id as string;
      const eventTime = entry.time
        ? new Date(Number(entry.time) * 1000)
        : new Date();
      const changes = entry.changes ?? [];

      for (const change of changes) {
        const field = change.field as string;
        const value = change.value ?? {};

        this.logger.log(
          `${source} webhook — account=${accountId} field=${field}`,
        );

        try {
          if (source === 'instagram' && field === 'comments') {
            await this.ingestInstagramComment(accountId, value, eventTime);
          } else if (
            source === 'facebook' &&
            (field === 'feed' || field === 'comments')
          ) {
            await this.ingestFacebookFeedEvent(accountId, value, eventTime);
          } else if (source === 'threads' && field === 'replies') {
            await this.ingestThreadsReply(accountId, value, eventTime);
          } else {
            // mentions / messages / story_insights → Phase 2 / analytics.
            this.logger.verbose(`Ignoring ${source} field '${field}' in Phase 1`);
          }
        } catch (err) {
          this.logger.error(
            `${source} webhook handler failed: ${(err as Error).message}`,
          );
        }
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // Instagram — value shape:
  //   { id, from{id,username}, media{id,...}, text, parent_id? }
  // ──────────────────────────────────────────────────────────────────────
  private async ingestInstagramComment(
    igUserId: string,
    value: any,
    eventTime: Date,
  ): Promise<void> {
    const platformItemId = value.id as string | undefined;
    const mediaId = value.media?.id as string | undefined;
    if (!platformItemId || !mediaId) {
      this.logger.warn('Instagram comment webhook missing id or media.id');
      return;
    }

    await this.ingestFromWebhook({
      platform: 'instagram',
      platformAccountIdToMatch: igUserId,
      platformItemId,
      platformParentId: (value.parent_id as string | undefined) ?? null,
      platformPostId: mediaId,
      authorPlatformId: value.from?.id,
      authorHandle: value.from?.username,
      authorDisplayName: value.from?.username,
      text: (value.text as string | undefined) ?? '',
      eventTime,
    });
  }

  // ──────────────────────────────────────────────────────────────────────
  // Facebook — `feed` field with value.item === 'comment', verb 'add' | 'edit'.
  // Comment shape inside value:
  //   { item: 'comment', verb, comment_id, parent_id, post_id, from, message, created_time }
  // ──────────────────────────────────────────────────────────────────────
  private async ingestFacebookFeedEvent(
    pageId: string,
    value: any,
    eventTime: Date,
  ): Promise<void> {
    if (value.item && value.item !== 'comment') return;
    if (value.verb && value.verb !== 'add' && value.verb !== 'edit') {
      // Don't surface deletions in Phase 1 — would need a soft-delete column.
      return;
    }

    const platformItemId = value.comment_id as string | undefined;
    const postId = value.post_id as string | undefined;
    if (!platformItemId || !postId) {
      this.logger.warn('Facebook comment webhook missing comment_id or post_id');
      return;
    }

    // parent_id can equal post_id for top-level comments — normalize to null.
    let parentId = (value.parent_id as string | undefined) ?? null;
    if (parentId === postId) parentId = null;

    const createdAt = value.created_time
      ? new Date(Number(value.created_time) * 1000)
      : eventTime;

    await this.ingestFromWebhook({
      platform: 'facebook',
      platformAccountIdToMatch: pageId,
      platformItemId,
      platformParentId: parentId,
      platformPostId: postId,
      authorPlatformId: value.from?.id,
      authorHandle: value.from?.id,
      authorDisplayName: value.from?.name,
      text: (value.message as string | undefined) ?? '',
      eventTime: createdAt,
    });
  }

  // ──────────────────────────────────────────────────────────────────────
  // Threads — `replies` field. Shape (per Meta docs):
  //   { id, text, timestamp, root_post_id, replied_to{id}, from{id,username} }
  // ──────────────────────────────────────────────────────────────────────
  private async ingestThreadsReply(
    threadsUserId: string,
    value: any,
    eventTime: Date,
  ): Promise<void> {
    const platformItemId = value.id as string | undefined;
    const rootPostId = (value.root_post_id ?? value.replied_to_id) as
      | string
      | undefined;
    if (!platformItemId || !rootPostId) {
      this.logger.warn('Threads reply webhook missing id or root_post_id');
      return;
    }

    const createdAt = value.timestamp ? new Date(value.timestamp) : eventTime;

    await this.ingestFromWebhook({
      platform: 'threads',
      platformAccountIdToMatch: threadsUserId,
      platformItemId,
      platformParentId: (value.replied_to?.id as string | undefined) ?? null,
      platformPostId: rootPostId,
      authorPlatformId: value.from?.id,
      authorHandle: value.from?.username,
      authorDisplayName: value.from?.username,
      text: (value.text as string | undefined) ?? '',
      eventTime: createdAt,
    });
  }

  // ──────────────────────────────────────────────────────────────────────
  // Common ingest path — resolves channel, looks up our post, upserts.
  // Drops the event silently if the comment is on a post we didn't publish
  // (Phase 1 scope: only show comments on Schedura-published posts).
  // ──────────────────────────────────────────────────────────────────────
  private async ingestFromWebhook(args: {
    platform: SupportedPlatform;
    platformAccountIdToMatch: string;
    platformItemId: string;
    platformParentId: string | null;
    platformPostId: string;
    authorPlatformId?: string;
    authorHandle?: string;
    authorDisplayName?: string;
    text: string;
    eventTime: Date;
  }): Promise<void> {
    const channel = await this.inbox.findChannelByPlatformAccount(
      args.platform,
      args.platformAccountIdToMatch,
    );
    if (!channel) {
      this.logger.warn(
        `Webhook for ${args.platform} account ${args.platformAccountIdToMatch}: channel not connected`,
      );
      return;
    }

    // Only ingest comments on posts published via Schedura.
    const ourPostId = await this.inbox.findOurPostId(
      channel.id,
      args.platformPostId,
    );
    if (!ourPostId) {
      this.logger.verbose(
        `Webhook ignored: ${args.platform} post ${args.platformPostId} not from Schedura`,
      );
      return;
    }

    await this.inbox.upsertComment({
      workspaceId: channel.workspaceId,
      channelId: channel.id,
      platform: args.platform,
      platformItemId: args.platformItemId,
      platformParentId: args.platformParentId,
      platformPostId: args.platformPostId,
      ourPostId,
      authorPlatformId: args.authorPlatformId,
      authorHandle: args.authorHandle,
      authorDisplayName: args.authorDisplayName,
      text: args.text,
      fromMe: false, // webhooks don't fire for our own comments; safe default
      platformCreatedAt: args.eventTime,
    });
  }
}
