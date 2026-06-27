import {
  Controller,
  Get,
  Post,
  Query,
  Body,
  HttpCode,
  HttpStatus,
  HttpException,
  Logger,
  Param,
  Req,
  Res,
  Headers,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import type { Request as ExpressRequest, Response } from 'express';
import {
  verifySlackSignature,
  verifyMetaSignature,
} from '../common/utils/webhook-signature.util';
import { verifyTelegramWebhookSecret } from './utils/telegram-webhook-secret.util';
import { secureCompare } from '../common/utils/encryption.util';
import { parseWhatsAppMessages } from './services/whatsapp-webhook.util';
import { InboxService } from '../inbox/inbox.service';
import { FacebookService } from './services/facebook.service';
import { InstagramService } from './services/instagram.service';
import { ChannelService } from './services/channel.service';
import type { SupportedPlatform } from '../drizzle/schema/channels.schema';
import { QUEUES } from '../queue/queue.module';

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

  private readonly META_APP_SECRET = process.env.META_APP_SECRET || '';

  private readonly SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET!;

  constructor(
    private readonly inbox: InboxService,
    private readonly facebookService: FacebookService,
    private readonly instagramService: InstagramService,
    private readonly channelService: ChannelService,
    @InjectQueue(QUEUES.LEAD_INTAKE) private readonly leadIntakeQueue: Queue,
    @InjectQueue(QUEUES.SLACK_INGEST) private readonly slackQueue: Queue,
    @InjectQueue(QUEUES.TELEGRAM_INGEST) private readonly telegramQueue: Queue,
    @InjectQueue(QUEUES.WHATSAPP_INGEST)
    private readonly whatsappIngestQueue: Queue,
    @InjectQueue(QUEUES.MAESTRO_BRIDGE)
    private readonly maestroBridgeQueue: Queue,
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

  @Get('whatsapp')
  @HttpCode(HttpStatus.OK)
  verifyWhatsAppWebhook(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
    @Res() res: Response,
  ) {
    return this.respondToVerify('whatsapp', mode, token, challenge, res);
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

  @Post('whatsapp')
  @HttpCode(HttpStatus.OK)
  async handleWhatsAppWebhook(@Req() req: ExpressRequest, @Res() res: Response) {
    const sig = req.headers['x-hub-signature-256'] as string | undefined;
    const raw = (req as any).rawBody as Buffer | undefined;
    const ok =
      !!this.META_APP_SECRET &&
      !!raw &&
      verifyMetaSignature({
        appSecret: this.META_APP_SECRET,
        signatureHeader: sig,
        rawBody: raw,
      });
    if (!ok) {
      this.logger.warn('WhatsApp webhook signature verification failed');
      return res.status(401).send('invalid signature');
    }
    // ACK fast, then process async.
    res.status(200).send('EVENT_RECEIVED');
    try {
      // One Meta app = one webhook URL. If this payload is for the dedicated
      // Maestro number, divert it to the bridge instead of the inbox ingest so a
      // single callback URL can serve both.
      const maestroPnid = process.env.MAESTRO_WHATSAPP_PHONE_NUMBER_ID;
      const forMaestro =
        !!maestroPnid &&
        parseWhatsAppMessages(req.body).some(
          (m) => m.phoneNumberId === maestroPnid,
        );
      if (forMaestro) {
        await this.maestroBridgeQueue.add(
          'whatsapp-update',
          { channel: 'whatsapp', payload: req.body },
          { removeOnComplete: true, removeOnFail: 100, attempts: 2 },
        );
        return;
      }
      await this.whatsappIngestQueue.add(
        'whatsapp-ingest',
        { payload: req.body },
        { attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
      );
    } catch (err) {
      this.logger.error(
        `WhatsApp webhook enqueue failed: ${(err as Error).message}`,
      );
    }
  }

  // ==========================================================================
  // Dispatch
  // ==========================================================================

  private async processMetaWebhook(
    payload: any,
    source: 'instagram' | 'facebook' | 'threads',
  ): Promise<void> {
    // Diagnostic top-level log — emits once per webhook delivery so we can see
    // what Meta is actually sending us. Use to debug missing events.
    this.logger.log(
      `${source} webhook payload received: object=${payload?.object} entries=${(payload?.entry ?? []).length}`,
    );

    const entries = payload?.entry ?? [];
    for (const entry of entries) {
      const accountId = entry.id as string;
      const eventTime = entry.time
        ? new Date(Number(entry.time) * 1000)
        : new Date();

      // Phase 2.1 — DM events arrive on `entry.messaging[]` (not `entry.changes[]`).
      // FB Messenger and IG Direct both use this shape. Threads has no DM API.
      const messagingEvents = entry.messaging ?? [];
      this.logger.log(
        `${source} entry: id=${accountId} messaging=${messagingEvents.length} changes=${(entry.changes ?? []).length}`,
      );
      if (messagingEvents.length > 0 && source !== 'threads') {
        for (const event of messagingEvents) {
          // Log the raw event so we can see exact payload shape from IG.
          this.logger.log(
            `${source} messaging event: ${JSON.stringify(event).slice(0, 500)}`,
          );
          try {
            await this.ingestMetaMessagingEvent(
              source,
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
          if (field === 'leadgen') {
            // Meta Ads lead gen — field arrives on FB Page webhooks when a user
            // submits a lead form. Queue async so we can 200 Meta immediately.
            await this.leadIntakeQueue.add(
              'lead-intake',
              {
                leadgenId: value.leadgen_id as string,
                pageId: value.page_id as string,
                formId: value.form_id as string,
                adId: value.ad_id as string | undefined,
                adsetId: value.adset_id as string | undefined,
                campaignId: value.campaign_id as string | undefined,
                createdTime: value.created_time as number | undefined,
              },
              { attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
            );
          } else if (source === 'instagram' && field === 'comments') {
            await this.ingestInstagramComment(accountId, value, eventTime);
          } else if (source === 'instagram' && field === 'messages') {
            // IG Direct DMs arrive via changes[].field='messages' (NOT
            // entry.messaging[] like FB Messenger). Same inner shape though:
            //   value = { sender:{id}, recipient:{id}, timestamp, message:{mid,text} }
            // Route to the shared ingestMetaMessagingEvent path.
            await this.ingestMetaMessagingEvent(
              'instagram',
              accountId,
              value,
              eventTime,
            );
          } else if (
            source === 'facebook' &&
            (field === 'feed' || field === 'comments')
          ) {
            await this.ingestFacebookFeedEvent(accountId, value, eventTime);
          } else if (source === 'threads' && field === 'replies') {
            await this.ingestThreadsReply(accountId, value, eventTime);
          } else {
            this.logger.verbose(
              `Ignoring ${source} field '${field}' in Phase 1`,
            );
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
        `${source} DM webhook: NO CHANNEL FOUND for platform=${source} platformAccountId=${accountId}. ` +
          `Check that the connected channel's platformAccountId matches this id ` +
          `(diff = the IG/page id in webhook vs what OAuth stored).`,
      );
      return;
    }
    this.logger.log(
      `${source} DM webhook: matched channel=${channel.id} workspace=${channel.workspaceId}`,
    );

    // Timestamp parsing — FB Messenger sends ms, IG samples sometimes show
    // seconds. Auto-detect: anything below 10^12 is seconds.
    let createdAt: Date = eventTime;
    if (event.timestamp) {
      const tsNum = Number(event.timestamp);
      if (Number.isFinite(tsNum) && tsNum > 0) {
        createdAt = new Date(tsNum < 1e12 ? tsNum * 1000 : tsNum);
      }
    }

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
      this.logger.warn(
        'Facebook comment webhook missing comment_id or post_id',
      );
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

  // ==========================================================================
  // Slack — Events API
  // ==========================================================================

  /**
   * Slack Events API webhook. Receives every event from every workspace where
   * the Schedura app is installed. Routes by `team_id` in the payload.
   *
   * Signature verification: HMAC-SHA256 over `v0:<ts>:<raw_body>` with the
   * Signing Secret. Replay protection: ±5 minutes.
   *
   * url_verification handshake: Slack hits this endpoint once when the URL is
   * registered; we reflect the challenge value back.
   *
   * event_callback: enqueue to BullMQ SLACK_INGEST and respond 200 within 3s
   * so Slack doesn't retry / disable the app.
   */
  @Post('slack/events')
  @HttpCode(HttpStatus.OK)
  async slackEvents(
    @Req() req: ExpressRequest,
    @Headers('x-slack-signature') signature: string | undefined,
    @Headers('x-slack-request-timestamp') timestamp: string | undefined,
  ) {
    // Raw body (configured in main.ts) — Buffer on this route only.
    const rawBuf = req.body as unknown as Buffer;
    const raw = rawBuf?.toString('utf8') ?? '';

    if (
      !verifySlackSignature({
        signingSecret: this.SLACK_SIGNING_SECRET,
        timestamp,
        signature,
        rawBody: raw,
      })
    ) {
      this.logger.warn('Slack webhook signature verification failed');
      throw new HttpException('signature mismatch', HttpStatus.UNAUTHORIZED);
    }

    const payload = JSON.parse(raw) as Record<string, any>;

    // url_verification — Slack expects the challenge back.
    if (payload.type === 'url_verification') {
      return { challenge: payload.challenge };
    }

    // event_callback — the real event. Enqueue and ack fast.
    if (payload.type === 'event_callback') {
      await this.slackQueue.add('ingest', payload, {
        jobId: payload.event_id as string | undefined, // dedupe — Slack retries on non-2xx
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 1000,
        removeOnFail: 500,
      });
      return { ok: true };
    }

    this.logger.warn(`Unhandled Slack payload type: ${payload.type}`);
    return { ok: true };
  }

  // ==========================================================================
  // Telegram — per-bot webhook route
  // ==========================================================================

  @Post('telegram/:routeId')
  @HttpCode(HttpStatus.OK)
  async receiveTelegramUpdate(
    @Param('routeId') routeId: string,
    @Headers('x-telegram-bot-api-secret-token')
    headerSecret: string | undefined,
    @Body() update: Record<string, unknown>,
  ) {
    const channel = await this.inbox.findTelegramChannelByRouteId(routeId);
    if (!channel) {
      this.logger.warn(`Telegram webhook: unknown routeId ${routeId}`);
      return { ok: true };
    }
    if (!verifyTelegramWebhookSecret(routeId, headerSecret)) {
      this.logger.warn(
        `Telegram webhook secret mismatch for routeId ${routeId}`,
      );
      throw new HttpException('Forbidden', HttpStatus.FORBIDDEN);
    }
    await this.telegramQueue.add(
      'update',
      { channelId: channel.id, workspaceId: channel.workspaceId, update },
      { removeOnComplete: true, attempts: 3 },
    );
    return { ok: true };
  }

  // ==========================================================================
  // Maestro bridge — central assistant bot (separate from inbox bots)
  // ==========================================================================

  /**
   * Inbound updates for the CENTRAL Maestro Telegram bot (the owner's private
   * line to their assistant). Distinct from the per-workspace inbox bot route
   * above: one static secret, no routeId, no channel lookup. Verifies the
   * secret then enqueues the raw update for the bridge processor.
   */
  @Post('maestro/telegram')
  @HttpCode(HttpStatus.OK)
  async receiveMaestroTelegram(
    @Headers('x-telegram-bot-api-secret-token')
    headerSecret: string | undefined,
    @Body() update: Record<string, unknown>,
  ) {
    const expected = process.env.MAESTRO_TELEGRAM_WEBHOOK_SECRET || '';
    if (!expected || !headerSecret || !secureCompare(headerSecret, expected)) {
      // Don't leak which check failed; drop quietly (Telegram won't usefully retry).
      return { ok: true };
    }
    await this.maestroBridgeQueue.add(
      'telegram-update',
      { channel: 'telegram', update },
      { removeOnComplete: true, removeOnFail: 100, attempts: 2 },
    );
    return { ok: true };
  }

  /** GET verification challenge for the central Maestro WhatsApp number. */
  @Get('maestro/whatsapp')
  @HttpCode(HttpStatus.OK)
  verifyMaestroWhatsApp(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
    @Res() res: Response,
  ) {
    const expected =
      process.env.MAESTRO_WHATSAPP_VERIFY_TOKEN ||
      process.env.META_WEBHOOK_VERIFY_TOKEN ||
      '';
    if (mode === 'subscribe' && !!expected && token === expected) {
      return res.status(HttpStatus.OK).send(challenge);
    }
    return res.status(HttpStatus.FORBIDDEN).send('Verification failed');
  }

  /**
   * Inbound messages for the CENTRAL Maestro WhatsApp number. Separate from the
   * inbox WhatsApp webhook; the processor filters by phone_number_id so foreign
   * numbers are ignored. Meta-signature verified, then enqueued for the bridge.
   */
  @Post('maestro/whatsapp')
  @HttpCode(HttpStatus.OK)
  async receiveMaestroWhatsApp(
    @Req() req: ExpressRequest,
    @Res() res: Response,
  ) {
    const sig = req.headers['x-hub-signature-256'] as string | undefined;
    const raw = (req as unknown as { rawBody?: Buffer }).rawBody;
    const secret =
      process.env.MAESTRO_WHATSAPP_APP_SECRET || process.env.META_APP_SECRET || '';
    const ok =
      !!secret &&
      !!raw &&
      verifyMetaSignature({
        appSecret: secret,
        signatureHeader: sig,
        rawBody: raw,
      });
    if (!ok) {
      this.logger.warn('Maestro WhatsApp webhook signature verification failed');
      return res.status(HttpStatus.UNAUTHORIZED).send('invalid signature');
    }
    res.status(HttpStatus.OK).send('EVENT_RECEIVED');
    try {
      await this.maestroBridgeQueue.add(
        'whatsapp-update',
        { channel: 'whatsapp', payload: req.body },
        { removeOnComplete: true, removeOnFail: 100, attempts: 2 },
      );
    } catch (err) {
      this.logger.error(
        `Failed to enqueue Maestro WhatsApp update: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
