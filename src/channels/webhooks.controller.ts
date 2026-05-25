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
import { FacebookService } from './services/facebook.service';
import { InstagramService } from './services/instagram.service';
import { ChannelService } from './services/channel.service';
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

  constructor(
    private readonly inbox: InboxService,
    private readonly facebookService: FacebookService,
    private readonly instagramService: InstagramService,
    private readonly channelService: ChannelService,
  ) {}

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

      // Phase 2.1 — DM events arrive on `entry.messaging[]` (not `entry.changes[]`).
      // FB Messenger and IG Direct both use this shape. Threads has no DM API.
      const messagingEvents = entry.messaging ?? [];
      if (messagingEvents.length > 0 && source !== 'threads') {
        for (const event of messagingEvents) {
          try {
            await this.ingestMetaMessagingEvent(
              source as 'facebook' | 'instagram',
              accountId,
              event,
              eventTime,
            );
          } catch (err) {
            this.logger.error(
              `${source} DM webhook handler failed: ${(err as Error).message}`,
            );
          }
        }
      }

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

  /**
   * Ingest a Meta DM webhook event (FB Messenger or IG Direct).
   *
   * Event shape:
   *   { sender: { id: psid }, recipient: { id: pageId }, timestamp,
   *     message: { mid, text, ...(attachments / reactions / etc) } }
   *
   * For Phase 2.1 we ingest only text messages. Attachments / reactions /
   * read receipts are logged and dropped — Phase 2.2 will handle them.
   *
   * Conversation id format:
   *   FB:  `<pageId>:<senderPsid>`   (recipient = page, sender = user)
   *   IG:  `<igUserId>:<senderIgsid>`
   *
   * When the sender is the Page itself (echo of an outbound message), we still
   * upsert with fromMe=true; the unique constraint dedups against our optimistic
   * send insert.
   */
  private async ingestMetaMessagingEvent(
    source: 'facebook' | 'instagram',
    accountId: string,
    event: any,
    eventTime: Date,
  ): Promise<void> {
    const senderId = event?.sender?.id as string | undefined;
    const recipientId = event?.recipient?.id as string | undefined;
    const message = event?.message;

    if (!senderId || !recipientId || !message) {
      this.logger.verbose(
        `${source} messaging event ignored — non-text or missing fields`,
      );
      return;
    }

    const mid = message.mid as string | undefined;
    const text = (message.text as string | undefined) ?? '';
    if (!mid) return;

    // is_echo === true when the Page sent the message (outbound echo).
    const fromMe = message.is_echo === true || senderId === accountId;
    // Other-party id: the user (PSID/IGSID), not the page.
    const otherPartyId = fromMe ? recipientId : senderId;
    const conversationId = `${accountId}:${otherPartyId}`;

    // Look up channel + workspace by platform account id.
    const channel = await this.inbox.findChannelByPlatformAccount(
      source as SupportedPlatform,
      accountId,
    );
    if (!channel) {
      this.logger.warn(
        `${source} DM webhook: no channel for account ${accountId}`,
      );
      return;
    }

    const createdAt = event.timestamp
      ? new Date(Number(event.timestamp))
      : eventTime;

    // Enrich author info for inbound messages (not echoes). The webhook payload
    // only contains the platform id of the sender — name + avatar come from
    // the User Profile API. Best-effort: if the call fails, we still ingest
    // the row with null author fields and surface "Unknown" in the UI.
    let authorHandle: string | null = null;
    let authorDisplayName: string | null = null;
    let authorAvatarUrl: string | null = null;

    if (!fromMe) {
      try {
        const token = await this.channelService.getAccessToken(
          channel.id,
          channel.workspaceId,
        );
        if (source === 'facebook') {
          const profile = await this.facebookService.getMessengerUserProfile(
            otherPartyId,
            token,
          );
          if (profile) {
            authorHandle = profile.firstName ?? profile.name;
            authorDisplayName = profile.name;
            authorAvatarUrl = profile.profilePictureUrl;
          }
        } else {
          const profile = await this.instagramService.getInstagramUserProfile(
            otherPartyId,
            token,
          );
          if (profile) {
            authorHandle = profile.username;
            authorDisplayName = profile.name ?? profile.username;
            authorAvatarUrl = profile.profilePictureUrl;
          }
        }
      } catch (err) {
        this.logger.warn(
          `${source} DM author enrichment failed for ${otherPartyId}: ${(err as Error).message}`,
        );
      }
    }

    await this.inbox.upsertDm({
      workspaceId: channel.workspaceId,
      channelId: channel.id,
      platform: source as SupportedPlatform,
      conversationId,
      platformItemId: mid,
      platformParentId: (message.reply_to?.mid as string | undefined) ?? null,
      authorPlatformId: otherPartyId,
      authorHandle,
      authorDisplayName,
      authorAvatarUrl,
      text,
      fromMe,
      platformCreatedAt: createdAt,
      metadata: { raw: event },
    });

    this.logger.log(
      `${source} DM ingested: convo=${conversationId} mid=${mid} fromMe=${fromMe}`,
    );
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
