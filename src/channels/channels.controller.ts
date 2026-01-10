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
import { SupportedPlatform, PLATFORM_CONFIG } from '../drizzle/schema/channels.schema';

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
        const errorUrl = `${backendUrl}/channels/connect/error?error=${encodeURIComponent(error)}&description=${encodeURIComponent(errorDescription || '')}`;
        return res.redirect(errorUrl);
      }

      // Check for Facebook-specific error format (error_code, error_message)
      if (errorCode || errorMessage) {
        console.log(`[OAuth Callback] Facebook error: code=${errorCode}, message=${errorMessage}`);
        const errorUrl = `${backendUrl}/channels/connect/error?error=${encodeURIComponent(errorCode || 'facebook_error')}&description=${encodeURIComponent(errorMessage || 'Unknown Facebook error')}`;
        return res.redirect(errorUrl);
      }

      // Check if state is missing
      if (!state) {
        console.log('[OAuth Callback] ERROR: State token is missing from callback');
        const errorUrl = `${backendUrl}/channels/connect/error?error=${encodeURIComponent('State token missing')}&description=${encodeURIComponent('Facebook did not return the state parameter. This may be a configuration issue.')}`;
        return res.redirect(errorUrl);
      }

      // Validate state and get stored data
      console.log(`[OAuth Callback] Validating state token...`);
      const stateData = await this.oauthService.validateState(state);
      console.log(`[OAuth Callback] State validated successfully for workspace: ${stateData.workspaceId}`);

      // Exchange code for tokens
      const tokens = await this.oauthService.exchangeCodeForTokens(
        platform as SupportedPlatform,
        code,
        stateData.codeVerifier,
      );

      // Calculate token expiration
      let tokenExpiresAt: Date | null = null;
      if (tokens.expiresIn) {
        tokenExpiresAt = new Date();
        tokenExpiresAt.setSeconds(tokenExpiresAt.getSeconds() + tokens.expiresIn);
      }

      // Redirect to frontend with success and tokens
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
      const errorUrl = `${backendUrl}/channels/connect/error?error=${encodeURIComponent(err.message || 'Unknown error')}&description=${encodeURIComponent('State token: ' + (state ? state.substring(0, 10) + '...' : 'missing'))}`;
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
    @Body() dto: FetchPagesDto,
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
    @Body() dto: FetchPagesDto,
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
    @Body() dto: FetchPagesDto,
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
    @Body() dto: FetchPagesDto,
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
   */
  @Post('workspaces/:workspaceId/twitter/connect')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async connectTwitter(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: { userId: string; email: string },
    @Body() dto: FetchPagesDto,
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

    return {
      channel,
      message: 'Twitter account connected successfully',
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
   * Get Instagram account info
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
}
