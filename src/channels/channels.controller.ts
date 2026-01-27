import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
  Res,
  BadRequestException,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ChannelService } from './services/channel.service';
import { OAuthService } from './services/oauth.service';
import { FacebookService } from './services/facebook.service';
import { PinterestService } from './services/pinterest.service';
import { YouTubeService } from './services/youtube.service';
import { LinkedInService } from './services/linkedin.service';
import { TikTokService } from './services/tiktok.service';
import { TwitterService } from './services/twitter.service';
import { InstagramService } from './services/instagram.service';
import { ThreadsService } from './services/threads.service';
import { BlueskyService } from './services/bluesky.service';
import { MastodonService } from './services/mastodon.service';
import { GoogleDriveService } from './services/google-drive.service';
import { GooglePhotosService } from './services/google-photos.service';
import { GoogleCalendarService } from './services/google-calendar.service';
import { OneDriveService } from './services/onedrive.service';
import { DropboxService } from './services/dropbox.service';
import {
  InitiateOAuthDto,
  CreateChannelDto,
  UpdateChannelDto,
  ReorderChannelsDto,
  ChannelQueryDto,
  FetchPagesDto,
  ConnectFacebookPageDto,
  CreatePinterestBoardDto,
  CreatePinterestPinDto,
  UploadYouTubeVideoDto,
  CreateLinkedInPostDto,
  PostTikTokVideoDto,
} from './dto/channel.dto';
import { SupportedPlatform, PLATFORM_CONFIG, oauthStates } from '../drizzle/schema/channels.schema';
import { db } from '../drizzle/db';
import { eq, and, isNull, gt } from 'drizzle-orm';
import * as crypto from 'crypto';

@Controller('channels')
export class ChannelsController {
  constructor(
    private readonly channelService: ChannelService,
    private readonly oauthService: OAuthService,
    private readonly facebookService: FacebookService,
    private readonly pinterestService: PinterestService,
    private readonly youtubeService: YouTubeService,
    private readonly linkedinService: LinkedInService,
    private readonly tiktokService: TikTokService,
    private readonly twitterService: TwitterService,
    private readonly instagramService: InstagramService,
    private readonly threadsService: ThreadsService,
    private readonly blueskyService: BlueskyService,
    private readonly mastodonService: MastodonService,
    private readonly googleDriveService: GoogleDriveService,
    private readonly googlePhotosService: GooglePhotosService,
    private readonly googleCalendarService: GoogleCalendarService,
    private readonly oneDriveService: OneDriveService,
    private readonly dropboxService: DropboxService,
  ) {}

  // ==========================================================================
  // OAuth Flow Endpoints
  // ==========================================================================

  /**
   * Initiate OAuth flow - returns authorization URL
   */
  @Post('workspaces/:workspaceId/oauth/initiate')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async initiateOAuth(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: { userId: string; email: string },
    @Body() dto: InitiateOAuthDto,
  ) {
    return await this.oauthService.initiateOAuth(workspaceId, user.userId, dto);
  }

  /**
   * OAuth connect error page (temporary - for debugging)
   */
  @Get('connect/error')
  async oauthConnectError(
    @Query('error') error: string,
    @Query('description') description: string,
    @Res() res: Response,
  ) {
    res.setHeader('Content-Type', 'text/html');
    return res.send(`
      <!DOCTYPE html>
      <html>
        <head><title>OAuth Error</title></head>
        <body style="font-family: Arial, sans-serif; padding: 40px; text-align: center;">
          <h1 style="color: #dc3545;">❌ OAuth Connection Failed</h1>
          <p><strong>Error:</strong> ${error || 'Unknown error'}</p>
          ${description ? `<p><strong>Description:</strong> ${description}</p>` : ''}
          <p style="margin-top: 30px;">
            <a href="javascript:window.close()">Close this window</a>
          </p>
        </body>
      </html>
    `);
  }

  /**
   * OAuth connect success page (temporary - for debugging)
   */
  @Get('connect/success')
  async oauthConnectSuccess(
    @Query('platform') platform: string,
    @Query('workspaceId') workspaceId: string,
    @Query('accessToken') accessToken: string,
    @Query('refreshToken') refreshToken: string,
    @Query('expiresAt') expiresAt: string,
    @Res() res: Response,
  ) {
    res.setHeader('Content-Type', 'text/html');
    return res.send(`
      <!DOCTYPE html>
      <html>
        <head><title>OAuth Success</title></head>
        <body style="font-family: Arial, sans-serif; padding: 40px; text-align: center;">
          <h1 style="color: #28a745;">✅ OAuth Connection Successful</h1>
          <p><strong>Platform:</strong> ${platform}</p>
          <p><strong>Workspace ID:</strong> ${workspaceId}</p>
          <p><strong>Access Token:</strong> ${accessToken ? accessToken.substring(0, 20) + '...' : 'N/A'}</p>
          <p><strong>Refresh Token:</strong> ${refreshToken ? 'Yes' : 'No'}</p>
          <p><strong>Expires At:</strong> ${expiresAt || 'N/A'}</p>
          <hr style="margin: 30px 0;" />
          <p>Now use the <code>/channels/workspaces/{workspaceId}/{platform}/connect</code> endpoint with the access token to complete the connection.</p>
          <p style="margin-top: 30px;">
            <a href="javascript:window.close()">Close this window</a>
          </p>
        </body>
      </html>
    `);
  }

  /**
   * OAuth callback - exchange code for tokens and create channel
   */
  @Get('oauth/:platform/callback')
  async oauthCallback(
    @Param('platform') platform: string,
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error: string,
    @Query('error_description') errorDescription: string,
    @Query('error_code') errorCode: string,
    @Query('error_message') errorMessage: string,
    @Query() allQuery: Record<string, string>,
    @Res() res: Response,
  ) {
    // Delegate to platform-specific callbacks for platforms with custom OAuth flows
    if (platform === 'mastodon') {
      return this.mastodonOAuthCallback(code, state, res);
    }

    // Get frontend URL for redirect (use backend URL for debug pages)
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const backendUrl = process.env.APP_URL || 'http://localhost:3001';

    // Log incoming callback for debugging
    console.log(`[OAuth Callback] Platform: ${platform}`);
    console.log(`[OAuth Callback] ALL Query params: ${JSON.stringify(allQuery)}`);
    console.log(`[OAuth Callback] State token received: ${state ? state.substring(0, 10) + '...' : 'MISSING'}`);
    console.log(`[OAuth Callback] Code received: ${code ? 'YES' : 'NO'}`);
    console.log(`[OAuth Callback] Error: ${error || 'none'}`);

    try {
      // Check for OAuth error (standard format)
      if (error) {
        const errorUrl = `${frontendUrl}/channels/connect/error?error=${encodeURIComponent(error)}&description=${encodeURIComponent(errorDescription || '')}`;
        return res.redirect(errorUrl);
      }

      // Check for Facebook-specific error format (error_code, error_message)
      if (errorCode || errorMessage) {
        console.log(`[OAuth Callback] Facebook error: code=${errorCode}, message=${errorMessage}`);
        const errorUrl = `${frontendUrl}/channels/connect/error?error=${encodeURIComponent(errorCode || 'facebook_error')}&description=${encodeURIComponent(errorMessage || 'Unknown Facebook error')}`;
        return res.redirect(errorUrl);
      }

      // Check if state is missing
      if (!state) {
        console.log('[OAuth Callback] ERROR: State token is missing from callback');
        const errorUrl = `${frontendUrl}/channels/connect/error?error=${encodeURIComponent('State token missing')}&description=${encodeURIComponent('The platform did not return the state parameter. This may be a configuration issue.')}`;
        return res.redirect(errorUrl);
      }

      // Validate state and get stored data
      console.log(`[OAuth Callback] Validating state token...`);
      const stateData = await this.oauthService.validateState(state);
      console.log(`[OAuth Callback] State validated successfully for workspace: ${stateData.workspaceId}`);

      // Get the stored redirect_uri to ensure exact match during token exchange
      const storedRedirectUri = stateData.additionalData?._oauthRedirectUri as string | undefined;
      console.log(`[OAuth Callback] Stored redirect_uri: ${storedRedirectUri || 'NOT FOUND'}`);

      // Exchange code for tokens
      const tokens = await this.oauthService.exchangeCodeForTokens(
        platform as SupportedPlatform,
        code,
        stateData.codeVerifier,
        storedRedirectUri,
      );

      // Calculate token expiration
      let tokenExpiresAt: Date | null = null;
      if (tokens.expiresIn) {
        tokenExpiresAt = new Date();
        tokenExpiresAt.setSeconds(tokenExpiresAt.getSeconds() + tokens.expiresIn);
      }

      // Special handling for Twitter: auto-create channel and chain to OAuth 1.0a
      if (platform === 'twitter') {
        try {
          console.log('[OAuth Callback] Twitter: Auto-creating channel and initiating OAuth 1.0a...');

          // Get Twitter user profile
          const twitterUser = await this.twitterService.getCurrentUser(tokens.accessToken);

          // Create the Twitter channel automatically
          const channel = await this.channelService.createChannel(
            stateData.workspaceId,
            stateData.userId,
            {
              platform: 'twitter',
              accountType: 'profile',
              platformAccountId: twitterUser.id,
              accountName: twitterUser.name,
              username: twitterUser.username || undefined,
              profilePictureUrl: twitterUser.profileImageUrl || undefined,
              accessToken: tokens.accessToken,
              refreshToken: tokens.refreshToken || undefined,
              tokenExpiresAt: tokenExpiresAt?.toISOString(),
              permissions: PLATFORM_CONFIG.twitter.oauthScopes,
              capabilities: {
                canPost: true,
                canSchedule: true,
                canReadAnalytics: true,
                canReply: true,
                canDelete: true,
                supportedMediaTypes: ['text', 'image', 'video', 'gif'],
                maxMediaPerPost: 4,
                maxTextLength: 280,
              },
              metadata: {
                description: twitterUser.description,
                verified: twitterUser.verified,
                verifiedType: twitterUser.verifiedType,
                followersCount: twitterUser.publicMetrics.followersCount,
                followingCount: twitterUser.publicMetrics.followingCount,
                tweetCount: twitterUser.publicMetrics.tweetCount,
                createdAt: twitterUser.createdAt,
              },
            },
          );

          console.log(`[OAuth Callback] Twitter channel created: ${channel.id}`);

          // Initiate OAuth 1.0a for media upload support
          const oauth1CallbackUrl = `${backendUrl}/channels/oauth/twitter/oauth1/callback`;
          const oauth1Result = await this.twitterService.getOAuth1RequestToken(oauth1CallbackUrl);

          // Store OAuth 1.0a state with channel ID
          await this.channelService.createOAuthState(
            stateData.workspaceId,
            stateData.userId,
            'twitter',
            oauth1Result.oauthToken,
            oauth1CallbackUrl,
            oauth1Result.oauthTokenSecret,
            { channelId: channel.id.toString() },
          );

          console.log('[OAuth Callback] Twitter: Redirecting to OAuth 1.0a authorization...');

          // Redirect directly to Twitter OAuth 1.0a authorization
          return res.redirect(oauth1Result.authorizationUrl);
        } catch (twitterError) {
          console.error('[OAuth Callback] Twitter auto-setup failed:', twitterError);
          // Fall through to normal flow if Twitter-specific handling fails
          const errorUrl = `${frontendUrl}/channels/connect/error?error=${encodeURIComponent('Twitter setup failed: ' + (twitterError instanceof Error ? twitterError.message : 'Unknown error'))}`;
          return res.redirect(errorUrl);
        }
      }

      // Instagram Business Login: Auto-create channel
      if (platform === 'instagram') {
        try {
          console.log('[OAuth Callback] Instagram Business Login: Auto-creating channel...');

          // Instagram Business Login returns short-lived token (1 hour)
          // Exchange for long-lived token (60 days)
          const longLivedTokenData = await this.instagramService.exchangeForLongLivedToken(tokens.accessToken);
          const longLivedAccessToken = longLivedTokenData.accessToken;

          // Calculate expiration for long-lived token
          const longLivedExpiresAt = new Date();
          longLivedExpiresAt.setSeconds(longLivedExpiresAt.getSeconds() + longLivedTokenData.expiresIn);

          // Get Instagram user profile using the long-lived token
          const instagramUser = await this.instagramService.getAccountInfoWithUserToken(longLivedAccessToken);

          // Create the Instagram channel automatically
          const channel = await this.channelService.createChannel(
            stateData.workspaceId,
            stateData.userId,
            {
              platform: 'instagram',
              accountType: 'business_account',
              platformAccountId: instagramUser.id,
              accountName: instagramUser.name,
              username: instagramUser.username,
              profilePictureUrl: instagramUser.profilePictureUrl || undefined,
              accessToken: longLivedAccessToken,
              tokenExpiresAt: longLivedExpiresAt.toISOString(),
              permissions: PLATFORM_CONFIG.instagram.oauthScopes,
              capabilities: {
                canPost: true,
                canSchedule: true,
                canReadAnalytics: true,
                canReply: true,
                canDelete: false, // Instagram API doesn't support delete
                supportedMediaTypes: ['image', 'video', 'carousel'],
                maxMediaPerPost: 10,
                maxTextLength: 2200,
              },
              metadata: {
                biography: instagramUser.biography,
                followersCount: instagramUser.followersCount,
                followsCount: instagramUser.followsCount,
                mediaCount: instagramUser.mediaCount,
                tokenType: 'instagram_business_login',
              },
            },
          );

          console.log(`[OAuth Callback] Instagram channel created: ${channel.id}`);

          // Redirect to frontend success page
          const successUrl = `${frontendUrl}/channels/connect/success?platform=instagram&channelId=${channel.id}`;
          return res.redirect(successUrl);
        } catch (igError) {
          console.error('[OAuth Callback] Instagram setup failed:', igError);
          const errorUrl = `${frontendUrl}/channels/connect/error?error=${encodeURIComponent('Instagram setup failed: ' + (igError instanceof Error ? igError.message : 'Unknown error'))}`;
          return res.redirect(errorUrl);
        }
      }

      // Threads: Auto-create channel
      if (platform === 'threads') {
        try {
          console.log('[OAuth Callback] Threads: Auto-creating channel...');

          // Get Threads user profile
          const threadsUser = await this.threadsService.getUserProfile(tokens.accessToken);

          // Create the Threads channel automatically
          const channel = await this.channelService.createChannel(
            stateData.workspaceId,
            stateData.userId,
            {
              platform: 'threads',
              accountType: 'profile',
              platformAccountId: threadsUser.id,
              accountName: threadsUser.name || threadsUser.username,
              username: threadsUser.username,
              profilePictureUrl: threadsUser.profilePictureUrl || undefined,
              accessToken: tokens.accessToken,
              refreshToken: tokens.refreshToken || undefined,
              tokenExpiresAt: tokenExpiresAt?.toISOString(),
              permissions: PLATFORM_CONFIG.threads.oauthScopes,
              capabilities: {
                canPost: true,
                canSchedule: true,
                canReadAnalytics: true,
                canReply: true,
                canDelete: true,
                supportedMediaTypes: ['text', 'image', 'video'],
                maxMediaPerPost: 10,
                maxTextLength: 500,
              },
              metadata: {
                biography: threadsUser.biography,
                threadsProfileUrl: threadsUser.threadsProfileUrl,
              },
            },
          );

          console.log(`[OAuth Callback] Threads channel created: ${channel.id}`);

          // Redirect to frontend success page
          const successUrl = `${frontendUrl}/channels/connect/success?platform=threads&channelId=${channel.id}`;
          return res.redirect(successUrl);
        } catch (threadsError) {
          console.error('[OAuth Callback] Threads setup failed:', threadsError);
          const errorUrl = `${frontendUrl}/channels/connect/error?error=${encodeURIComponent('Threads setup failed: ' + (threadsError instanceof Error ? threadsError.message : 'Unknown error'))}`;
          return res.redirect(errorUrl);
        }
      }

      // TikTok: Auto-create channel to ensure refresh token is saved
      if (platform === 'tiktok') {
        try {
          console.log('[OAuth Callback] TikTok: Auto-creating channel...');
          console.log(`[OAuth Callback] TikTok tokens - accessToken: ${tokens.accessToken ? 'YES' : 'NO'}, refreshToken: ${tokens.refreshToken ? 'YES' : 'NO'}, expiresIn: ${tokens.expiresIn}`);

          // Get TikTok user profile
          const tiktokUser = await this.tiktokService.getCurrentUser(tokens.accessToken);

          // Create the TikTok channel automatically
          const channel = await this.channelService.createChannel(
            stateData.workspaceId,
            stateData.userId,
            {
              platform: 'tiktok',
              accountType: 'business_account',
              platformAccountId: tiktokUser.id,
              accountName: tiktokUser.displayName || tiktokUser.username,
              username: tiktokUser.username || undefined,
              profilePictureUrl: tiktokUser.avatarUrl || undefined,
              accessToken: tokens.accessToken,
              refreshToken: tokens.refreshToken || undefined,
              tokenExpiresAt: tokenExpiresAt?.toISOString(),
              permissions: PLATFORM_CONFIG.tiktok.oauthScopes,
              capabilities: {
                canPost: true,
                canSchedule: true,
                canReadAnalytics: true,
                canReply: false,
                canDelete: false,
                supportedMediaTypes: ['video'],
                maxMediaPerPost: 1,
                maxTextLength: 2200,
              },
              metadata: {
                followerCount: tiktokUser.followerCount,
                followingCount: tiktokUser.followingCount,
                likesCount: tiktokUser.likesCount,
                videoCount: tiktokUser.videoCount,
                isVerified: tiktokUser.isVerified,
              },
            },
          );

          console.log(`[OAuth Callback] TikTok channel created: ${channel.id}`);

          // Redirect to frontend success page
          const successUrl = `${frontendUrl}/channels/connect/success?platform=tiktok&channelId=${channel.id}`;
          return res.redirect(successUrl);
        } catch (tiktokError) {
          console.error('[OAuth Callback] TikTok setup failed:', tiktokError);
          const errorUrl = `${frontendUrl}/channels/connect/error?error=${encodeURIComponent('TikTok setup failed: ' + (tiktokError instanceof Error ? tiktokError.message : 'Unknown error'))}`;
          return res.redirect(errorUrl);
        }
      }

      // Default flow for other platforms: Redirect to frontend with success and tokens
      // Frontend will fetch account info and complete the channel creation
      const successUrl = new URL(`${frontendUrl}/channels/connect/success`);
      successUrl.searchParams.set('platform', platform);
      successUrl.searchParams.set('workspaceId', stateData.workspaceId);
      successUrl.searchParams.set('accessToken', tokens.accessToken);
      if (tokens.refreshToken) {
        successUrl.searchParams.set('refreshToken', tokens.refreshToken);
      }
      if (tokenExpiresAt) {
        successUrl.searchParams.set('expiresAt', tokenExpiresAt.toISOString());
      }

      return res.redirect(successUrl.toString());
    } catch (err) {
      console.log(`[OAuth Callback] ERROR: ${err.message || 'Unknown error'}`);
      console.log(`[OAuth Callback] Full error:`, err);
      const errorUrl = `${frontendUrl}/channels/connect/error?error=${encodeURIComponent(err.message || 'Unknown error')}&description=${encodeURIComponent('State token: ' + (state ? state.substring(0, 10) + '...' : 'missing'))}`;
      return res.redirect(errorUrl);
    }
  }

  /**
   * Complete channel connection after OAuth (called by frontend with account data)
   */
  @Post('workspaces/:workspaceId/complete-oauth')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async completeOAuth(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: { userId: string; email: string },
    @Body() dto: CreateChannelDto,
  ) {
    return await this.channelService.createChannel(workspaceId, user.userId, dto);
  }

  // ==========================================================================
  // Channel CRUD Endpoints
  // ==========================================================================

  /**
   * Get all channels for a workspace
   */
  @Get('workspaces/:workspaceId')
  @UseGuards(JwtAuthGuard)
  async getWorkspaceChannels(
    @Param('workspaceId') workspaceId: string,
    @Query() query: ChannelQueryDto,
  ) {
    return await this.channelService.getWorkspaceChannels(workspaceId, query);
  }

  /**
   * Get a single channel
   */
  @Get('workspaces/:workspaceId/:channelId')
  @UseGuards(JwtAuthGuard)
  async getChannel(
    @Param('workspaceId') workspaceId: string,
    @Param('channelId') channelId: string,
  ) {
    return await this.channelService.getChannelById(
      parseInt(channelId, 10),
      workspaceId,
    );
  }

  /**
   * Update a channel
   */
  @Put('workspaces/:workspaceId/:channelId')
  @UseGuards(JwtAuthGuard)
  async updateChannel(
    @Param('workspaceId') workspaceId: string,
    @Param('channelId') channelId: string,
    @Body() dto: UpdateChannelDto,
  ) {
    return await this.channelService.updateChannel(
      parseInt(channelId, 10),
      workspaceId,
      dto,
    );
  }

  /**
   * Delete a channel (disconnect)
   */
  @Delete('workspaces/:workspaceId/:channelId')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteChannel(
    @Param('workspaceId') workspaceId: string,
    @Param('channelId') channelId: string,
  ) {
    await this.channelService.deleteChannel(
      parseInt(channelId, 10),
      workspaceId,
    );
  }

  /**
   * Reorder channels
   */
  @Put('workspaces/:workspaceId/reorder')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async reorderChannels(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: ReorderChannelsDto,
  ) {
    await this.channelService.reorderChannels(workspaceId, dto.channelIds);
    return { message: 'Channels reordered successfully' };
  }

  // ==========================================================================
  // Token Management Endpoints
  // ==========================================================================

  /**
   * Refresh tokens for a channel
   */
  @Post('workspaces/:workspaceId/:channelId/refresh-token')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async refreshToken(
    @Param('workspaceId') workspaceId: string,
    @Param('channelId') channelId: string,
  ) {
    const channel = await this.channelService.getChannelById(
      parseInt(channelId, 10),
      workspaceId,
    );

    const refreshToken = await this.channelService.getRefreshToken(
      parseInt(channelId, 10),
      workspaceId,
    );

    if (!refreshToken) {
      throw new Error('No refresh token available for this channel');
    }

    const tokens = await this.oauthService.refreshAccessToken(
      channel.platform as SupportedPlatform,
      refreshToken,
    );

    let tokenExpiresAt: string | undefined;
    if (tokens.expiresIn) {
      const expiresDate = new Date();
      expiresDate.setSeconds(expiresDate.getSeconds() + tokens.expiresIn);
      tokenExpiresAt = expiresDate.toISOString();
    }

    await this.channelService.updateTokens(
      parseInt(channelId, 10),
      workspaceId,
      {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken || undefined,
        tokenExpiresAt,
      },
    );

    return { message: 'Token refreshed successfully' };
  }

  /**
   * Reconnect a channel (initiate new OAuth flow)
   */
  @Post('workspaces/:workspaceId/:channelId/reconnect')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async reconnectChannel(
    @Param('workspaceId') workspaceId: string,
    @Param('channelId') channelId: string,
    @CurrentUser() user: { userId: string; email: string },
  ) {
    const channel = await this.channelService.getChannelById(
      parseInt(channelId, 10),
      workspaceId,
    );

    return await this.oauthService.initiateOAuth(workspaceId, user.userId, {
      platform: channel.platform as SupportedPlatform,
      additionalData: { reconnectChannelId: channelId },
    });
  }

  // ==========================================================================
  // Statistics Endpoints
  // ==========================================================================

  /**
   * Get channel statistics for a workspace
   */
  @Get('workspaces/:workspaceId/stats')
  @UseGuards(JwtAuthGuard)
  async getChannelStats(@Param('workspaceId') workspaceId: string) {
    return await this.channelService.getChannelStats(workspaceId);
  }

  /**
   * Get channels with expiring tokens
   */
  @Get('workspaces/:workspaceId/expiring')
  @UseGuards(JwtAuthGuard)
  async getExpiringChannels(
    @Param('workspaceId') workspaceId: string,
    @Query('days') days?: string,
  ) {
    const allExpiring = await this.channelService.getExpiringChannels(
      days ? parseInt(days, 10) : 7,
    );

    // Filter to only this workspace
    return allExpiring.filter((ch) => ch.workspaceId === workspaceId);
  }

  // ==========================================================================
  // Facebook/Instagram Specific Endpoints
  // ==========================================================================

  /**
   * Get Facebook Pages the user manages (after OAuth)
   * Returns pages with their Page Access Tokens and connected Instagram accounts
   */
  @Post('facebook/pages')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async getFacebookPages(@Body() dto: FetchPagesDto) {
    const pages = await this.facebookService.getUserPages(dto.accessToken);

    return pages.map((page) => ({
      id: page.id,
      name: page.name,
      category: page.category,
      pictureUrl: page.pictureUrl,
      username: page.username,
      followersCount: page.followersCount,
      fanCount: page.fanCount,
      hasInstagram: !!page.instagramBusinessAccount,
      instagramAccount: page.instagramBusinessAccount
        ? {
            id: page.instagramBusinessAccount.id,
            username: page.instagramBusinessAccount.username,
            name: page.instagramBusinessAccount.name,
            profilePictureUrl: page.instagramBusinessAccount.profilePictureUrl,
            followersCount: page.instagramBusinessAccount.followersCount,
          }
        : null,
    }));
  }

  /**
   * Debug endpoint to check token permissions
   * This helps diagnose why /me/accounts returns empty
   */
  @Post('facebook/debug-token')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async debugFacebookToken(@Body() dto: FetchPagesDto) {
    const graphApiUrl = 'https://graph.facebook.com/v18.0';

    // Get token debug info
    const debugUrl = new URL(`${graphApiUrl}/debug_token`);
    debugUrl.searchParams.set('input_token', dto.accessToken);
    debugUrl.searchParams.set('access_token', dto.accessToken);

    const debugResponse = await fetch(debugUrl.toString());
    const debugData = await debugResponse.json();

    // Get user info
    const meUrl = new URL(`${graphApiUrl}/me`);
    meUrl.searchParams.set('access_token', dto.accessToken);
    meUrl.searchParams.set('fields', 'id,name,email');

    const meResponse = await fetch(meUrl.toString());
    const meData = await meResponse.json();

    // Try /me/accounts with more logging
    const accountsUrl = new URL(`${graphApiUrl}/me/accounts`);
    accountsUrl.searchParams.set('access_token', dto.accessToken);
    accountsUrl.searchParams.set('fields', 'id,name,access_token');

    const accountsResponse = await fetch(accountsUrl.toString());
    const accountsData = await accountsResponse.json();

    return {
      tokenInfo: debugData.data || debugData,
      userInfo: meData,
      pagesResponse: accountsData,
      scopes: debugData.data?.scopes || [],
      hint: accountsData.data?.length === 0
        ? 'Empty pages array. You need to add yourself as a Test User in Meta App Dashboard -> App Roles -> Roles'
        : null,
    };
  }

  /**
   * Connect a Facebook Page as a channel
   * Automatically creates the channel with the Page Access Token
   */
  @Post('workspaces/:workspaceId/facebook/connect-page')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async connectFacebookPage(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: { userId: string; email: string },
    @Body() dto: ConnectFacebookPageDto,
  ) {
    // Get page details with Page Access Token
    const page = await this.facebookService.getPage(
      dto.pageId,
      dto.userAccessToken,
    );

    if (!page) {
      throw new Error('Failed to fetch page details');
    }

    // Create the Facebook Page channel
    const fbChannel = await this.channelService.createChannel(
      workspaceId,
      user.userId,
      {
        platform: 'facebook',
        accountType: 'page',
        platformAccountId: page.id,
        accountName: page.name,
        username: page.username || undefined,
        profilePictureUrl: page.pictureUrl || undefined,
        accessToken: page.accessToken, // Page Access Token (never expires)
        tokenExpiresAt: undefined, // Page tokens don't expire
        permissions: PLATFORM_CONFIG.facebook.oauthScopes,
        capabilities: {
          canPost: true,
          canSchedule: true,
          canReadAnalytics: true,
          canReply: true,
          canDelete: true,
          supportedMediaTypes: ['image', 'video', 'link'],
          maxMediaPerPost: 10,
          maxTextLength: 63206,
        },
        metadata: {
          category: page.category,
          followersCount: page.followersCount,
          fanCount: page.fanCount,
        },
      },
    );

    let igChannel: Awaited<ReturnType<typeof this.channelService.createChannel>> | null = null;

    // If Instagram is connected and user wants it, create Instagram channel too
    if (dto.includeInstagram && page.instagramBusinessAccount) {
      const ig = page.instagramBusinessAccount;

      igChannel = await this.channelService.createChannel(
        workspaceId,
        user.userId,
        {
          platform: 'instagram',
          accountType: 'business_account',
          platformAccountId: ig.id,
          accountName: ig.name,
          username: ig.username,
          profilePictureUrl: ig.profilePictureUrl || undefined,
          accessToken: page.accessToken, // Uses same Page Access Token
          tokenExpiresAt: undefined,
          permissions: PLATFORM_CONFIG.instagram.oauthScopes,
          capabilities: {
            canPost: true,
            canSchedule: true,
            canReadAnalytics: true,
            canReply: true,
            canDelete: false, // Instagram doesn't allow delete via API
            supportedMediaTypes: ['image', 'video', 'carousel'],
            maxMediaPerPost: 10,
            maxTextLength: 2200,
          },
          metadata: {
            followersCount: ig.followersCount,
            mediaCount: ig.mediaCount,
            biography: ig.biography,
            linkedFacebookPageId: page.id,
          },
        },
      );
    }

    return {
      facebookChannel: fbChannel,
      instagramChannel: igChannel,
      message: igChannel
        ? 'Facebook Page and Instagram account connected successfully'
        : 'Facebook Page connected successfully',
    };
  }

  /**
   * Get current Facebook user info
   */
  @Post('facebook/me')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async getFacebookUser(@Body() dto: FetchPagesDto) {
    return await this.facebookService.getCurrentUser(dto.accessToken);
  }

  // ==========================================================================
  // Pinterest Specific Endpoints
  // ==========================================================================

  /**
   * Get Pinterest user info and connect as channel
   */
  @Post('workspaces/:workspaceId/pinterest/connect')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async connectPinterest(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: { userId: string; email: string },
    @Body() dto: FetchPagesDto & { refreshToken?: string; tokenExpiresAt?: string },
  ) {
    // Get Pinterest user info
    const pinterestUser = await this.pinterestService.getCurrentUser(dto.accessToken);

    // Create the Pinterest channel
    const channel = await this.channelService.createChannel(
      workspaceId,
      user.userId,
      {
        platform: 'pinterest',
        accountType: pinterestUser.accountType === 'BUSINESS' ? 'business_account' : 'profile',
        platformAccountId: pinterestUser.id,
        accountName: pinterestUser.businessName || pinterestUser.username,
        username: pinterestUser.username,
        profilePictureUrl: pinterestUser.profileImage || undefined,
        accessToken: dto.accessToken,
        refreshToken: dto.refreshToken,
        tokenExpiresAt: dto.tokenExpiresAt,
        permissions: PLATFORM_CONFIG.pinterest.oauthScopes,
        capabilities: {
          canPost: true,
          canSchedule: true,
          canReadAnalytics: true,
          canReply: false,
          canDelete: true,
          supportedMediaTypes: ['image', 'video'],
          maxMediaPerPost: 1,
          maxTextLength: 500,
        },
        metadata: {
          followerCount: pinterestUser.followerCount,
          followingCount: pinterestUser.followingCount,
          monthlyViews: pinterestUser.monthlyViews,
          websiteUrl: pinterestUser.websiteUrl,
        },
      },
    );

    return {
      channel,
      message: 'Pinterest account connected successfully',
    };
  }

  /**
   * Get Pinterest user info
   */
  @Post('pinterest/me')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async getPinterestUser(@Body() dto: FetchPagesDto) {
    return await this.pinterestService.getCurrentUser(dto.accessToken);
  }

  /**
   * Get Pinterest boards
   */
  @Post('pinterest/boards')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async getPinterestBoards(@Body() dto: FetchPagesDto) {
    return await this.pinterestService.getUserBoards(dto.accessToken);
  }

  /**
   * Create a new Pinterest board
   */
  @Post('workspaces/:workspaceId/:channelId/pinterest/boards')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async createPinterestBoard(
    @Param('workspaceId') workspaceId: string,
    @Param('channelId') channelId: string,
    @Body() dto: CreatePinterestBoardDto,
  ) {
    const accessToken = await this.channelService.getAccessToken(
      parseInt(channelId, 10),
      workspaceId,
    );

    const board = await this.pinterestService.createBoard(
      accessToken,
      dto.name,
      dto.description,
      dto.privacy,
    );

    return {
      board,
      message: 'Board created successfully',
    };
  }

  /**
   * Create a pin on Pinterest (image or video)
   */
  @Post('workspaces/:workspaceId/:channelId/pinterest/pin')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async createPinterestPin(
    @Param('workspaceId') workspaceId: string,
    @Param('channelId') channelId: string,
    @Body() dto: CreatePinterestPinDto,
  ) {
    // Get the channel's access token
    const accessToken = await this.channelService.getAccessToken(
      parseInt(channelId, 10),
      workspaceId,
    );

    // Create the pin
    const result = await this.pinterestService.createPin(
      accessToken,
      dto.boardId,
      dto.title,
      dto.description || '',
      dto.mediaUrl,
      {
        link: dto.link,
        mediaType: dto.mediaType || 'image',
        videoCoverImageUrl: dto.videoCoverImageUrl,
      },
    );

    return {
      pinId: result.pinId,
      pinUrl: result.pinUrl,
      message: 'Pin created successfully',
    };
  }

  // ==========================================================================
  // YouTube Specific Endpoints
  // ==========================================================================

  /**
   * Get YouTube channel info and connect as channel
   */
  @Post('workspaces/:workspaceId/youtube/connect')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async connectYouTube(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: { userId: string; email: string },
    @Body() dto: FetchPagesDto & { refreshToken?: string; tokenExpiresAt?: string },
  ) {
    // Get YouTube channel info
    const youtubeChannel = await this.youtubeService.getCurrentChannel(dto.accessToken);

    // Create the YouTube channel
    const channel = await this.channelService.createChannel(
      workspaceId,
      user.userId,
      {
        platform: 'youtube',
        accountType: 'channel',
        platformAccountId: youtubeChannel.id,
        accountName: youtubeChannel.title,
        username: youtubeChannel.customUrl || undefined,
        profilePictureUrl: youtubeChannel.thumbnailUrl || undefined,
        accessToken: dto.accessToken,
        refreshToken: dto.refreshToken,
        tokenExpiresAt: dto.tokenExpiresAt,
        permissions: PLATFORM_CONFIG.youtube.oauthScopes,
        capabilities: {
          canPost: true,
          canSchedule: true,
          canReadAnalytics: true,
          canReply: true,
          canDelete: true,
          supportedMediaTypes: ['video'],
          maxMediaPerPost: 1,
          maxTextLength: 5000,
        },
        metadata: {
          description: youtubeChannel.description,
          subscriberCount: youtubeChannel.subscriberCount,
          videoCount: youtubeChannel.videoCount,
          viewCount: youtubeChannel.viewCount,
        },
      },
    );

    return {
      channel,
      message: 'YouTube channel connected successfully',
    };
  }

  /**
   * Get YouTube channel info
   */
  @Post('youtube/me')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async getYouTubeChannel(@Body() dto: FetchPagesDto) {
    return await this.youtubeService.getCurrentChannel(dto.accessToken);
  }

  /**
   * Get YouTube playlists
   */
  @Post('youtube/playlists')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async getYouTubePlaylists(@Body() dto: FetchPagesDto) {
    return await this.youtubeService.getPlaylists(dto.accessToken);
  }

  /**
   * Get YouTube video categories
   */
  @Post('youtube/categories')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async getYouTubeCategories(
    @Body() dto: FetchPagesDto,
    @Query('regionCode') regionCode?: string,
  ) {
    return await this.youtubeService.getCategories(dto.accessToken, regionCode || 'US');
  }

  /**
   * Upload a video to YouTube
   */
  @Post('workspaces/:workspaceId/:channelId/youtube/upload')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async uploadYouTubeVideo(
    @Param('workspaceId') workspaceId: string,
    @Param('channelId') channelId: string,
    @Body() dto: UploadYouTubeVideoDto,
  ) {
    // Get the channel's access token
    const accessToken = await this.channelService.getAccessToken(
      parseInt(channelId, 10),
      workspaceId,
    );

    // Upload the video
    const result = await this.youtubeService.uploadVideoFromUrl(
      accessToken,
      dto.videoUrl,
      {
        title: dto.title,
        description: dto.description,
        privacyStatus: dto.privacyStatus || 'private',
        tags: dto.tags,
        categoryId: dto.categoryId,
        playlistId: dto.playlistId,
        madeForKids: dto.madeForKids,
        thumbnailUrl: dto.thumbnailUrl,
      },
    );

    return {
      videoId: result.videoId,
      videoUrl: result.videoUrl,
      title: result.title,
      status: result.status,
      message: 'Video uploaded successfully',
    };
  }

  /**
   * Get video status after upload
   */
  @Post('workspaces/:workspaceId/:channelId/youtube/video/:videoId/status')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async getYouTubeVideoStatus(
    @Param('workspaceId') workspaceId: string,
    @Param('channelId') channelId: string,
    @Param('videoId') videoId: string,
  ) {
    const accessToken = await this.channelService.getAccessToken(
      parseInt(channelId, 10),
      workspaceId,
    );

    return await this.youtubeService.getVideoStatus(accessToken, videoId);
  }

  // ==========================================================================
  // LinkedIn Specific Endpoints
  // ==========================================================================

  /**
   * Get LinkedIn profile info and connect as channel
   */
  @Post('workspaces/:workspaceId/linkedin/connect')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async connectLinkedIn(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: { userId: string; email: string },
    @Body() dto: FetchPagesDto & { refreshToken?: string; tokenExpiresAt?: string },
  ) {
    // Get LinkedIn profile info
    const linkedinProfile = await this.linkedinService.getCurrentUser(dto.accessToken);

    // Create the LinkedIn channel
    const channel = await this.channelService.createChannel(
      workspaceId,
      user.userId,
      {
        platform: 'linkedin',
        accountType: 'profile',
        platformAccountId: linkedinProfile.id,
        accountName: linkedinProfile.fullName,
        username: linkedinProfile.vanityName || undefined,
        profilePictureUrl: linkedinProfile.profilePictureUrl || undefined,
        accessToken: dto.accessToken,
        refreshToken: dto.refreshToken,
        tokenExpiresAt: dto.tokenExpiresAt,
        permissions: PLATFORM_CONFIG.linkedin.oauthScopes,
        capabilities: {
          canPost: true,
          canSchedule: true,
          canReadAnalytics: false,
          canReply: false,
          canDelete: false,
          supportedMediaTypes: ['text', 'image', 'video', 'link'],
          maxMediaPerPost: 9,
          maxTextLength: 3000,
        },
        metadata: {
          email: linkedinProfile.email,
          firstName: linkedinProfile.firstName,
          lastName: linkedinProfile.lastName,
        },
      },
    );

    return {
      channel,
      message: 'LinkedIn profile connected successfully',
    };
  }

  /**
   * Get LinkedIn profile info
   */
  @Post('linkedin/me')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async getLinkedInProfile(@Body() dto: FetchPagesDto) {
    return await this.linkedinService.getCurrentUser(dto.accessToken);
  }

  /**
   * Get LinkedIn organizations (company pages) the user manages
   */
  @Post('linkedin/organizations')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async getLinkedInOrganizations(@Body() dto: FetchPagesDto) {
    return await this.linkedinService.getUserOrganizations(dto.accessToken);
  }

  /**
   * Create a LinkedIn post (text, image, video, or link)
   */
  @Post('workspaces/:workspaceId/:channelId/linkedin/post')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async createLinkedInPost(
    @Param('workspaceId') workspaceId: string,
    @Param('channelId') channelId: string,
    @Body() dto: CreateLinkedInPostDto,
  ) {
    // Get the channel info
    const channel = await this.channelService.getChannelById(
      parseInt(channelId, 10),
      workspaceId,
    );

    const accessToken = await this.channelService.getAccessToken(
      parseInt(channelId, 10),
      workspaceId,
    );

    const isOrganization = channel.accountType === 'organization' ||
      (channel.metadata as Record<string, any>)?.isOrganization;
    const visibility = dto.visibility || 'PUBLIC';

    let result: { postId: string };

    if (dto.mediaUrl && dto.mediaType === 'video') {
      // Video post
      if (isOrganization) {
        result = await this.linkedinService.createOrganizationPostWithVideo(
          accessToken,
          channel.platformAccountId,
          dto.text || '',
          dto.mediaUrl,
          dto.mediaTitle,
        );
      } else {
        result = await this.linkedinService.createPostWithVideo(
          accessToken,
          channel.platformAccountId,
          dto.text || '',
          dto.mediaUrl,
          dto.mediaTitle,
          visibility,
        );
      }
    } else if (dto.mediaUrl && dto.mediaType === 'image') {
      // Image post
      if (isOrganization) {
        result = await this.linkedinService.createOrganizationPostWithImage(
          accessToken,
          channel.platformAccountId,
          dto.text || '',
          dto.mediaUrl,
          dto.mediaTitle,
        );
      } else {
        result = await this.linkedinService.createPostWithImage(
          accessToken,
          channel.platformAccountId,
          dto.text || '',
          dto.mediaUrl,
          dto.mediaTitle,
          visibility,
        );
      }
    } else if (dto.linkUrl) {
      // Link/article post
      if (isOrganization) {
        result = await this.linkedinService.createOrganizationPostWithLink(
          accessToken,
          channel.platformAccountId,
          dto.text || '',
          dto.linkUrl,
          dto.linkTitle,
          dto.linkDescription,
        );
      } else {
        result = await this.linkedinService.createPostWithLink(
          accessToken,
          channel.platformAccountId,
          dto.text || '',
          dto.linkUrl,
          dto.linkTitle,
          dto.linkDescription,
          visibility,
        );
      }
    } else {
      // Text-only post
      if (isOrganization) {
        result = await this.linkedinService.createOrganizationPost(
          accessToken,
          channel.platformAccountId,
          dto.text || '',
        );
      } else {
        result = await this.linkedinService.createPost(
          accessToken,
          channel.platformAccountId,
          dto.text || '',
          visibility,
        );
      }
    }

    return {
      postId: result.postId,
      postUrl: `https://www.linkedin.com/feed/update/${result.postId}`,
      message: 'Post created successfully',
    };
  }

  // ==========================================================================
  // TikTok Specific Endpoints
  // ==========================================================================

  /**
   * Get TikTok profile info and connect as channel
   */
  @Post('workspaces/:workspaceId/tiktok/connect')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async connectTikTok(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: { userId: string; email: string },
    @Body() dto: FetchPagesDto & { refreshToken?: string; tokenExpiresAt?: string },
  ) {
    // Get TikTok profile info
    const tiktokUser = await this.tiktokService.getCurrentUser(dto.accessToken);

    // Create the TikTok channel
    const channel = await this.channelService.createChannel(
      workspaceId,
      user.userId,
      {
        platform: 'tiktok',
        accountType: 'business_account',
        platformAccountId: tiktokUser.id,
        accountName: tiktokUser.displayName || tiktokUser.username,
        username: tiktokUser.username || undefined,
        profilePictureUrl: tiktokUser.avatarUrl || undefined,
        accessToken: dto.accessToken,
        refreshToken: dto.refreshToken,
        tokenExpiresAt: dto.tokenExpiresAt,
        permissions: PLATFORM_CONFIG.tiktok.oauthScopes,
        capabilities: {
          canPost: true,
          canSchedule: true,
          canReadAnalytics: true,
          canReply: false,
          canDelete: false,
          supportedMediaTypes: ['video'],
          maxMediaPerPost: 1,
          maxTextLength: 2200,
        },
        metadata: {
          followerCount: tiktokUser.followerCount,
          followingCount: tiktokUser.followingCount,
          likesCount: tiktokUser.likesCount,
          videoCount: tiktokUser.videoCount,
          isVerified: tiktokUser.isVerified,
        },
      },
    );

    return {
      channel,
      message: 'TikTok account connected successfully',
    };
  }

  /**
   * Get TikTok profile info
   */
  @Post('tiktok/me')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async getTikTokProfile(@Body() dto: FetchPagesDto) {
    return await this.tiktokService.getCurrentUser(dto.accessToken);
  }

  /**
   * Get TikTok videos
   */
  @Post('tiktok/videos')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async getTikTokVideos(
    @Body() dto: FetchPagesDto,
    @Query('cursor') cursor?: string,
  ) {
    return await this.tiktokService.getUserVideos(dto.accessToken, 20, cursor);
  }

  /**
   * Get TikTok creator info (posting options available for the user)
   */
  @Post('tiktok/creator-info')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async getTikTokCreatorInfo(@Body() dto: FetchPagesDto) {
    return await this.tiktokService.queryCreatorInfo(dto.accessToken);
  }

  /**
   * Post a video to TikTok from a URL
   * TikTok will pull the video from the provided URL
   */
  @Post('workspaces/:workspaceId/:channelId/tiktok/post')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async postTikTokVideo(
    @Param('workspaceId') workspaceId: string,
    @Param('channelId') channelId: string,
    @Body() dto: PostTikTokVideoDto,
  ) {
    // Get the channel's access token
    const accessToken = await this.channelService.getAccessToken(
      parseInt(channelId, 10),
      workspaceId,
    );

    let result: { publishId: string };

    if (dto.useDirectUpload) {
      // Download and upload directly to TikTok (more reliable but slower)
      result = await this.tiktokService.uploadVideoFromUrl(
        accessToken,
        dto.videoUrl,
        {
          title: dto.title,
          privacyLevel: dto.privacyLevel || 'SELF_ONLY',
          disableDuet: dto.disableDuet,
          disableStitch: dto.disableStitch,
          disableComment: dto.disableComment,
          videoCoverTimestampMs: dto.videoCoverTimestampMs,
        },
      );
    } else {
      // Let TikTok pull from URL (faster but URL must be publicly accessible)
      result = await this.tiktokService.postVideoFromUrl(
        accessToken,
        dto.videoUrl,
        {
          title: dto.title,
          privacyLevel: dto.privacyLevel || 'SELF_ONLY',
          disableDuet: dto.disableDuet,
          disableStitch: dto.disableStitch,
          disableComment: dto.disableComment,
          videoCoverTimestampMs: dto.videoCoverTimestampMs,
        },
      );
    }

    return {
      publishId: result.publishId,
      message: 'Video upload initiated. Use the status endpoint to check progress.',
      statusEndpoint: `/channels/workspaces/${workspaceId}/${channelId}/tiktok/status/${result.publishId}`,
    };
  }

  /**
   * Get TikTok video publish status
   */
  @Get('workspaces/:workspaceId/:channelId/tiktok/status/:publishId')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async getTikTokPublishStatus(
    @Param('workspaceId') workspaceId: string,
    @Param('channelId') channelId: string,
    @Param('publishId') publishId: string,
  ) {
    const accessToken = await this.channelService.getAccessToken(
      parseInt(channelId, 10),
      workspaceId,
    );

    const status = await this.tiktokService.getPublishStatus(accessToken, publishId);

    return {
      publishId,
      status: status.status,
      videoId: status.videoId,
      failReason: status.failReason,
      videoUrl: status.videoId ? `https://www.tiktok.com/@/video/${status.videoId}` : null,
    };
  }

  /**
   * Wait for TikTok video publish to complete (polling)
   */
  @Post('workspaces/:workspaceId/:channelId/tiktok/wait/:publishId')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async waitForTikTokPublish(
    @Param('workspaceId') workspaceId: string,
    @Param('channelId') channelId: string,
    @Param('publishId') publishId: string,
    @Query('timeout') timeout?: string,
  ) {
    const accessToken = await this.channelService.getAccessToken(
      parseInt(channelId, 10),
      workspaceId,
    );

    const maxWaitMs = timeout ? parseInt(timeout, 10) * 1000 : 120000;
    const result = await this.tiktokService.waitForPublishComplete(
      accessToken,
      publishId,
      maxWaitMs,
    );

    return {
      publishId,
      status: result.status,
      videoId: result.videoId,
      failReason: result.failReason,
      videoUrl: result.videoId ? `https://www.tiktok.com/@/video/${result.videoId}` : null,
    };
  }

  // ==========================================================================
  // Twitter/X Specific Endpoints
  // ==========================================================================

  /**
   * Get Twitter profile info and connect as channel
   * Optionally initiates OAuth 1.0a flow for media upload support
   */
  @Post('workspaces/:workspaceId/twitter/connect')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async connectTwitter(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: { userId: string; email: string },
    @Body() dto: FetchPagesDto & { refreshToken?: string; tokenExpiresAt?: string; enableMediaUpload?: boolean },
  ) {
    // Get Twitter profile info
    const twitterUser = await this.twitterService.getCurrentUser(dto.accessToken);

    // Create the Twitter channel
    const channel = await this.channelService.createChannel(
      workspaceId,
      user.userId,
      {
        platform: 'twitter',
        accountType: 'profile',
        platformAccountId: twitterUser.id,
        accountName: twitterUser.name,
        username: twitterUser.username || undefined,
        profilePictureUrl: twitterUser.profileImageUrl || undefined,
        accessToken: dto.accessToken,
        refreshToken: dto.refreshToken,
        tokenExpiresAt: dto.tokenExpiresAt,
        permissions: PLATFORM_CONFIG.twitter.oauthScopes,
        capabilities: {
          canPost: true,
          canSchedule: true,
          canReadAnalytics: true,
          canReply: true,
          canDelete: true,
          supportedMediaTypes: ['text', 'image', 'video', 'gif'],
          maxMediaPerPost: 4,
          maxTextLength: 280,
        },
        metadata: {
          description: twitterUser.description,
          verified: twitterUser.verified,
          verifiedType: twitterUser.verifiedType,
          followersCount: twitterUser.publicMetrics.followersCount,
          followingCount: twitterUser.publicMetrics.followingCount,
          tweetCount: twitterUser.publicMetrics.tweetCount,
          createdAt: twitterUser.createdAt,
        },
      },
    );

    // If enableMediaUpload is true, initiate OAuth 1.0a flow for media uploads
    let oauth1AuthUrl: string | null = null;
    if (dto.enableMediaUpload !== false) {
      try {
        const appUrl = process.env.APP_URL || 'http://localhost:3001';
        const callbackUrl = `${appUrl}/channels/oauth/twitter/oauth1/callback`;

        const oauth1Result = await this.twitterService.getOAuth1RequestToken(callbackUrl);

        // Store the OAuth 1.0a state
        await this.channelService.createOAuthState(
          workspaceId,
          user.userId,
          'twitter',
          oauth1Result.oauthToken,
          callbackUrl,
          oauth1Result.oauthTokenSecret,
          { channelId: channel.id.toString() },
        );

        oauth1AuthUrl = oauth1Result.authorizationUrl;
      } catch (error) {
        console.error('Failed to initiate OAuth 1.0a for Twitter media uploads:', error);
        // Don't fail the whole connection, just skip OAuth 1.0a
      }
    }

    return {
      channel,
      message: oauth1AuthUrl
        ? 'Twitter account connected. Redirect to oauth1AuthUrl to enable media uploads.'
        : 'Twitter account connected successfully',
      oauth1AuthUrl,
      mediaUploadEnabled: !oauth1AuthUrl, // If no URL, media was either skipped or already set up
    };
  }

  /**
   * Get Twitter profile info
   */
  @Post('twitter/me')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async getTwitterProfile(@Body() dto: FetchPagesDto) {
    return await this.twitterService.getCurrentUser(dto.accessToken);
  }

  /**
   * Get Twitter user's tweets
   */
  @Post('twitter/tweets')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async getTwitterTweets(
    @Body() dto: FetchPagesDto & { userId: string },
    @Query('paginationToken') paginationToken?: string,
  ) {
    return await this.twitterService.getUserTweets(
      dto.accessToken,
      dto.userId,
      10,
      paginationToken,
    );
  }

  /**
   * Initiate Twitter OAuth 1.0a flow (for media upload support)
   * Returns an authorization URL to redirect the user to
   */
  @Post('workspaces/:workspaceId/:channelId/twitter/oauth1/initiate')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async initiateTwitterOAuth1(
    @Param('workspaceId') workspaceId: string,
    @Param('channelId') channelId: string,
    @CurrentUser() user: { userId: string; email: string },
  ) {
    // Use the backend callback URL (ngrok or production URL)
    const appUrl = process.env.APP_URL || 'http://localhost:3001';
    const callbackUrl = `${appUrl}/channels/oauth/twitter/oauth1/callback`;

    const result = await this.twitterService.getOAuth1RequestToken(callbackUrl);

    // Store the request token secret temporarily in oauth_states
    // Also store the channelId in additionalData so we can update the right channel
    await this.channelService.createOAuthState(
      workspaceId,
      user.userId,
      'twitter',
      result.oauthToken,
      callbackUrl,
      result.oauthTokenSecret, // Store as code verifier
      { channelId }, // Store channelId for the callback
    );

    return {
      oauthToken: result.oauthToken,
      authorizationUrl: result.authorizationUrl,
      message: 'Redirect user to authorizationUrl to authorize',
    };
  }

  /**
   * Twitter OAuth 1.0a callback - handles the redirect from Twitter
   */
  @Get('oauth/twitter/oauth1/callback')
  async twitterOAuth1Callback(
    @Query('oauth_token') oauthToken: string,
    @Query('oauth_verifier') oauthVerifier: string,
    @Query('denied') denied: string,
    @Res() res: Response,
  ) {
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

    try {
      // Check if user denied access
      if (denied) {
        return res.redirect(`${frontendUrl}/channels/connect/error?error=User%20denied%20Twitter%20access`);
      }

      if (!oauthToken || !oauthVerifier) {
        return res.redirect(`${frontendUrl}/channels/connect/error?error=Missing%20OAuth%20parameters`);
      }

      // Get the stored oauth state
      const oauthState = await this.channelService.getOAuthStateByToken(oauthToken);

      if (!oauthState) {
        return res.redirect(`${frontendUrl}/channels/connect/error?error=OAuth%20state%20not%20found%20or%20expired`);
      }

      // Exchange for access tokens
      const credentials = await this.twitterService.getOAuth1AccessToken(
        oauthToken,
        oauthState.codeVerifier || '',
        oauthVerifier,
      );

      // Get the channelId from stored state
      const additionalData = oauthState.additionalData as { channelId?: string } | null;
      const channelId = additionalData?.channelId;

      if (!channelId) {
        return res.redirect(`${frontendUrl}/channels/connect/error?error=Channel%20ID%20not%20found`);
      }

      // Update the channel's metadata with OAuth 1.0a tokens
      const channel = await this.channelService.getChannelById(
        parseInt(channelId, 10),
        oauthState.workspaceId,
      );

      if (!channel) {
        return res.redirect(`${frontendUrl}/channels/connect/error?error=Channel%20not%20found`);
      }

      const updatedMetadata = {
        ...(channel.metadata as Record<string, any> || {}),
        oauthToken: credentials.oauthToken,
        oauthTokenSecret: credentials.oauthTokenSecret,
      };

      await this.channelService.updateChannel(
        parseInt(channelId, 10),
        oauthState.workspaceId,
        { metadata: updatedMetadata },
      );

      // Mark the oauth state as used
      await this.channelService.markOAuthStateUsed(oauthToken);

      // Redirect to success page
      return res.redirect(`${frontendUrl}/channels/connect/success?platform=twitter&oauth1=true&channelId=${channelId}`);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      return res.redirect(`${frontendUrl}/channels/connect/error?error=${encodeURIComponent(errorMessage)}`);
    }
  }

  // ==========================================================================
  // Instagram Specific Endpoints
  // ==========================================================================

  /**
   * Connect Instagram Business Account (via Facebook Page)
   * Instagram Business accounts are connected through Facebook Pages
   */
  @Post('workspaces/:workspaceId/instagram/connect')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async connectInstagram(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: { userId: string; email: string },
    @Body()
    dto: {
      instagramAccountId: string;
      pageAccessToken: string;
    },
  ) {
    // Get Instagram account info
    const instagramUser = await this.instagramService.getAccountInfo(
      dto.instagramAccountId,
      dto.pageAccessToken,
    );

    // Create the Instagram channel
    const channel = await this.channelService.createChannel(
      workspaceId,
      user.userId,
      {
        platform: 'instagram',
        accountType: 'business_account',
        platformAccountId: instagramUser.id,
        accountName: instagramUser.name,
        username: instagramUser.username,
        profilePictureUrl: instagramUser.profilePictureUrl || undefined,
        accessToken: dto.pageAccessToken, // Use Page Access Token for Instagram API
        permissions: PLATFORM_CONFIG.instagram.oauthScopes,
        capabilities: {
          canPost: true,
          canSchedule: true,
          canReadAnalytics: true,
          canReply: false,
          canDelete: true,
          supportedMediaTypes: ['image', 'video', 'carousel'],
          maxMediaPerPost: 10,
          maxTextLength: 2200,
        },
        metadata: {
          biography: instagramUser.biography,
          followersCount: instagramUser.followersCount,
          followsCount: instagramUser.followsCount,
          mediaCount: instagramUser.mediaCount,
          website: instagramUser.website,
        },
      },
    );

    return {
      channel,
      message: 'Instagram account connected successfully',
    };
  }

  /**
   * Get Instagram account info using Instagram User Access Token
   * Use this for tokens generated from Meta Developer Dashboard
   */
  @Post('instagram/me/token')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async getInstagramProfileWithToken(
    @Body() dto: { accessToken: string },
  ) {
    return await this.instagramService.getAccountInfoWithUserToken(dto.accessToken);
  }

  /**
   * Connect Instagram using Instagram User Access Token
   * This endpoint works with tokens generated from Meta Developer Dashboard
   * (API setup with Instagram login - "Generate access tokens" section)
   *
   * Note: This token type has limited permissions - it can read account info
   * but may not support content publishing. For full posting capabilities,
   * use the Facebook OAuth flow with connectFacebookPage endpoint.
   */
  @Post('workspaces/:workspaceId/instagram/connect-with-token')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async connectInstagramWithUserToken(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: { userId: string; email: string },
    @Body() dto: { accessToken: string },
  ) {
    // Get Instagram account info using User Access Token
    const instagramUser = await this.instagramService.getAccountInfoWithUserToken(
      dto.accessToken,
    );

    // Create the Instagram channel
    const channel = await this.channelService.createChannel(
      workspaceId,
      user.userId,
      {
        platform: 'instagram',
        accountType: 'business_account',
        platformAccountId: instagramUser.id,
        accountName: instagramUser.name,
        username: instagramUser.username,
        profilePictureUrl: instagramUser.profilePictureUrl || undefined,
        accessToken: dto.accessToken, // Instagram User Access Token
        permissions: ['instagram_basic', 'instagram_content_publish'],
        capabilities: {
          canPost: true,
          canSchedule: true,
          canReadAnalytics: false, // User tokens have limited analytics access
          canReply: false,
          canDelete: false,
          supportedMediaTypes: ['image', 'video', 'carousel'],
          maxMediaPerPost: 10,
          maxTextLength: 2200,
        },
        metadata: {
          biography: instagramUser.biography,
          followersCount: instagramUser.followersCount,
          followsCount: instagramUser.followsCount,
          mediaCount: instagramUser.mediaCount,
          website: instagramUser.website,
          tokenType: 'instagram_user_token', // Mark token type for reference
        },
      },
    );

    return {
      channel,
      message: 'Instagram account connected successfully using User Access Token',
    };
  }

  /**
   * Get Instagram account info using Page Access Token
   * Use this for tokens from Facebook OAuth flow
   */
  @Post('instagram/me')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async getInstagramProfile(
    @Body() dto: { instagramAccountId: string; pageAccessToken: string },
  ) {
    return await this.instagramService.getAccountInfo(
      dto.instagramAccountId,
      dto.pageAccessToken,
    );
  }

  /**
   * Get Instagram media/posts
   */
  @Post('instagram/media')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async getInstagramMedia(
    @Body() dto: { instagramAccountId: string; pageAccessToken: string },
    @Query('after') after?: string,
  ) {
    return await this.instagramService.getUserMedia(
      dto.instagramAccountId,
      dto.pageAccessToken,
      25,
      after,
    );
  }

  /**
   * Get Instagram account insights
   */
  @Post('instagram/insights')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async getInstagramInsights(
    @Body() dto: { instagramAccountId: string; pageAccessToken: string },
    @Query('period') period?: 'day' | 'week' | 'days_28',
  ) {
    return await this.instagramService.getAccountInsights(
      dto.instagramAccountId,
      dto.pageAccessToken,
      period || 'day',
    );
  }

  /**
   * Post an image to Instagram
   * Requires a publicly accessible image URL (Instagram fetches the image)
   */
  @Post('instagram/post/image')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async postImageToInstagram(
    @Body()
    dto: {
      channelId: number;
      imageUrl: string;
      caption?: string;
    },
  ) {
    // Get channel to retrieve access token and account ID
    const channel = await this.channelService.getChannelForPosting(dto.channelId);

    if (channel.platform !== 'instagram') {
      throw new BadRequestException('Channel is not an Instagram channel');
    }

    if (!channel.accessToken) {
      throw new BadRequestException('Channel has no access token');
    }

    // Check if this is an Instagram Business Login channel
    const isInstagramBusinessLogin = (channel.metadata as any)?.tokenType === 'instagram_business_login';

    let result: { postId: string };

    if (isInstagramBusinessLogin) {
      // Use Instagram Graph API (graph.instagram.com)
      result = await this.instagramService.createImagePostWithUserToken(
        channel.platformAccountId,
        channel.accessToken,
        dto.imageUrl,
        dto.caption,
      );
    } else {
      // Use Facebook Graph API (graph.facebook.com) for Page-linked accounts
      result = await this.instagramService.createImagePost(
        channel.platformAccountId,
        channel.accessToken,
        dto.imageUrl,
        dto.caption,
      );
    }

    // Update last posted timestamp
    await this.channelService.updateLastPostedAt(dto.channelId);

    return {
      success: true,
      postId: result.postId,
      message: 'Image posted to Instagram successfully',
    };
  }

  /**
   * Post a video/reel to Instagram
   * Requires a publicly accessible video URL
   */
  @Post('instagram/post/video')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async postVideoToInstagram(
    @Body()
    dto: {
      channelId: number;
      videoUrl: string;
      caption?: string;
      isReel?: boolean;
    },
  ) {
    const channel = await this.channelService.getChannelForPosting(dto.channelId);

    if (channel.platform !== 'instagram') {
      throw new BadRequestException('Channel is not an Instagram channel');
    }

    if (!channel.accessToken) {
      throw new BadRequestException('Channel has no access token');
    }

    // Check if this is an Instagram Business Login channel
    const isInstagramBusinessLogin = (channel.metadata as any)?.tokenType === 'instagram_business_login';

    let result: { postId: string };

    if (isInstagramBusinessLogin) {
      // Use Instagram Graph API (graph.instagram.com)
      result = await this.instagramService.createVideoPostWithUserToken(
        channel.platformAccountId,
        channel.accessToken,
        dto.videoUrl,
        dto.caption,
        dto.isReel ?? false,
      );
    } else {
      // Use Facebook Graph API (graph.facebook.com) for Page-linked accounts
      result = await this.instagramService.createVideoPost(
        channel.platformAccountId,
        channel.accessToken,
        dto.videoUrl,
        dto.caption,
        dto.isReel ?? false,
      );
    }

    await this.channelService.updateLastPostedAt(dto.channelId);

    return {
      success: true,
      postId: result.postId,
      message: dto.isReel
        ? 'Reel posted to Instagram successfully'
        : 'Video posted to Instagram successfully',
    };
  }

  /**
   * Post a carousel (multiple images/videos) to Instagram
   */
  @Post('instagram/post/carousel')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async postCarouselToInstagram(
    @Body()
    dto: {
      channelId: number;
      mediaItems: Array<{ type: 'IMAGE' | 'VIDEO'; url: string }>;
      caption?: string;
    },
  ) {
    const channel = await this.channelService.getChannelForPosting(dto.channelId);

    if (channel.platform !== 'instagram') {
      throw new BadRequestException('Channel is not an Instagram channel');
    }

    if (!channel.accessToken) {
      throw new BadRequestException('Channel has no access token');
    }

    // Check if this is an Instagram Business Login channel
    const isInstagramBusinessLogin = (channel.metadata as any)?.tokenType === 'instagram_business_login';

    let result: { postId: string };

    if (isInstagramBusinessLogin) {
      // Use Instagram Graph API (graph.instagram.com)
      result = await this.instagramService.createCarouselPostWithUserToken(
        channel.platformAccountId,
        channel.accessToken,
        dto.mediaItems,
        dto.caption,
      );
    } else {
      // Use Facebook Graph API (graph.facebook.com) for Page-linked accounts
      result = await this.instagramService.createCarouselPost(
        channel.platformAccountId,
        channel.accessToken,
        dto.mediaItems,
        dto.caption,
      );
    }

    await this.channelService.updateLastPostedAt(dto.channelId);

    return {
      success: true,
      postId: result.postId,
      message: 'Carousel posted to Instagram successfully',
    };
  }

  /**
   * Instagram deauthorization webhook
   * Called by Meta when user revokes app access
   * This endpoint is PUBLIC (no auth) as Meta calls it directly
   */
  @Post('instagram/deauthorize')
  @HttpCode(HttpStatus.OK)
  async instagramDeauthorize(@Body() body: any) {
    console.log('[Instagram Deauthorize] Received webhook:', JSON.stringify(body));
    // Meta sends a signed_request with user info
    // TODO: Parse signed_request, find channel by platform account ID, mark as revoked
    return { success: true };
  }

  // ==========================================================================
  // Threads Specific Endpoints
  // ==========================================================================

  /**
   * Connect Threads account
   */
  @Post('workspaces/:workspaceId/threads/connect')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async connectThreads(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: { userId: string; email: string },
    @Body() dto: FetchPagesDto,
  ) {
    // Get Threads profile info
    const threadsUser = await this.threadsService.getUserProfile(dto.accessToken);

    // Create the Threads channel
    const channel = await this.channelService.createChannel(
      workspaceId,
      user.userId,
      {
        platform: 'threads',
        accountType: 'profile',
        platformAccountId: threadsUser.id,
        accountName: threadsUser.name || threadsUser.username,
        username: threadsUser.username,
        profilePictureUrl: threadsUser.profilePictureUrl || undefined,
        accessToken: dto.accessToken,
        permissions: PLATFORM_CONFIG.threads.oauthScopes,
        capabilities: {
          canPost: true,
          canSchedule: true,
          canReadAnalytics: true,
          canReply: true,
          canDelete: true,
          supportedMediaTypes: ['text', 'image', 'video', 'carousel'],
          maxMediaPerPost: 10,
          maxTextLength: 500,
        },
        metadata: {
          biography: threadsUser.biography,
          threadsProfileUrl: threadsUser.threadsProfileUrl,
        },
      },
    );

    return {
      channel,
      message: 'Threads account connected successfully',
    };
  }

  /**
   * Get Threads profile info
   */
  @Post('threads/me')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async getThreadsProfile(@Body() dto: FetchPagesDto) {
    return await this.threadsService.getUserProfile(dto.accessToken);
  }

  /**
   * Get user's Threads posts
   */
  @Post('threads/posts')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async getThreadsPosts(
    @Body() dto: FetchPagesDto,
    @Query('after') after?: string,
  ) {
    return await this.threadsService.getUserThreads(
      dto.accessToken,
      'me',
      25,
      after,
    );
  }

  /**
   * Get thread insights
   */
  @Post('threads/insights')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async getThreadInsights(
    @Body() dto: FetchPagesDto & { threadId: string },
  ) {
    return await this.threadsService.getThreadInsights(
      dto.accessToken,
      dto.threadId,
    );
  }

  // ==========================================================================
  // Threads Posting Endpoints
  // ==========================================================================

  /**
   * Post a text-only thread
   */
  @Post('threads/post/text')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async postTextToThreads(
    @Body()
    dto: {
      channelId: number;
      text: string;
      replyToId?: string;
    },
  ) {
    const channel = await this.channelService.getChannelForPosting(dto.channelId);

    if (channel.platform !== 'threads') {
      throw new BadRequestException('Channel is not a Threads channel');
    }

    if (!channel.accessToken) {
      throw new BadRequestException('Channel has no access token');
    }

    const result = await this.threadsService.createTextThread(
      channel.accessToken,
      channel.platformAccountId,
      dto.text,
      dto.replyToId,
    );

    await this.channelService.updateLastPostedAt(dto.channelId);

    return {
      success: true,
      postId: result.postId,
      message: 'Text thread posted successfully',
    };
  }

  /**
   * Post an image thread
   */
  @Post('threads/post/image')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async postImageToThreads(
    @Body()
    dto: {
      channelId: number;
      imageUrl: string;
      text?: string;
      replyToId?: string;
    },
  ) {
    const channel = await this.channelService.getChannelForPosting(dto.channelId);

    if (channel.platform !== 'threads') {
      throw new BadRequestException('Channel is not a Threads channel');
    }

    if (!channel.accessToken) {
      throw new BadRequestException('Channel has no access token');
    }

    const result = await this.threadsService.createImageThread(
      channel.accessToken,
      channel.platformAccountId,
      dto.imageUrl,
      dto.text,
      dto.replyToId,
    );

    await this.channelService.updateLastPostedAt(dto.channelId);

    return {
      success: true,
      postId: result.postId,
      message: 'Image thread posted successfully',
    };
  }

  /**
   * Post a video thread
   */
  @Post('threads/post/video')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async postVideoToThreads(
    @Body()
    dto: {
      channelId: number;
      videoUrl: string;
      text?: string;
      replyToId?: string;
    },
  ) {
    const channel = await this.channelService.getChannelForPosting(dto.channelId);

    if (channel.platform !== 'threads') {
      throw new BadRequestException('Channel is not a Threads channel');
    }

    if (!channel.accessToken) {
      throw new BadRequestException('Channel has no access token');
    }

    const result = await this.threadsService.createVideoThread(
      channel.accessToken,
      channel.platformAccountId,
      dto.videoUrl,
      dto.text,
      dto.replyToId,
    );

    await this.channelService.updateLastPostedAt(dto.channelId);

    return {
      success: true,
      postId: result.postId,
      message: 'Video thread posted successfully',
    };
  }

  /**
   * Post a carousel thread (multiple images/videos)
   */
  @Post('threads/post/carousel')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async postCarouselToThreads(
    @Body()
    dto: {
      channelId: number;
      mediaItems: Array<{ type: 'IMAGE' | 'VIDEO'; url: string }>;
      text?: string;
      replyToId?: string;
    },
  ) {
    const channel = await this.channelService.getChannelForPosting(dto.channelId);

    if (channel.platform !== 'threads') {
      throw new BadRequestException('Channel is not a Threads channel');
    }

    if (!channel.accessToken) {
      throw new BadRequestException('Channel has no access token');
    }

    const result = await this.threadsService.createCarouselThread(
      channel.accessToken,
      channel.platformAccountId,
      dto.mediaItems,
      dto.text,
      dto.replyToId,
    );

    await this.channelService.updateLastPostedAt(dto.channelId);

    return {
      success: true,
      postId: result.postId,
      message: 'Carousel thread posted successfully',
    };
  }

  /**
   * Threads deauthorization webhook
   * Called by Meta when user revokes app access
   * This endpoint is PUBLIC (no auth) as Meta calls it directly
   */
  @Post('threads/deauthorize')
  @HttpCode(HttpStatus.OK)
  async threadsDeauthorize(@Body() body: any) {
    console.log('[Threads Deauthorize] Received webhook:', JSON.stringify(body));
    // Meta sends a signed_request with user info
    // TODO: Parse signed_request, find channel by platform account ID, mark as revoked
    return { success: true };
  }

  // ==========================================================================
  // Bluesky Endpoints
  // ==========================================================================

  /**
   * Connect Bluesky account using handle and app password
   * Bluesky uses App Passwords instead of OAuth
   */
  @Post('workspaces/:workspaceId/bluesky/connect')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async connectBluesky(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: { userId: string; email: string },
    @Body()
    dto: {
      identifier: string; // Handle (e.g., user.bsky.social) or email
      appPassword: string; // App password from Bluesky settings
    },
  ) {
    // Create session with Bluesky
    const session = await this.blueskyService.createSession(
      dto.identifier,
      dto.appPassword,
    );

    // Get user profile
    const profile = await this.blueskyService.getProfile(
      session.accessJwt,
      session.did,
    );

    // Create channel
    const channel = await this.channelService.createChannel(
      workspaceId,
      user.userId,
      {
        platform: 'bluesky',
        accountType: 'profile',
        platformAccountId: session.did,
        accountName: profile.displayName || profile.handle,
        username: profile.handle,
        profilePictureUrl: profile.avatar || undefined,
        accessToken: session.accessJwt,
        refreshToken: session.refreshJwt,
        tokenExpiresAt: undefined, // Bluesky sessions don't have a fixed expiration
        tokenScope: 'atproto',
        metadata: {
          did: session.did,
          handle: profile.handle,
          displayName: profile.displayName,
          description: profile.description,
          followersCount: profile.followersCount,
          followsCount: profile.followsCount,
          postsCount: profile.postsCount,
        },
        capabilities: {
          canPost: true,
          canSchedule: true,
          canReadAnalytics: false,
          canReply: true,
          canDelete: true,
          supportedMediaTypes: ['image', 'video'],
          maxMediaPerPost: 4,
          maxTextLength: 300,
        },
      },
    );

    return {
      channel,
      message: 'Bluesky account connected successfully',
    };
  }

  /**
   * Get Bluesky profile info
   */
  @Post('bluesky/me')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async getBlueskyProfile(
    @Body() dto: FetchPagesDto & { did: string },
  ) {
    return await this.blueskyService.getProfile(dto.accessToken, dto.did);
  }

  /**
   * Get user's Bluesky posts
   */
  @Post('bluesky/posts')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async getBlueskyPosts(
    @Body() dto: FetchPagesDto & { actor: string; limit?: number; cursor?: string },
  ) {
    return await this.blueskyService.getAuthorFeed(
      dto.accessToken,
      dto.actor,
      dto.limit || 25,
      dto.cursor,
    );
  }

  /**
   * Refresh Bluesky session
   */
  @Post('bluesky/refresh')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async refreshBlueskySession(
    @Body() dto: { channelId: number },
  ) {
    const channel = await this.channelService.getChannelForPosting(dto.channelId);

    if (channel.platform !== 'bluesky') {
      throw new BadRequestException('Channel is not a Bluesky channel');
    }

    const metadata = channel.metadata as { did?: string } | null;
    if (!metadata?.did) {
      throw new BadRequestException('Channel is missing Bluesky DID');
    }

    // Get refresh token from channel
    if (!channel.refreshToken) {
      throw new BadRequestException('No refresh token available. Please reconnect the account.');
    }

    const newSession = await this.blueskyService.refreshSession(channel.refreshToken);

    // Update channel with new tokens
    await this.channelService.updateChannelTokens(
      dto.channelId,
      newSession.accessJwt,
      newSession.refreshJwt,
    );

    return {
      success: true,
      message: 'Bluesky session refreshed successfully',
    };
  }

  // ==========================================================================
  // Bluesky Posting Endpoints
  // ==========================================================================

  /**
   * Post a text-only thread to Bluesky
   */
  @Post('bluesky/post/text')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async postTextToBluesky(
    @Body()
    dto: {
      channelId: number;
      text: string;
      replyTo?: { uri: string; cid: string };
    },
  ) {
    const channel = await this.channelService.getChannelForPosting(dto.channelId);

    if (channel.platform !== 'bluesky') {
      throw new BadRequestException('Channel is not a Bluesky channel');
    }

    if (!channel.accessToken) {
      throw new BadRequestException('Channel has no access token');
    }

    const metadata = channel.metadata as { did?: string } | null;
    if (!metadata?.did) {
      throw new BadRequestException('Channel is missing Bluesky DID');
    }

    const result = await this.blueskyService.createTextPost(
      channel.accessToken,
      metadata.did,
      dto.text,
      dto.replyTo,
    );

    await this.channelService.updateLastPostedAt(dto.channelId);

    return {
      success: true,
      postUri: result.uri,
      postCid: result.cid,
      message: 'Text post created successfully on Bluesky',
    };
  }

  /**
   * Post an image to Bluesky
   */
  @Post('bluesky/post/image')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async postImageToBluesky(
    @Body()
    dto: {
      channelId: number;
      text: string;
      imageUrls: string[];
      altTexts?: string[];
    },
  ) {
    const channel = await this.channelService.getChannelForPosting(dto.channelId);

    if (channel.platform !== 'bluesky') {
      throw new BadRequestException('Channel is not a Bluesky channel');
    }

    if (!channel.accessToken) {
      throw new BadRequestException('Channel has no access token');
    }

    const metadata = channel.metadata as { did?: string } | null;
    if (!metadata?.did) {
      throw new BadRequestException('Channel is missing Bluesky DID');
    }

    if (!dto.imageUrls || dto.imageUrls.length === 0) {
      throw new BadRequestException('At least one image URL is required');
    }

    if (dto.imageUrls.length > 4) {
      throw new BadRequestException('Bluesky allows a maximum of 4 images per post');
    }

    const result = await this.blueskyService.createImagePost(
      channel.accessToken,
      metadata.did,
      dto.text,
      dto.imageUrls,
      dto.altTexts,
    );

    await this.channelService.updateLastPostedAt(dto.channelId);

    return {
      success: true,
      postUri: result.uri,
      postCid: result.cid,
      message: 'Image post created successfully on Bluesky',
    };
  }

  /**
   * Post a video to Bluesky
   */
  @Post('bluesky/post/video')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async postVideoToBluesky(
    @Body()
    dto: {
      channelId: number;
      text: string;
      videoUrl: string;
      altText?: string;
    },
  ) {
    const channel = await this.channelService.getChannelForPosting(dto.channelId);

    if (channel.platform !== 'bluesky') {
      throw new BadRequestException('Channel is not a Bluesky channel');
    }

    if (!channel.accessToken) {
      throw new BadRequestException('Channel has no access token');
    }

    const metadata = channel.metadata as { did?: string } | null;
    if (!metadata?.did) {
      throw new BadRequestException('Channel is missing Bluesky DID');
    }

    const result = await this.blueskyService.createVideoPost(
      channel.accessToken,
      metadata.did,
      dto.text,
      dto.videoUrl,
      dto.altText,
    );

    await this.channelService.updateLastPostedAt(dto.channelId);

    return {
      success: true,
      postUri: result.uri,
      postCid: result.cid,
      message: 'Video post created successfully on Bluesky',
    };
  }

  /**
   * Post with a link card to Bluesky
   */
  @Post('bluesky/post/link')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async postLinkToBluesky(
    @Body()
    dto: {
      channelId: number;
      text: string;
      linkUrl: string;
      linkTitle: string;
      linkDescription?: string;
      linkThumbUrl?: string;
    },
  ) {
    const channel = await this.channelService.getChannelForPosting(dto.channelId);

    if (channel.platform !== 'bluesky') {
      throw new BadRequestException('Channel is not a Bluesky channel');
    }

    if (!channel.accessToken) {
      throw new BadRequestException('Channel has no access token');
    }

    const metadata = channel.metadata as { did?: string } | null;
    if (!metadata?.did) {
      throw new BadRequestException('Channel is missing Bluesky DID');
    }

    const result = await this.blueskyService.createLinkPost(
      channel.accessToken,
      metadata.did,
      dto.text,
      dto.linkUrl,
      dto.linkTitle,
      dto.linkDescription,
      dto.linkThumbUrl,
    );

    await this.channelService.updateLastPostedAt(dto.channelId);

    return {
      success: true,
      postUri: result.uri,
      postCid: result.cid,
      message: 'Link post created successfully on Bluesky',
    };
  }

  /**
   * Delete a Bluesky post
   */
  @Delete('bluesky/post')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async deleteBlueskyPost(
    @Body()
    dto: {
      channelId: number;
      postUri: string;
    },
  ) {
    const channel = await this.channelService.getChannelForPosting(dto.channelId);

    if (channel.platform !== 'bluesky') {
      throw new BadRequestException('Channel is not a Bluesky channel');
    }

    if (!channel.accessToken) {
      throw new BadRequestException('Channel has no access token');
    }

    const metadata = channel.metadata as { did?: string } | null;
    if (!metadata?.did) {
      throw new BadRequestException('Channel is missing Bluesky DID');
    }

    await this.blueskyService.deletePost(
      channel.accessToken,
      metadata.did,
      dto.postUri,
    );

    return {
      success: true,
      message: 'Post deleted successfully from Bluesky',
    };
  }

  // ==========================================================================
  // Mastodon Endpoints
  // ==========================================================================

  /**
   * Initiate Mastodon OAuth flow
   * Mastodon requires per-instance app registration, so this handles that
   */
  @Post('workspaces/:workspaceId/mastodon/oauth/initiate')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async initiateMastodonOAuth(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: { userId: string; email: string },
    @Body()
    dto: {
      instanceUrl: string; // e.g., "mastodon.social" or "https://mastodon.social"
      redirectUrl?: string; // Frontend URL to redirect after OAuth
    },
  ) {
    // Build our backend callback URL
    const appUrl = process.env.APP_URL || 'http://localhost:3000';
    const redirectUri = `${appUrl}/channels/oauth/mastodon/callback`;

    // Register app with the Mastodon instance
    const app = await this.mastodonService.registerApp(
      dto.instanceUrl,
      redirectUri,
    );

    // Generate state token for CSRF protection
    const stateToken = crypto.randomBytes(32).toString('hex');

    // Store state in database
    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + 15);

    await db.insert(oauthStates).values({
      stateToken,
      workspaceId,
      userId: user.userId,
      platform: 'mastodon',
      redirectUrl: dto.redirectUrl || null,
      additionalData: {
        instanceUrl: app.instanceUrl,
        clientId: app.clientId,
        clientSecret: app.clientSecret,
        redirectUri,
      },
      expiresAt,
    });

    // Generate authorization URL
    const authorizationUrl = this.mastodonService.getAuthorizationUrl(
      app.instanceUrl,
      app.clientId,
      redirectUri,
      stateToken,
    );

    return {
      authorizationUrl,
      state: stateToken,
    };
  }

  /**
   * Mastodon OAuth callback
   */
  @Get('oauth/mastodon/callback')
  async mastodonOAuthCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() res: Response,
  ) {
    // Find and validate state
    const stateRecords = await db
      .select()
      .from(oauthStates)
      .where(
        and(
          eq(oauthStates.stateToken, state),
          eq(oauthStates.platform, 'mastodon'),
          isNull(oauthStates.usedAt),
          gt(oauthStates.expiresAt, new Date()),
        ),
      )
      .limit(1);

    if (stateRecords.length === 0) {
      return res.redirect(
        `/channels/connect/error?error=invalid_state&description=OAuth+state+is+invalid+or+expired`,
      );
    }

    const stateRecord = stateRecords[0];
    const additionalData = stateRecord.additionalData as {
      instanceUrl: string;
      clientId: string;
      clientSecret: string;
      redirectUri: string;
    };

    // Mark state as used
    await db
      .update(oauthStates)
      .set({ usedAt: new Date() })
      .where(eq(oauthStates.id, stateRecord.id));

    try {
      // Exchange code for token
      const tokenData = await this.mastodonService.exchangeCodeForToken(
        additionalData.instanceUrl,
        additionalData.clientId,
        additionalData.clientSecret,
        code,
        additionalData.redirectUri,
      );

      // Get account info
      const account = await this.mastodonService.verifyCredentials(
        additionalData.instanceUrl,
        tokenData.accessToken,
      );

      // Create channel
      await this.channelService.createChannel(
        stateRecord.workspaceId,
        stateRecord.userId,
        {
          platform: 'mastodon',
          accountType: 'profile',
          platformAccountId: account.id,
          accountName: account.displayName || account.username,
          username: `${account.username}@${new URL(additionalData.instanceUrl).hostname}`,
          profilePictureUrl: account.avatar,
          accessToken: tokenData.accessToken,
          tokenScope: tokenData.scope,
          metadata: {
            instanceUrl: additionalData.instanceUrl,
            clientId: additionalData.clientId,
            clientSecret: additionalData.clientSecret,
            acct: account.acct,
            url: account.url,
            followersCount: account.followersCount,
            followingCount: account.followingCount,
            statusesCount: account.statusesCount,
          },
          capabilities: {
            canPost: true,
            canSchedule: true,
            canReadAnalytics: false,
            canReply: true,
            canDelete: true,
            supportedMediaTypes: ['image', 'video', 'gif'],
            maxMediaPerPost: 4,
            maxTextLength: 500,
          },
        },
      );

      // Redirect to frontend
      const redirectUrl = stateRecord.redirectUrl || '/channels/connect/success';
      const separator = redirectUrl.includes('?') ? '&' : '?';
      return res.redirect(`${redirectUrl}${separator}platform=mastodon&success=true`);
    } catch (error) {
      console.error('[Mastodon OAuth] Error:', error);
      const redirectUrl = stateRecord.redirectUrl || '/channels/connect/error';
      const separator = redirectUrl.includes('?') ? '&' : '?';
      return res.redirect(
        `${redirectUrl}${separator}error=oauth_failed&description=${encodeURIComponent(error.message || 'OAuth failed')}`,
      );
    }
  }

  /**
   * Get Mastodon profile info
   */
  @Post('mastodon/me')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async getMastodonProfile(
    @Body() dto: { channelId: number },
  ) {
    const channel = await this.channelService.getChannelForPosting(dto.channelId);

    if (channel.platform !== 'mastodon') {
      throw new BadRequestException('Channel is not a Mastodon channel');
    }

    const metadata = channel.metadata as { instanceUrl?: string } | null;
    if (!metadata?.instanceUrl) {
      throw new BadRequestException('Channel is missing Mastodon instance URL');
    }

    return await this.mastodonService.verifyCredentials(
      metadata.instanceUrl,
      channel.accessToken!,
    );
  }

  /**
   * Get user's Mastodon posts
   */
  @Post('mastodon/posts')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async getMastodonPosts(
    @Body() dto: { channelId: number; limit?: number; maxId?: string },
  ) {
    const channel = await this.channelService.getChannelForPosting(dto.channelId);

    if (channel.platform !== 'mastodon') {
      throw new BadRequestException('Channel is not a Mastodon channel');
    }

    const metadata = channel.metadata as { instanceUrl?: string } | null;
    if (!metadata?.instanceUrl) {
      throw new BadRequestException('Channel is missing Mastodon instance URL');
    }

    return await this.mastodonService.getAccountStatuses(
      metadata.instanceUrl,
      channel.accessToken!,
      channel.platformAccountId,
      dto.limit || 20,
      dto.maxId,
    );
  }

  // ==========================================================================
  // Mastodon Posting Endpoints
  // ==========================================================================

  /**
   * Post a text status to Mastodon
   */
  @Post('mastodon/post/text')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async postTextToMastodon(
    @Body()
    dto: {
      channelId: number;
      text: string;
      visibility?: 'public' | 'unlisted' | 'private' | 'direct';
      inReplyToId?: string;
      sensitive?: boolean;
      spoilerText?: string;
    },
  ) {
    const channel = await this.channelService.getChannelForPosting(dto.channelId);

    if (channel.platform !== 'mastodon') {
      throw new BadRequestException('Channel is not a Mastodon channel');
    }

    if (!channel.accessToken) {
      throw new BadRequestException('Channel has no access token');
    }

    const metadata = channel.metadata as { instanceUrl?: string } | null;
    if (!metadata?.instanceUrl) {
      throw new BadRequestException('Channel is missing Mastodon instance URL');
    }

    const result = await this.mastodonService.createStatus(
      metadata.instanceUrl,
      channel.accessToken,
      dto.text,
      {
        visibility: dto.visibility,
        inReplyToId: dto.inReplyToId,
        sensitive: dto.sensitive,
        spoilerText: dto.spoilerText,
      },
    );

    await this.channelService.updateLastPostedAt(dto.channelId);

    return {
      success: true,
      postId: result.id,
      postUrl: result.url,
      message: 'Status posted successfully to Mastodon',
    };
  }

  /**
   * Post an image to Mastodon
   */
  @Post('mastodon/post/image')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async postImageToMastodon(
    @Body()
    dto: {
      channelId: number;
      text: string;
      imageUrls: string[];
      altTexts?: string[];
      visibility?: 'public' | 'unlisted' | 'private' | 'direct';
    },
  ) {
    const channel = await this.channelService.getChannelForPosting(dto.channelId);

    if (channel.platform !== 'mastodon') {
      throw new BadRequestException('Channel is not a Mastodon channel');
    }

    if (!channel.accessToken) {
      throw new BadRequestException('Channel has no access token');
    }

    const metadata = channel.metadata as { instanceUrl?: string } | null;
    if (!metadata?.instanceUrl) {
      throw new BadRequestException('Channel is missing Mastodon instance URL');
    }

    if (!dto.imageUrls || dto.imageUrls.length === 0) {
      throw new BadRequestException('At least one image URL is required');
    }

    if (dto.imageUrls.length > 4) {
      throw new BadRequestException('Mastodon allows a maximum of 4 images per post');
    }

    const result = await this.mastodonService.createImagePost(
      metadata.instanceUrl,
      channel.accessToken,
      dto.text,
      dto.imageUrls,
      dto.altTexts,
      dto.visibility,
    );

    await this.channelService.updateLastPostedAt(dto.channelId);

    return {
      success: true,
      postId: result.id,
      postUrl: result.url,
      message: 'Image post created successfully on Mastodon',
    };
  }

  /**
   * Post a video to Mastodon
   */
  @Post('mastodon/post/video')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async postVideoToMastodon(
    @Body()
    dto: {
      channelId: number;
      text: string;
      videoUrl: string;
      description?: string;
      visibility?: 'public' | 'unlisted' | 'private' | 'direct';
    },
  ) {
    const channel = await this.channelService.getChannelForPosting(dto.channelId);

    if (channel.platform !== 'mastodon') {
      throw new BadRequestException('Channel is not a Mastodon channel');
    }

    if (!channel.accessToken) {
      throw new BadRequestException('Channel has no access token');
    }

    const metadata = channel.metadata as { instanceUrl?: string } | null;
    if (!metadata?.instanceUrl) {
      throw new BadRequestException('Channel is missing Mastodon instance URL');
    }

    const result = await this.mastodonService.createVideoPost(
      metadata.instanceUrl,
      channel.accessToken,
      dto.text,
      dto.videoUrl,
      dto.description,
      dto.visibility,
    );

    await this.channelService.updateLastPostedAt(dto.channelId);

    return {
      success: true,
      postId: result.id,
      postUrl: result.url,
      message: 'Video post created successfully on Mastodon',
    };
  }

  /**
   * Delete a Mastodon post
   */
  @Delete('mastodon/post')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async deleteMastodonPost(
    @Body()
    dto: {
      channelId: number;
      postId: string;
    },
  ) {
    const channel = await this.channelService.getChannelForPosting(dto.channelId);

    if (channel.platform !== 'mastodon') {
      throw new BadRequestException('Channel is not a Mastodon channel');
    }

    if (!channel.accessToken) {
      throw new BadRequestException('Channel has no access token');
    }

    const metadata = channel.metadata as { instanceUrl?: string } | null;
    if (!metadata?.instanceUrl) {
      throw new BadRequestException('Channel is missing Mastodon instance URL');
    }

    await this.mastodonService.deleteStatus(
      metadata.instanceUrl,
      channel.accessToken,
      dto.postId,
    );

    return {
      success: true,
      message: 'Post deleted successfully from Mastodon',
    };
  }

  /**
   * Get Mastodon instance info
   */
  @Post('mastodon/instance')
  @HttpCode(HttpStatus.OK)
  async getMastodonInstanceInfo(
    @Body() dto: { instanceUrl: string },
  ) {
    return await this.mastodonService.getInstanceInfo(dto.instanceUrl);
  }

  // ==========================================================================
  // Google Drive Endpoints
  // ==========================================================================

  /**
   * List media files from Google Drive (images and videos)
   */
  @Post('google-drive/media')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async listDriveMedia(
    @Body() dto: FetchPagesDto & {
      folderId?: string;
      query?: string;
      pageSize?: number;
      pageToken?: string;
    },
  ) {
    return await this.googleDriveService.listMedia(dto.accessToken, {
      folderId: dto.folderId,
      query: dto.query,
      pageSize: dto.pageSize,
      pageToken: dto.pageToken,
    });
  }

  /**
   * List images from Google Drive
   */
  @Post('google-drive/images')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async listDriveImages(
    @Body() dto: FetchPagesDto & {
      folderId?: string;
      query?: string;
      pageSize?: number;
      pageToken?: string;
    },
  ) {
    return await this.googleDriveService.listImages(dto.accessToken, {
      folderId: dto.folderId,
      query: dto.query,
      pageSize: dto.pageSize,
      pageToken: dto.pageToken,
    });
  }

  /**
   * List videos from Google Drive
   */
  @Post('google-drive/videos')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async listDriveVideos(
    @Body() dto: FetchPagesDto & {
      folderId?: string;
      query?: string;
      pageSize?: number;
      pageToken?: string;
    },
  ) {
    return await this.googleDriveService.listVideos(dto.accessToken, {
      folderId: dto.folderId,
      query: dto.query,
      pageSize: dto.pageSize,
      pageToken: dto.pageToken,
    });
  }

  /**
   * List folders from Google Drive
   */
  @Post('google-drive/folders')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async listDriveFolders(
    @Body() dto: FetchPagesDto & {
      parentId?: string;
      pageSize?: number;
      pageToken?: string;
    },
  ) {
    return await this.googleDriveService.listFolders(dto.accessToken, {
      parentId: dto.parentId,
      pageSize: dto.pageSize,
      pageToken: dto.pageToken,
    });
  }

  /**
   * Get a specific file from Google Drive
   */
  @Post('google-drive/file/:fileId')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async getDriveFile(
    @Param('fileId') fileId: string,
    @Body() dto: FetchPagesDto,
  ) {
    return await this.googleDriveService.getFile(dto.accessToken, fileId);
  }

  /**
   * Get Google Drive user info
   */
  @Post('google-drive/me')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async getDriveUserInfo(@Body() dto: FetchPagesDto) {
    return await this.googleDriveService.getUserInfo(dto.accessToken);
  }

  /**
   * Verify Google Drive access
   */
  @Post('google-drive/verify')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async verifyDriveAccess(@Body() dto: FetchPagesDto) {
    const hasAccess = await this.googleDriveService.verifyAccess(dto.accessToken);
    return { hasAccess };
  }

  // ==========================================================================
  // Google Photos Endpoints
  // ==========================================================================

  /**
   * List media items from Google Photos
   */
  @Post('google-photos/media')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async listPhotosMedia(
    @Body() dto: FetchPagesDto & {
      pageSize?: number;
      pageToken?: string;
      albumId?: string;
      mediaType?: 'ALL_MEDIA' | 'PHOTO' | 'VIDEO';
    },
  ) {
    return await this.googlePhotosService.listMediaItems(dto.accessToken, {
      pageSize: dto.pageSize,
      pageToken: dto.pageToken,
      albumId: dto.albumId,
      filters: dto.mediaType ? { mediaTypeFilter: dto.mediaType } : undefined,
    });
  }

  /**
   * List only photos from Google Photos
   */
  @Post('google-photos/photos')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async listPhotosOnly(
    @Body() dto: FetchPagesDto & {
      pageSize?: number;
      pageToken?: string;
      albumId?: string;
    },
  ) {
    return await this.googlePhotosService.listPhotos(dto.accessToken, {
      pageSize: dto.pageSize,
      pageToken: dto.pageToken,
      albumId: dto.albumId,
    });
  }

  /**
   * List only videos from Google Photos
   */
  @Post('google-photos/videos')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async listPhotosVideos(
    @Body() dto: FetchPagesDto & {
      pageSize?: number;
      pageToken?: string;
      albumId?: string;
    },
  ) {
    return await this.googlePhotosService.listVideos(dto.accessToken, {
      pageSize: dto.pageSize,
      pageToken: dto.pageToken,
      albumId: dto.albumId,
    });
  }

  /**
   * List albums from Google Photos
   */
  @Post('google-photos/albums')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async listPhotosAlbums(
    @Body() dto: FetchPagesDto & {
      pageSize?: number;
      pageToken?: string;
    },
  ) {
    return await this.googlePhotosService.listAlbums(dto.accessToken, {
      pageSize: dto.pageSize,
      pageToken: dto.pageToken,
    });
  }

  /**
   * Get a specific media item from Google Photos
   */
  @Post('google-photos/media/:mediaItemId')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async getPhotosMediaItem(
    @Param('mediaItemId') mediaItemId: string,
    @Body() dto: FetchPagesDto,
  ) {
    return await this.googlePhotosService.getMediaItem(dto.accessToken, mediaItemId);
  }

  /**
   * Verify Google Photos access
   */
  @Post('google-photos/verify')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async verifyPhotosAccess(@Body() dto: FetchPagesDto) {
    const hasAccess = await this.googlePhotosService.verifyAccess(dto.accessToken);
    return { hasAccess };
  }

  // ==========================================================================
  // Google Calendar Endpoints
  // ==========================================================================

  /**
   * List user's calendars
   */
  @Post('google-calendar/calendars')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async listCalendars(@Body() dto: FetchPagesDto) {
    return await this.googleCalendarService.listCalendars(dto.accessToken);
  }

  /**
   * Get primary calendar
   */
  @Post('google-calendar/primary')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async getPrimaryCalendar(@Body() dto: FetchPagesDto) {
    return await this.googleCalendarService.getPrimaryCalendar(dto.accessToken);
  }

  /**
   * List calendar events
   */
  @Post('google-calendar/events')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async listCalendarEvents(
    @Body() dto: FetchPagesDto & {
      calendarId?: string;
      timeMin?: string;
      timeMax?: string;
      maxResults?: number;
      pageToken?: string;
    },
  ) {
    return await this.googleCalendarService.listEvents(dto.accessToken, {
      calendarId: dto.calendarId,
      timeMin: dto.timeMin ? new Date(dto.timeMin) : undefined,
      timeMax: dto.timeMax ? new Date(dto.timeMax) : undefined,
      maxResults: dto.maxResults,
      pageToken: dto.pageToken,
    });
  }

  /**
   * Create a calendar event
   */
  @Post('google-calendar/events/create')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async createCalendarEvent(
    @Body() dto: FetchPagesDto & {
      summary: string;
      description?: string;
      startTime: string;
      endTime?: string;
      timeZone?: string;
      colorId?: string;
      calendarId?: string;
    },
  ) {
    return await this.googleCalendarService.createEvent(dto.accessToken, {
      summary: dto.summary,
      description: dto.description,
      startTime: new Date(dto.startTime),
      endTime: dto.endTime ? new Date(dto.endTime) : undefined,
      timeZone: dto.timeZone,
      colorId: dto.colorId,
      calendarId: dto.calendarId,
    });
  }

  /**
   * Create a calendar event for a scheduled post
   */
  @Post('google-calendar/events/post')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async createPostCalendarEvent(
    @Body() dto: FetchPagesDto & {
      postId: string;
      platforms: string[];
      caption: string;
      scheduledAt: string;
      mediaUrls?: string[];
      workspaceName?: string;
      calendarId?: string;
    },
  ) {
    return await this.googleCalendarService.createPostEvent(
      dto.accessToken,
      {
        postId: dto.postId,
        platforms: dto.platforms,
        caption: dto.caption,
        scheduledAt: new Date(dto.scheduledAt),
        mediaUrls: dto.mediaUrls,
        workspaceName: dto.workspaceName,
      },
      dto.calendarId,
    );
  }

  /**
   * Update a calendar event
   */
  @Post('google-calendar/events/:eventId/update')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async updateCalendarEvent(
    @Param('eventId') eventId: string,
    @Body() dto: FetchPagesDto & {
      summary?: string;
      description?: string;
      startTime?: string;
      endTime?: string;
      timeZone?: string;
      colorId?: string;
      calendarId?: string;
    },
  ) {
    return await this.googleCalendarService.updateEvent(
      dto.accessToken,
      eventId,
      {
        summary: dto.summary,
        description: dto.description,
        startTime: dto.startTime ? new Date(dto.startTime) : undefined,
        endTime: dto.endTime ? new Date(dto.endTime) : undefined,
        timeZone: dto.timeZone,
        colorId: dto.colorId,
      },
      dto.calendarId,
    );
  }

  /**
   * Delete a calendar event
   */
  @Post('google-calendar/events/:eventId/delete')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async deleteCalendarEvent(
    @Param('eventId') eventId: string,
    @Body() dto: FetchPagesDto & { calendarId?: string },
  ) {
    await this.googleCalendarService.deleteEvent(
      dto.accessToken,
      eventId,
      dto.calendarId,
    );
    return { success: true };
  }

  /**
   * Get a specific calendar event
   */
  @Post('google-calendar/events/:eventId')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async getCalendarEvent(
    @Param('eventId') eventId: string,
    @Body() dto: FetchPagesDto & { calendarId?: string },
  ) {
    return await this.googleCalendarService.getEvent(
      dto.accessToken,
      eventId,
      dto.calendarId,
    );
  }

  /**
   * Mark a calendar event as published
   */
  @Post('google-calendar/events/:eventId/published')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async markEventPublished(
    @Param('eventId') eventId: string,
    @Body() dto: FetchPagesDto & { calendarId?: string },
  ) {
    return await this.googleCalendarService.markEventAsPublished(
      dto.accessToken,
      eventId,
      dto.calendarId,
    );
  }

  /**
   * Mark a calendar event as failed
   */
  @Post('google-calendar/events/:eventId/failed')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async markEventFailed(
    @Param('eventId') eventId: string,
    @Body() dto: FetchPagesDto & { calendarId?: string },
  ) {
    return await this.googleCalendarService.markEventAsFailed(
      dto.accessToken,
      eventId,
      dto.calendarId,
    );
  }

  /**
   * Verify Google Calendar access
   */
  @Post('google-calendar/verify')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async verifyCalendarAccess(@Body() dto: FetchPagesDto) {
    const hasAccess = await this.googleCalendarService.verifyAccess(dto.accessToken);
    return { hasAccess };
  }

  // ==========================================================================
  // OneDrive Endpoints
  // ==========================================================================

  /**
   * Connect OneDrive account
   */
  @Post('workspaces/:workspaceId/onedrive/connect')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async connectOneDrive(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: { userId: string; email: string },
    @Body() dto: FetchPagesDto & { refreshToken?: string; tokenExpiresAt?: string },
  ) {
    // Decode tokens in case they're URL-encoded
    const accessToken = decodeURIComponent(dto.accessToken);
    const refreshToken = dto.refreshToken ? decodeURIComponent(dto.refreshToken) : undefined;

    // Get OneDrive user info
    const driveInfo = await this.oneDriveService.getUserInfo(accessToken);

    // Create the OneDrive channel
    const channel = await this.channelService.createChannel(
      workspaceId,
      user.userId,
      {
        platform: 'onedrive',
        accountType: 'storage',
        platformAccountId: driveInfo.id,
        accountName: driveInfo.owner?.user?.displayName || 'OneDrive',
        username: driveInfo.owner?.user?.email || undefined,
        accessToken: accessToken,
        refreshToken: refreshToken,
        tokenExpiresAt: dto.tokenExpiresAt,
        permissions: PLATFORM_CONFIG.onedrive.oauthScopes,
        capabilities: {
          canPost: false,
          canSchedule: false,
          canReadAnalytics: false,
          canReply: false,
          canDelete: false,
          supportedMediaTypes: ['image', 'video', 'document'],
          maxMediaPerPost: 0,
          maxTextLength: 0,
        },
        metadata: {
          driveType: driveInfo.driveType,
          quota: driveInfo.quota,
        },
      },
    );

    return {
      channel,
      message: 'OneDrive connected successfully',
    };
  }

  /**
   * Get OneDrive user info
   */
  @Post('onedrive/me')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async getOneDriveUserInfo(@Body() dto: FetchPagesDto) {
    return await this.oneDriveService.getUserInfo(dto.accessToken);
  }

  /**
   * List media files from OneDrive (images and videos)
   */
  @Post('onedrive/media')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async listOneDriveMedia(
    @Body() dto: FetchPagesDto & {
      folderId?: string;
      pageSize?: number;
      nextLink?: string;
    },
  ) {
    return await this.oneDriveService.listMedia(dto.accessToken, {
      folderId: dto.folderId,
      pageSize: dto.pageSize,
      nextLink: dto.nextLink,
    });
  }

  /**
   * List images from OneDrive
   */
  @Post('onedrive/images')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async listOneDriveImages(
    @Body() dto: FetchPagesDto & {
      folderId?: string;
      pageSize?: number;
      nextLink?: string;
    },
  ) {
    return await this.oneDriveService.listImages(dto.accessToken, {
      folderId: dto.folderId,
      pageSize: dto.pageSize,
      nextLink: dto.nextLink,
    });
  }

  /**
   * List videos from OneDrive
   */
  @Post('onedrive/videos')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async listOneDriveVideos(
    @Body() dto: FetchPagesDto & {
      folderId?: string;
      pageSize?: number;
      nextLink?: string;
    },
  ) {
    return await this.oneDriveService.listVideos(dto.accessToken, {
      folderId: dto.folderId,
      pageSize: dto.pageSize,
      nextLink: dto.nextLink,
    });
  }

  /**
   * List folders from OneDrive
   */
  @Post('onedrive/folders')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async listOneDriveFolders(
    @Body() dto: FetchPagesDto & {
      parentId?: string;
      pageSize?: number;
      nextLink?: string;
    },
  ) {
    return await this.oneDriveService.listFolders(dto.accessToken, {
      parentId: dto.parentId,
      pageSize: dto.pageSize,
      nextLink: dto.nextLink,
    });
  }

  /**
   * Search OneDrive files
   */
  @Post('onedrive/search')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async searchOneDrive(
    @Body() dto: FetchPagesDto & {
      query: string;
      pageSize?: number;
      nextLink?: string;
    },
  ) {
    return await this.oneDriveService.searchFiles(dto.accessToken, dto.query, {
      pageSize: dto.pageSize,
      nextLink: dto.nextLink,
    });
  }

  /**
   * Get a specific item from OneDrive
   */
  @Post('onedrive/item/:itemId')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async getOneDriveItem(
    @Param('itemId') itemId: string,
    @Body() dto: FetchPagesDto,
  ) {
    return await this.oneDriveService.getItem(dto.accessToken, itemId);
  }

  /**
   * Get download URL for a OneDrive file
   */
  @Post('onedrive/download-url/:itemId')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async getOneDriveDownloadUrl(
    @Param('itemId') itemId: string,
    @Body() dto: FetchPagesDto,
  ) {
    const url = await this.oneDriveService.getDownloadUrl(dto.accessToken, itemId);
    return { downloadUrl: url };
  }

  /**
   * Verify OneDrive access
   */
  @Post('onedrive/verify')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async verifyOneDriveAccess(@Body() dto: FetchPagesDto) {
    const hasAccess = await this.oneDriveService.verifyAccess(dto.accessToken);
    return { hasAccess };
  }

  // ==========================================================================
  // Dropbox Endpoints
  // ==========================================================================

  /**
   * Connect Dropbox account
   */
  @Post('workspaces/:workspaceId/dropbox/connect')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async connectDropbox(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: { userId: string; email: string },
    @Body() dto: FetchPagesDto & { refreshToken?: string; tokenExpiresAt?: string },
  ) {
    // Decode tokens in case they're URL-encoded
    const accessToken = decodeURIComponent(dto.accessToken);
    const refreshToken = dto.refreshToken ? decodeURIComponent(dto.refreshToken) : undefined;

    // Get Dropbox user info
    const dropboxUser = await this.dropboxService.getUserInfo(accessToken);

    // Create the Dropbox channel
    const channel = await this.channelService.createChannel(
      workspaceId,
      user.userId,
      {
        platform: 'dropbox',
        accountType: 'storage',
        platformAccountId: dropboxUser.account_id,
        accountName: dropboxUser.name?.display_name || 'Dropbox',
        username: dropboxUser.email || undefined,
        profilePictureUrl: dropboxUser.profile_photo_url || undefined,
        accessToken: accessToken,
        refreshToken: refreshToken,
        tokenExpiresAt: dto.tokenExpiresAt,
        permissions: PLATFORM_CONFIG.dropbox.oauthScopes,
        capabilities: {
          canPost: false,
          canSchedule: false,
          canReadAnalytics: false,
          canReply: false,
          canDelete: false,
          supportedMediaTypes: ['image', 'video', 'document'],
          maxMediaPerPost: 0,
          maxTextLength: 0,
        },
        metadata: {
          email: dropboxUser.email,
          emailVerified: dropboxUser.email_verified,
          country: dropboxUser.country,
        },
      },
    );

    return {
      channel,
      message: 'Dropbox connected successfully',
    };
  }

  /**
   * Get Dropbox user info
   */
  @Post('dropbox/me')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async getDropboxUserInfo(@Body() dto: FetchPagesDto) {
    return await this.dropboxService.getUserInfo(dto.accessToken);
  }

  /**
   * Get Dropbox space usage
   */
  @Post('dropbox/space')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async getDropboxSpaceUsage(@Body() dto: FetchPagesDto) {
    return await this.dropboxService.getSpaceUsage(dto.accessToken);
  }

  /**
   * List files and folders from Dropbox
   */
  @Post('dropbox/list')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async listDropboxFolder(
    @Body() dto: FetchPagesDto & {
      path?: string;
      limit?: number;
      cursor?: string;
      recursive?: boolean;
    },
  ) {
    return await this.dropboxService.listFolder(dto.accessToken, {
      path: dto.path,
      limit: dto.limit,
      cursor: dto.cursor,
      recursive: dto.recursive,
    });
  }

  /**
   * List media files from Dropbox (images and videos)
   */
  @Post('dropbox/media')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async listDropboxMedia(
    @Body() dto: FetchPagesDto & {
      path?: string;
      limit?: number;
      cursor?: string;
    },
  ) {
    return await this.dropboxService.listMedia(dto.accessToken, {
      path: dto.path,
      limit: dto.limit,
      cursor: dto.cursor,
    });
  }

  /**
   * List images from Dropbox
   */
  @Post('dropbox/images')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async listDropboxImages(
    @Body() dto: FetchPagesDto & {
      path?: string;
      limit?: number;
      cursor?: string;
    },
  ) {
    return await this.dropboxService.listImages(dto.accessToken, {
      path: dto.path,
      limit: dto.limit,
      cursor: dto.cursor,
    });
  }

  /**
   * List videos from Dropbox
   */
  @Post('dropbox/videos')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async listDropboxVideos(
    @Body() dto: FetchPagesDto & {
      path?: string;
      limit?: number;
      cursor?: string;
    },
  ) {
    return await this.dropboxService.listVideos(dto.accessToken, {
      path: dto.path,
      limit: dto.limit,
      cursor: dto.cursor,
    });
  }

  /**
   * List folders from Dropbox
   */
  @Post('dropbox/folders')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async listDropboxFolders(
    @Body() dto: FetchPagesDto & {
      path?: string;
      limit?: number;
      cursor?: string;
    },
  ) {
    return await this.dropboxService.listFolders(dto.accessToken, {
      path: dto.path,
      limit: dto.limit,
      cursor: dto.cursor,
    });
  }

  /**
   * Search Dropbox files
   */
  @Post('dropbox/search')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async searchDropbox(
    @Body() dto: FetchPagesDto & {
      query: string;
      path?: string;
      maxResults?: number;
      cursor?: string;
      fileExtensions?: string[];
    },
  ) {
    return await this.dropboxService.searchFiles(dto.accessToken, dto.query, {
      path: dto.path,
      maxResults: dto.maxResults,
      cursor: dto.cursor,
      fileExtensions: dto.fileExtensions,
    });
  }

  /**
   * Get metadata for a Dropbox file or folder
   */
  @Post('dropbox/metadata')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async getDropboxMetadata(
    @Body() dto: FetchPagesDto & { path: string },
  ) {
    return await this.dropboxService.getMetadata(dto.accessToken, dto.path);
  }

  /**
   * Get temporary download link for a Dropbox file
   */
  @Post('dropbox/download-link')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async getDropboxDownloadLink(
    @Body() dto: FetchPagesDto & { path: string },
  ) {
    const link = await this.dropboxService.getTemporaryLink(dto.accessToken, dto.path);
    return { downloadLink: link };
  }

  /**
   * Verify Dropbox access
   */
  @Post('dropbox/verify')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async verifyDropboxAccess(@Body() dto: FetchPagesDto) {
    const hasAccess = await this.dropboxService.verifyAccess(dto.accessToken);
    return { hasAccess };
  }
}
