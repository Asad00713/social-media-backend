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

/**
 * Webhooks Controller
 *
 * Handles incoming webhooks from social media platforms.
 * These endpoints are public (no auth) as they receive data from external services.
 *
 * IMPORTANT: Webhook URLs must be:
 * - HTTPS in production
 * - Publicly accessible
 * - Return expected responses for verification
 */
@Controller('webhooks')
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  // Simple verify token - should be set in environment variables in production
  private readonly META_VERIFY_TOKEN =
    process.env.META_WEBHOOK_VERIFY_TOKEN || 'webondev_verify_123';

  // ==========================================================================
  // Meta (Facebook/Instagram) Webhooks
  // ==========================================================================

  /**
   * Meta Webhook Verification (GET)
   *
   * When you configure a webhook URL in Meta Developer Console,
   * Meta sends a GET request to verify your endpoint.
   *
   * Query params from Meta:
   * - hub.mode: Should be "subscribe"
   * - hub.verify_token: Your verify token (set in Meta dashboard)
   * - hub.challenge: Random string you must return
   *
   * @returns The hub.challenge value as plain text (200 OK)
   */
  @Get('instagram')
  @HttpCode(HttpStatus.OK)
  verifyInstagramWebhook(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
    @Res() res: Response,
  ) {
    this.logger.log(
      `Instagram webhook verification: mode=${mode}, token=${token ? 'present' : 'missing'}`,
    );

    if (mode === 'subscribe' && token === this.META_VERIFY_TOKEN) {
      this.logger.log('Instagram webhook verified successfully');
      // Return challenge as plain text
      return res.status(200).send(challenge);
    }

    this.logger.warn('Instagram webhook verification failed');
    return res.status(403).send('Verification failed');
  }

  /**
   * Meta Webhook Events (POST)
   *
   * Receives real-time updates from Instagram:
   * - Comments on your posts
   * - Messages (requires messaging permissions)
   * - Story mentions
   * - etc.
   *
   * IMPORTANT: Always return 200 OK quickly, then process async
   */
  @Post('instagram')
  @HttpCode(HttpStatus.OK)
  async handleInstagramWebhook(
    @Body() body: any,
    @Res() res: Response,
  ) {
    this.logger.log(`Instagram webhook received: ${JSON.stringify(body)}`);

    // Always return 200 OK immediately
    // Meta will retry if you don't respond within 20 seconds
    res.status(200).send('EVENT_RECEIVED');

    // Process the webhook asynchronously
    try {
      await this.processMetaWebhook(body, 'instagram');
    } catch (error) {
      this.logger.error('Error processing Instagram webhook:', error);
    }
  }

  /**
   * Facebook Webhook Verification (GET)
   */
  @Get('facebook')
  @HttpCode(HttpStatus.OK)
  verifyFacebookWebhook(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
    @Res() res: Response,
  ) {
    this.logger.log(
      `Facebook webhook verification: mode=${mode}, token=${token ? 'present' : 'missing'}`,
    );

    if (mode === 'subscribe' && token === this.META_VERIFY_TOKEN) {
      this.logger.log('Facebook webhook verified successfully');
      return res.status(200).send(challenge);
    }

    this.logger.warn('Facebook webhook verification failed');
    return res.status(403).send('Verification failed');
  }

  /**
   * Facebook Webhook Events (POST)
   */
  @Post('facebook')
  @HttpCode(HttpStatus.OK)
  async handleFacebookWebhook(
    @Body() body: any,
    @Res() res: Response,
  ) {
    this.logger.log(`Facebook webhook received: ${JSON.stringify(body)}`);

    res.status(200).send('EVENT_RECEIVED');

    try {
      await this.processMetaWebhook(body, 'facebook');
    } catch (error) {
      this.logger.error('Error processing Facebook webhook:', error);
    }
  }

  /**
   * Process Meta webhook events
   *
   * Meta webhook payload structure:
   * {
   *   "object": "instagram" | "page",
   *   "entry": [
   *     {
   *       "id": "page_or_instagram_id",
   *       "time": 1234567890,
   *       "changes": [
   *         {
   *           "field": "comments" | "messages" | etc,
   *           "value": { ... event data ... }
   *         }
   *       ]
   *     }
   *   ]
   * }
   */
  private async processMetaWebhook(
    payload: any,
    source: 'instagram' | 'facebook',
  ): Promise<void> {
    const objectType = payload.object;
    const entries = payload.entry || [];

    for (const entry of entries) {
      const accountId = entry.id;
      const changes = entry.changes || [];

      for (const change of changes) {
        const field = change.field;
        const value = change.value;

        this.logger.log(
          `${source} webhook - Account: ${accountId}, Field: ${field}`,
        );

        // Handle different event types
        switch (field) {
          case 'comments':
            await this.handleCommentEvent(accountId, value);
            break;
          case 'messages':
            await this.handleMessageEvent(accountId, value);
            break;
          case 'mentions':
            await this.handleMentionEvent(accountId, value);
            break;
          case 'story_insights':
            await this.handleStoryInsightsEvent(accountId, value);
            break;
          default:
            this.logger.log(`Unhandled webhook field: ${field}`);
        }
      }
    }
  }

  private async handleCommentEvent(accountId: string, data: any): Promise<void> {
    this.logger.log(`New comment on account ${accountId}: ${JSON.stringify(data)}`);
    // TODO: Implement comment handling logic
    // - Store in database
    // - Notify user
    // - Auto-reply if configured
  }

  private async handleMessageEvent(accountId: string, data: any): Promise<void> {
    this.logger.log(`New message on account ${accountId}: ${JSON.stringify(data)}`);
    // TODO: Implement message handling logic
  }

  private async handleMentionEvent(accountId: string, data: any): Promise<void> {
    this.logger.log(`New mention on account ${accountId}: ${JSON.stringify(data)}`);
    // TODO: Implement mention handling logic
  }

  private async handleStoryInsightsEvent(
    accountId: string,
    data: any,
  ): Promise<void> {
    this.logger.log(`Story insights for account ${accountId}: ${JSON.stringify(data)}`);
    // TODO: Implement story insights handling logic
  }
}
