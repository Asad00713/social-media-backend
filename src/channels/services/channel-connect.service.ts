import { Injectable, Logger } from '@nestjs/common';
import { PLATFORM_CONFIG } from '../../drizzle/schema/channels.schema';
import { AdAccountsService } from '../../ads/services/ad-accounts.service';
import type { ChannelResponseDto } from '../dto/channel.dto';
import { ChannelService, type CreateChannelOptions } from './channel.service';
import { FacebookService } from './facebook.service';
import { InstagramService } from './instagram.service';
import { LinkedInService } from './linkedin.service';
import { PinterestService } from './pinterest.service';
import { YouTubeService } from './youtube.service';

/** The tokens an OAuth exchange handed back for a single-account platform. */
export interface ConnectTokens {
  accessToken: string;
  refreshToken?: string;
  tokenExpiresAt?: string;
}

export interface ConnectFacebookPageInput {
  /** The signed-in Facebook USER's token; the Page tokens come from it. */
  userAccessToken: string;
  includeInstagram?: boolean;
  /** 'ads' also syncs the user's ad accounts onto the Facebook channel. */
  intent?: 'connect' | 'ads';
}

export interface ConnectOneFacebookPageInput extends ConnectFacebookPageInput {
  pageId: string;
}

export interface ConnectedFacebookPage {
  facebookChannel: ChannelResponseDto;
  instagramChannel: ChannelResponseDto | null;
}

export interface SettledFacebookPage extends ConnectedFacebookPage {
  /** Why the Instagram channel was not created; null when it was or was not asked for. */
  instagramError: unknown;
}

type FacebookPageWithToken = NonNullable<
  Awaited<ReturnType<FacebookService['getPage']>>
>;

/**
 * Connect a social account into a workspace from a freshly exchanged OAuth
 * token: look the account up on the platform, build the channel, create it.
 *
 * This is the per-platform connect logic that used to sit inside
 * `ChannelsController` (the `workspaces/:id/<platform>/connect` routes). It
 * takes plain ids and tokens - no request, no JWT user - so the signed-in
 * routes and the public connect-link flow share it. The caller is
 * responsible for authorisation; `options.connectLink` marks the channels as
 * added through a link (see `ChannelService.createChannel`).
 */
@Injectable()
export class ChannelConnectService {
  private readonly logger = new Logger(ChannelConnectService.name);

  constructor(
    private readonly channelService: ChannelService,
    private readonly facebookService: FacebookService,
    private readonly instagramService: InstagramService,
    private readonly pinterestService: PinterestService,
    private readonly youtubeService: YouTubeService,
    private readonly linkedinService: LinkedInService,
    private readonly adAccountsService: AdAccountsService,
  ) {}

  // ==========================================================================
  // Facebook Pages (+ the Instagram account linked to each)
  // ==========================================================================

  /**
   * The Pages the Facebook user manages, with their linked Instagram account.
   * Never returns a Page Access Token.
   */
  async listFacebookPages(userAccessToken: string) {
    const pages = await this.facebookService.getUserPages(userAccessToken);

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
   * Connect one Facebook Page as a channel, and its Instagram business
   * account too when asked for and the Page has one. An Instagram failure is
   * rethrown as it always was (the team dialog shows it), but only after the
   * Page channel's webhooks were subscribed.
   */
  async connectFacebookPage(
    workspaceId: string,
    userId: string,
    input: ConnectOneFacebookPageInput,
    options?: CreateChannelOptions,
  ): Promise<ConnectedFacebookPage> {
    const { facebookChannel, instagramChannel, instagramError } =
      await this.connectFacebookPageSettled(
        workspaceId,
        userId,
        input,
        options,
      );
    if (instagramError !== null) {
      // Rethrown as it came (an HttpException keeps its status and code); a
      // thrown non-Error is wrapped so callers always get an Error.
      throw instagramError instanceof Error
        ? instagramError
        : new Error(
            typeof instagramError === 'string'
              ? instagramError
              : 'Instagram connect failed',
          );
    }
    return { facebookChannel, instagramChannel };
  }

  /**
   * The same, but once the Page channel is created it is always returned: a
   * failed Instagram step comes back as `instagramError` (already connected,
   * the channel limit, or anything else) instead of losing the Page. A
   * failure before the Page channel exists is thrown.
   */
  async connectFacebookPageSettled(
    workspaceId: string,
    userId: string,
    input: ConnectOneFacebookPageInput,
    options?: CreateChannelOptions,
  ): Promise<SettledFacebookPage> {
    // Get page details with Page Access Token
    const page = await this.facebookService.getPage(
      input.pageId,
      input.userAccessToken,
    );

    if (!page) {
      throw new Error('Failed to fetch page details');
    }

    // Create the Facebook Page channel
    const fbChannel = await this.channelService.createChannel(
      workspaceId,
      userId,
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
      options,
    );

    let igChannel: ChannelResponseDto | null = null;
    // The Page channel exists from here on: an Instagram failure (already
    // connected, the channel limit, anything) must not lose it, so it is
    // handed back instead of thrown, and the Page's webhooks still run.
    let instagramError: unknown = null;

    // If Instagram is connected and user wants it, create Instagram channel too
    if (input.includeInstagram && page.instagramBusinessAccount) {
      const ig = page.instagramBusinessAccount;

      try {
        igChannel = await this.createInstagramForPage(
          workspaceId,
          userId,
          page,
          ig,
          options,
        );
      } catch (err) {
        instagramError = err;
      }
    }

    await this.afterFacebookPageConnected(
      workspaceId,
      input,
      page,
      fbChannel,
      igChannel,
    );

    return {
      facebookChannel: fbChannel,
      instagramChannel: igChannel,
      instagramError,
    };
  }

  private createInstagramForPage(
    workspaceId: string,
    userId: string,
    page: FacebookPageWithToken,
    ig: NonNullable<FacebookPageWithToken['instagramBusinessAccount']>,
    options?: CreateChannelOptions,
  ): Promise<ChannelResponseDto> {
    return this.channelService.createChannel(
      workspaceId,
      userId,
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
          maxMediaPerPost: 20, // Instagram carousel cap
          maxTextLength: 2200,
        },
        metadata: {
          followersCount: ig.followersCount,
          mediaCount: ig.mediaCount,
          biography: ig.biography,
          linkedFacebookPageId: page.id,
        },
      },
      options,
    );
  }

  /** Webhooks and the ads sync for a Page channel that now exists. */
  private async afterFacebookPageConnected(
    workspaceId: string,
    input: ConnectOneFacebookPageInput,
    page: FacebookPageWithToken,
    fbChannel: ChannelResponseDto,
    igChannel: ChannelResponseDto | null,
  ): Promise<void> {
    // Phase 2.3 — Auto-subscribe both FB Page + (if connected) IG account to
    // their respective Meta webhook channels right after OAuth. Without this,
    // events only arrive via polling (30 s lag); with it, DMs + comments
    // arrive in <2 s. The subscribe calls are idempotent and best-effort so
    // a webhook failure doesn't block the connect flow.
    //
    // We use `page.accessToken` directly (the FB Page Access Token from the
    // OAuth flow) — the channelService response DTO strips the encrypted
    // token, but the IG account uses the SAME Page Access Token as its FB
    // parent, so one variable covers both subscribes.
    try {
      await this.facebookService.subscribePageToWebhooks(
        page.id,
        page.accessToken,
        [
          'feed',
          'messages',
          'messaging_postbacks',
          'message_deliveries',
          'message_reads',
          'message_reactions',
          'message_echoes',
          'message_edits',
        ],
      );
    } catch (err) {
      this.logger.warn(
        `FB webhook auto-subscribe failed for page=${page.id}: ${(err as Error).message}`,
      );
    }

    if (igChannel && page.instagramBusinessAccount) {
      try {
        await this.instagramService.subscribeAccountToWebhooks(
          page.instagramBusinessAccount.id,
          page.accessToken,
          ['comments', 'messages', 'messaging_postbacks', 'message_reactions'],
        );
      } catch (err) {
        this.logger.warn(
          `IG webhook auto-subscribe failed for ig=${page.instagramBusinessAccount.id}: ${(err as Error).message}`,
        );
      }
    }

    // Fire-and-forget ad account sync when intent=ads OAuth flow completes.
    // Errors are logged but never propagate — we don't want a Meta API hiccup
    // to fail the channel connect response. The user access token is required
    // to read /me/adaccounts (Page-scoped tokens can't); pass it through here
    // so the sync uses it and also caches it on the channel for later manual
    // refreshes.
    if (input.intent === 'ads') {
      this.adAccountsService
        .syncForChannel(workspaceId, fbChannel.id, input.userAccessToken)
        .catch((err: Error) => {
          this.logger.warn(
            `Ad account sync failed for workspace=${workspaceId}, channel=${fbChannel.id}: ${err.message}`,
          );
        });
    }
  }

  // ==========================================================================
  // Pinterest / YouTube / LinkedIn
  // ==========================================================================

  /** Look up the Pinterest account and connect it as a channel. */
  async connectPinterest(
    workspaceId: string,
    userId: string,
    tokens: ConnectTokens,
    options?: CreateChannelOptions,
  ): Promise<ChannelResponseDto> {
    // Get Pinterest user info
    const pinterestUser = await this.pinterestService.getCurrentUser(
      tokens.accessToken,
    );

    // Create the Pinterest channel
    return this.channelService.createChannel(
      workspaceId,
      userId,
      {
        platform: 'pinterest',
        accountType:
          pinterestUser.accountType === 'BUSINESS'
            ? 'business_account'
            : 'profile',
        platformAccountId: pinterestUser.id,
        accountName: pinterestUser.businessName || pinterestUser.username,
        username: pinterestUser.username,
        profilePictureUrl: pinterestUser.profileImage || undefined,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        tokenExpiresAt: tokens.tokenExpiresAt,
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
      options,
    );
  }

  /** Look up the YouTube channel and connect it as a channel. */
  async connectYouTube(
    workspaceId: string,
    userId: string,
    tokens: ConnectTokens,
    options?: CreateChannelOptions,
  ): Promise<ChannelResponseDto> {
    // Get YouTube channel info
    const youtubeChannel = await this.youtubeService.getCurrentChannel(
      tokens.accessToken,
    );

    // Create the YouTube channel
    return this.channelService.createChannel(
      workspaceId,
      userId,
      {
        platform: 'youtube',
        accountType: 'channel',
        platformAccountId: youtubeChannel.id,
        accountName: youtubeChannel.title,
        username: youtubeChannel.customUrl || undefined,
        profilePictureUrl: youtubeChannel.thumbnailUrl || undefined,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        tokenExpiresAt: tokens.tokenExpiresAt,
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
      options,
    );
  }

  /** Look up the LinkedIn profile and connect it as a channel. */
  async connectLinkedIn(
    workspaceId: string,
    userId: string,
    tokens: ConnectTokens,
    options?: CreateChannelOptions,
  ): Promise<ChannelResponseDto> {
    // Get LinkedIn profile info
    const linkedinProfile = await this.linkedinService.getCurrentUser(
      tokens.accessToken,
    );

    // Create the LinkedIn channel
    return this.channelService.createChannel(
      workspaceId,
      userId,
      {
        platform: 'linkedin',
        accountType: 'profile',
        platformAccountId: linkedinProfile.id,
        accountName: linkedinProfile.fullName,
        username: linkedinProfile.vanityName || undefined,
        profilePictureUrl: linkedinProfile.profilePictureUrl || undefined,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        tokenExpiresAt: tokens.tokenExpiresAt,
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
      options,
    );
  }
}
