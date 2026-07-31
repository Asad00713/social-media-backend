import {
  Controller,
  Get,
  HttpCode,
  Inject,
  Logger,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import type { Request, Response } from 'express';
import { QUEUES } from '../../queue/queue.module';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import { socialMediaChannels } from '../../drizzle/schema/channels.schema';
import { YouTubePubSubHubbubService } from './services/youtube-pubsubhubbub.service';

/**
 * Public (no auth) webhook controller for YouTube PubSubHubbub (WebSub).
 *
 * GET  /channels/analytics/youtube/pubsubhubbub — hub verification (echoes hub.challenge)
 * POST /channels/analytics/youtube/pubsubhubbub — hub notification (new/updated video)
 *
 * Both endpoints must respond quickly (< 5s) and return 200. The hub will
 * retry POST notifications with exponential back-off if we return non-2xx.
 */
@Controller('channels/analytics/youtube/pubsubhubbub')
export class YouTubePubSubHubbubController {
  private readonly logger = new Logger(YouTubePubSubHubbubController.name);

  constructor(
    private readonly pubsub: YouTubePubSubHubbubService,
    @InjectQueue(QUEUES.CHANNEL_SNAPSHOTS) private readonly queue: Queue,
    @Inject(DRIZZLE) private readonly db: any,
  ) {}

  /**
   * Hub verification step (RFC 8030 §5.3).
   * Hub sends GET with hub.mode=subscribe, hub.topic, hub.challenge, hub.lease_seconds.
   * We must respond 200 with hub.challenge as plain text to confirm ownership.
   */
  @Get()
  async verify(
    @Query('hub.mode') mode: string,
    @Query('hub.topic') topic: string,
    @Query('hub.challenge') challenge: string,
    @Res() res: Response,
  ): Promise<void> {
    this.logger.log(
      `PubSubHubbub verify: mode=${mode} topic=${topic ?? '(none)'}`,
    );

    if (mode === 'subscribe' && challenge) {
      // Persist lease expiry asynchronously — don't let DB latency delay the echo
      const ytChannelId = topic?.match(/channel_id=([^&]+)/)?.[1];
      if (ytChannelId) {
        this.pubsub.confirmSubscription(ytChannelId).catch((e: Error) => {
          this.logger.warn(
            `PubSubHubbub confirmSubscription error: ${e.message}`,
          );
        });
      }
      res.status(200).type('text/plain').send(challenge);
      return;
    }

    if (mode === 'unsubscribe' && challenge) {
      // Accept unsubscribe verifications gracefully
      res.status(200).type('text/plain').send(challenge);
      return;
    }

    res.status(400).send('Bad Request');
  }

  /**
   * Hub notification step.
   * Hub POSTs Atom XML (Content-Type: application/atom+xml) when a subscribed
   * channel uploads or updates a video. We parse the video/channel IDs and
   * enqueue a channel-recent-posts-sync job (sinceDays=1) for an immediate import.
   *
   * Express will NOT parse application/atom+xml automatically, so we consume
   * the request stream directly to get the raw body string.
   */
  @Post()
  @HttpCode(200)
  async notify(@Req() req: Request, @Res() res: Response): Promise<void> {
    // Read the raw request body from the stream (Express leaves atom+xml unparsed)
    const rawBody = await readStream(req);

    const parsed = this.pubsub.parseAtomFeed(rawBody);
    if (!parsed) {
      this.logger.warn(
        `PubSubHubbub POST: could not parse Atom feed (body length=${rawBody.length})`,
      );
      // Always ack — returning non-200 causes the hub to retry indefinitely
      res.status(200).send('ok');
      return;
    }

    this.logger.log(
      `PubSubHubbub POST: videoId=${parsed.videoId} ytChannelId=${parsed.channelId}`,
    );

    // Resolve to our internal channel
    const rows = (await this.db
      .select({
        id: socialMediaChannels.id,
        workspaceId: socialMediaChannels.workspaceId,
      })
      .from(socialMediaChannels)
      .where(
        eq(socialMediaChannels.platformAccountId, parsed.channelId),
      )) as Array<{ id: number; workspaceId: string }>;

    if (rows.length === 0) {
      this.logger.warn(
        `PubSubHubbub POST: no channel found for ytChannelId=${parsed.channelId} — ignoring`,
      );
      res.status(200).send('ok');
      return;
    }

    // Fan out to EVERY workspace that connected this YouTube channel — the same
    // channel can be connected by more than one workspace, and a single-row
    // lookup would sync the new upload for only one of them.
    for (const channel of rows) {
      // Enqueue an immediate recent-posts-sync (sinceDays=1, limit=5)
      await this.queue.add('channel-recent-posts-sync', {
        channelId: Number(channel.id),
        workspaceId: channel.workspaceId,
        sinceDays: 1,
        limit: 5,
      });
    }

    this.logger.log(
      `PubSubHubbub POST: enqueued recent-posts-sync for ${rows.length} channel(s) (ytChannelId=${parsed.channelId}, videoId=${parsed.videoId})`,
    );

    res.status(200).send('ok');
  }
}

/**
 * Collect chunks from an IncomingMessage stream into a single UTF-8 string.
 * Resolves to an empty string if the stream emits no data within 10 s.
 */
function readStream(req: Request): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const timeout = setTimeout(
      () => resolve(Buffer.concat(chunks).toString('utf-8')),
      10_000,
    );
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      clearTimeout(timeout);
      resolve(Buffer.concat(chunks).toString('utf-8'));
    });
    req.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}
