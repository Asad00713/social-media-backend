import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  ConflictException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { OAuthService } from './oauth.service';
import { ChannelSyncLifecycleService } from '../analytics/services/channel-sync-lifecycle.service';
import { eq, and, desc, asc, sql } from 'drizzle-orm';
import { db } from '../../drizzle/db';
import {
  socialMediaChannels,
  channelRelationships,
  tokenRefreshLogs,
  oauthStates,
  NewSocialMediaChannel,
  NewChannelRelationship,
  NewTokenRefreshLog,
  SupportedPlatform,
  PLATFORM_CONFIG,
  ConnectionStatus,
  getRefreshTokenTtlDays,
} from '../../drizzle/schema/channels.schema';
import { workspaceUsage } from '../../drizzle/schema';
import { channelSyncState } from '../../drizzle/schema/channel-sync-state.schema';
import { posts, type PostTarget } from '../../drizzle/schema/posts.schema';
import {
  encrypt,
  decrypt,
  maskSensitiveData,
} from '../../common/utils/encryption.util';
import {
  CreateChannelDto,
  UpdateChannelDto,
  UpdateTokensDto,
  ChannelResponseDto,
  ChannelQueryDto,
  ChannelStatsResponseDto,
} from '../dto/channel.dto';

@Injectable()
export class ChannelService {
  private readonly logger = new Logger(ChannelService.name);

  // Buffer time before expiration to trigger refresh (5 minutes)
  private readonly TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

  constructor(
    @Inject(forwardRef(() => OAuthService))
    private readonly oauthService: OAuthService,
    private readonly syncLifecycle: ChannelSyncLifecycleService,
  ) {}

  // ==========================================================================
  // Channel CRUD Operations
  // ==========================================================================

  /**
   * Create a new channel (after OAuth callback)
   */
  async createChannel(
    workspaceId: string,
    userId: string,
    dto: CreateChannelDto,
  ): Promise<ChannelResponseDto> {
    // Check for duplicate
    const existing = await db
      .select()
      .from(socialMediaChannels)
      .where(
        and(
          eq(socialMediaChannels.workspaceId, workspaceId),
          eq(socialMediaChannels.platform, dto.platform),
          eq(socialMediaChannels.platformAccountId, dto.platformAccountId),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      const existingChannel = existing[0];

      // Genuine duplicate: channel is healthy — protect against double-connect
      const tokenStillValid =
        !existingChannel.tokenExpiresAt ||
        new Date(existingChannel.tokenExpiresAt).getTime() > Date.now();

      const isHealthyConnection =
        existingChannel.connectionStatus === 'connected' &&
        existingChannel.isActive &&
        tokenStillValid;

      if (isHealthyConnection) {
        throw new ConflictException(
          `This ${dto.platform} account is already connected to this workspace`,
        );
      }

      // Reconnect path: channel exists but is in a broken/inactive state
      // Update tokens, status, and profile metadata without touching identity fields
      const reconnectData: Record<string, any> = {
        accessToken: encrypt(dto.accessToken),
        accountName: dto.accountName,
        connectionStatus: 'connected' as ConnectionStatus,
        lastError: null,
        isActive: true,
        updatedAt: new Date(),
      };

      if (dto.refreshToken) {
        reconnectData.refreshToken = encrypt(dto.refreshToken);
        reconnectData.refreshTokenIssuedAt = new Date();
      }
      if (dto.tokenExpiresAt) {
        reconnectData.tokenExpiresAt = new Date(dto.tokenExpiresAt);
      }
      if (dto.tokenScope !== undefined) {
        reconnectData.tokenScope = dto.tokenScope;
      }
      if (dto.permissions !== undefined) {
        reconnectData.permissions = dto.permissions;
      }
      if (dto.capabilities !== undefined) {
        reconnectData.capabilities = dto.capabilities;
      }
      if (dto.metadata !== undefined) {
        reconnectData.metadata = dto.metadata;
      }
      if (dto.username !== undefined) {
        reconnectData.username = dto.username;
      }
      if (dto.profilePictureUrl !== undefined) {
        reconnectData.profilePictureUrl = dto.profilePictureUrl;
      }

      const updated = await db
        .update(socialMediaChannels)
        .set(reconnectData)
        .where(eq(socialMediaChannels.id, existingChannel.id))
        .returning();

      // Re-fire lifecycle hook to reset sync state and enqueue fresh backfill
      await this.syncLifecycle.onChannelConnected(
        existingChannel.id,
        workspaceId,
      );

      this.logger.log(
        `Reconnected ${dto.platform} channel ${existingChannel.id} for workspace ${workspaceId}`,
      );

      return this.toResponseDto(updated[0]);
    }

    // No existing row — enforce channel limit before creating a new slot
    await this.enforceChannelLimit(workspaceId);

    // Get platform config for defaults
    const platformConfig = PLATFORM_CONFIG[dto.platform];

    // Get max display order for this workspace
    const maxOrderResult = await db
      .select({ maxOrder: sql<number>`COALESCE(MAX(display_order), 0)` })
      .from(socialMediaChannels)
      .where(eq(socialMediaChannels.workspaceId, workspaceId));

    const nextOrder = (maxOrderResult[0]?.maxOrder || 0) + 1;

    // Create channel with encrypted tokens
    // Build channel data, conditionally adding optional fields to avoid Drizzle null errors
    const newChannel: any = {
      workspaceId,
      platform: dto.platform,
      accountType: dto.accountType,
      platformAccountId: dto.platformAccountId,
      accountName: dto.accountName,
      accessToken: encrypt(dto.accessToken),
      permissions: dto.permissions || [],
      capabilities: dto.capabilities || {
        canPost: true,
        canSchedule: true,
        canReadAnalytics: true,
        canReply: false,
        canDelete: false,
        supportedMediaTypes: platformConfig?.supportedMediaTypes || [],
        maxMediaPerPost: platformConfig?.maxMediaPerPost || 1,
        maxTextLength: platformConfig?.maxTextLength || 280,
      },
      isActive: true,
      connectionStatus: 'connected',
      metadata: dto.metadata || {},
      connectedByUserId: userId,
      displayOrder: nextOrder,
      timezone: dto.timezone || 'UTC',
    };
    if (dto.username) newChannel.username = dto.username;
    if (dto.profilePictureUrl)
      newChannel.profilePictureUrl = dto.profilePictureUrl;
    if (dto.refreshToken) {
      newChannel.refreshToken = encrypt(dto.refreshToken);
      newChannel.refreshTokenIssuedAt = new Date();
    }
    if (dto.tokenExpiresAt)
      newChannel.tokenExpiresAt = new Date(dto.tokenExpiresAt);
    if (dto.tokenScope) newChannel.tokenScope = dto.tokenScope;
    if (dto.color) newChannel.color = dto.color;
    if (dto.telegramWebhookRouteId !== undefined) {
      newChannel.telegramWebhookRouteId = dto.telegramWebhookRouteId ?? null;
    }

    const inserted = await db
      .insert(socialMediaChannels)
      .values(newChannel)
      .returning();

    // Update workspace usage count
    await this.incrementChannelCount(workspaceId);

    // Initialize sync state and enqueue initial backfill
    await this.syncLifecycle.onChannelConnected(inserted[0].id, workspaceId);

    // Re-link orphaned post targets from any previously-deleted channel of
    // the same platform in this workspace. Without this, disconnect+reconnect
    // breaks every downstream feature that joins on targets[].channelId
    // (inbox poll, analytics, etc) because the IDs no longer match.
    await this.migrateOrphanedPostTargets(
      workspaceId,
      dto.platform,
      inserted[0].id,
      dto.platformAccountId,
    );

    this.logger.log(
      `Created ${dto.platform} channel for workspace ${workspaceId}: ${dto.accountName}`,
    );

    return this.toResponseDto(inserted[0]);
  }

  /**
   * After a channel is (re-)created, find every `posts.targets[]` entry in
   * this workspace that references the SAME platform but a now-deleted
   * `channelId`, and re-point it at the new channel id.
   *
   * Background: disconnect does a hard `DELETE` on the channel row, and the
   * subsequent reconnect inserts a brand-new row with a fresh bigserial id.
   * Posts published before the disconnect still carry the old id in their
   * JSONB `targets`. Without this migration, the inbox poller (and analytics
   * snapshotter, and anything else that joins via `targets[].channelId`)
   * finds zero historical posts after a reconnect.
   *
   * For Bluesky we additionally verify the DID in the AT URI matches the new
   * channel's platformAccountId — that's a precise account-equality check.
   * For other platforms the platformPostId doesn't encode account info, so we
   * fall back to a workspace+platform match (acceptable trade-off: only fails
   * if the user disconnected account A and connected a DIFFERENT account B
   * on the same platform, a rare flow).
   */
  private async migrateOrphanedPostTargets(
    workspaceId: string,
    platform: SupportedPlatform,
    newChannelId: number,
    newPlatformAccountId: string,
  ): Promise<void> {
    // Find live channel ids of this platform — anything else in targets[] for
    // this platform that isn't in this set is "orphaned".
    const liveChannels = await db
      .select({ id: socialMediaChannels.id })
      .from(socialMediaChannels)
      .where(
        and(
          eq(socialMediaChannels.workspaceId, workspaceId),
          eq(socialMediaChannels.platform, platform),
        ),
      );
    const liveIds = new Set(liveChannels.map((c) => String(c.id)));

    // Pull candidate posts (anything in this workspace published in last 60d
    // — wider than the poll window so we catch slightly older content too).
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    const candidates = await db
      .select({
        id: posts.id,
        targets: posts.targets,
      })
      .from(posts)
      .where(
        and(
          eq(posts.workspaceId, workspaceId),
          // jsonb-contains: at least one target on this platform
          sql`${posts.targets} @> ${JSON.stringify([{ platform }])}::jsonb`,
          // limit to posts published in window
          sql`(${posts.publishedAt} IS NULL OR ${posts.publishedAt} >= ${sixtyDaysAgo})`,
        ),
      );

    let updated = 0;
    for (const post of candidates) {
      const targets = post.targets ?? [];
      let dirty = false;
      const next: PostTarget[] = targets.map((t) => {
        if (t.platform !== platform) return t;
        if (liveIds.has(String(t.channelId))) return t; // already live
        // Bluesky-specific: verify DID match before re-linking. For other
        // platforms we trust the workspace+platform scope.
        if (platform === 'bluesky' && t.platformPostId) {
          const didMatch = t.platformPostId.match(/^at:\/\/(did:[^/]+)\//);
          if (didMatch && didMatch[1] !== newPlatformAccountId) {
            return t; // different DID, don't claim
          }
        }
        dirty = true;
        return { ...t, channelId: String(newChannelId) };
      });
      if (!dirty) continue;
      await db
        .update(posts)
        .set({ targets: next, updatedAt: new Date() })
        .where(eq(posts.id, post.id));
      updated += 1;
    }

    if (updated > 0) {
      this.logger.log(
        `Re-linked ${updated} orphaned post target(s) on workspace ${workspaceId} to ${platform} channel ${newChannelId}`,
      );
    }
  }

  /**
   * Find a channel by platform + platformAccountId across ALL workspaces.
   * Used for global bot-uniqueness enforcement (e.g. Telegram custom bots).
   */
  async findChannelByPlatformAccountGlobal(
    platform: string,
    platformAccountId: string,
  ): Promise<{ id: number } | null> {
    const [row] = await db
      .select({ id: socialMediaChannels.id })
      .from(socialMediaChannels)
      .where(
        and(
          eq(socialMediaChannels.platform, platform as any),
          eq(socialMediaChannels.platformAccountId, platformAccountId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * Every channel row (across ALL workspaces) that holds this platform account.
   * Used by WhatsApp Embedded Signup to reject connecting a phone number that
   * another workspace already owns (webhook routing is keyed on the account id).
   */
  async findChannelsByPlatformAccountAllWorkspaces(
    platform: SupportedPlatform,
    platformAccountId: string,
  ): Promise<Array<{ id: number; workspaceId: string }>> {
    return db
      .select({
        id: socialMediaChannels.id,
        workspaceId: socialMediaChannels.workspaceId,
      })
      .from(socialMediaChannels)
      .where(
        and(
          eq(socialMediaChannels.platform, platform),
          eq(socialMediaChannels.platformAccountId, platformAccountId),
        ),
      )
      .orderBy(asc(socialMediaChannels.id));
  }

  /**
   * Get all channels for a workspace
   */
  async getWorkspaceChannels(
    workspaceId: string,
    query?: ChannelQueryDto,
  ): Promise<ChannelResponseDto[]> {
    const conditions = [eq(socialMediaChannels.workspaceId, workspaceId)];

    if (query?.platform) {
      conditions.push(eq(socialMediaChannels.platform, query.platform));
    }

    if (query?.connectionStatus) {
      conditions.push(
        eq(socialMediaChannels.connectionStatus, query.connectionStatus),
      );
    }

    if (query?.isActive !== undefined) {
      conditions.push(eq(socialMediaChannels.isActive, query.isActive));
    }

    const channels = await db
      .select()
      .from(socialMediaChannels)
      .where(and(...conditions))
      .orderBy(asc(socialMediaChannels.displayOrder));

    return channels.map((ch) => this.toResponseDto(ch));
  }

  /**
   * Get a single channel by ID
   */
  async getChannelById(
    channelId: number,
    workspaceId: string,
  ): Promise<ChannelResponseDto> {
    const channel = await db
      .select()
      .from(socialMediaChannels)
      .where(
        and(
          eq(socialMediaChannels.id, channelId),
          eq(socialMediaChannels.workspaceId, workspaceId),
        ),
      )
      .limit(1);

    if (channel.length === 0) {
      throw new NotFoundException('Channel not found');
    }

    return this.toResponseDto(channel[0]);
  }

  /**
   * Get channel by ID for internal use (includes access token)
   * Use this for posting operations where we need the decrypted token
   */
  async getChannelForPosting(channelId: number): Promise<{
    id: number;
    workspaceId: string;
    platform: SupportedPlatform;
    platformAccountId: string;
    accessToken: string | null;
    refreshToken: string | null;
    accountName: string;
    username: string | null;
    profilePictureUrl: string | null;
    metadata: Record<string, any> | null;
  }> {
    const channel = await db
      .select()
      .from(socialMediaChannels)
      .where(eq(socialMediaChannels.id, channelId))
      .limit(1);

    if (channel.length === 0) {
      throw new NotFoundException('Channel not found');
    }

    const ch = channel[0];

    return {
      id: ch.id,
      workspaceId: ch.workspaceId,
      platform: ch.platform as SupportedPlatform,
      platformAccountId: ch.platformAccountId,
      accessToken: ch.accessToken ? decrypt(ch.accessToken) : null,
      refreshToken: ch.refreshToken ? decrypt(ch.refreshToken) : null,
      accountName: ch.accountName,
      username: ch.username || null,
      profilePictureUrl: ch.profilePictureUrl || null,
      metadata: (ch.metadata as Record<string, any>) || null,
    };
  }

  /**
   * Update channel's last posted timestamp (internal use)
   */
  async updateLastPostedAt(channelId: number): Promise<void> {
    await db
      .update(socialMediaChannels)
      .set({
        lastPostedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(socialMediaChannels.id, channelId));
  }

  /**
   * Update channel tokens (internal use for token refresh)
   */
  async updateChannelTokens(
    channelId: number,
    accessToken: string,
    refreshToken?: string,
  ): Promise<void> {
    const updateData: Partial<typeof socialMediaChannels.$inferInsert> = {
      accessToken: encrypt(accessToken),
      updatedAt: new Date(),
    };

    if (refreshToken) {
      updateData.refreshToken = encrypt(refreshToken);
    }

    await db
      .update(socialMediaChannels)
      .set(updateData)
      .where(eq(socialMediaChannels.id, channelId));
  }

  /**
   * Update a channel
   */
  async updateChannel(
    channelId: number,
    workspaceId: string,
    dto: UpdateChannelDto,
  ): Promise<ChannelResponseDto> {
    const existing = await this.getChannelById(channelId, workspaceId);

    const updateData: Partial<typeof socialMediaChannels.$inferInsert> = {
      updatedAt: new Date(),
    };

    if (dto.accountName !== undefined) updateData.accountName = dto.accountName;
    if (dto.username !== undefined) updateData.username = dto.username;
    if (dto.profilePictureUrl !== undefined)
      updateData.profilePictureUrl = dto.profilePictureUrl;
    if (dto.isActive !== undefined) updateData.isActive = dto.isActive;
    if (dto.displayOrder !== undefined)
      updateData.displayOrder = dto.displayOrder;
    if (dto.timezone !== undefined) updateData.timezone = dto.timezone;
    if (dto.color !== undefined) updateData.color = dto.color;
    if (dto.metadata !== undefined) {
      updateData.metadata = { ...existing.metadata, ...dto.metadata };
    }

    const updated = await db
      .update(socialMediaChannels)
      .set(updateData)
      .where(eq(socialMediaChannels.id, channelId))
      .returning();

    this.logger.log(`Updated channel ${channelId}`);

    return this.toResponseDto(updated[0]);
  }

  /**
   * Delete a channel
   */
  /**
   * Force-reset a channel to 'connected' without OAuth. For cases where
   * the analytics layer wrongly marked a working channel as expired.
   * The next sync attempt will re-flip if the token is actually bad.
   */
  async forceMarkConnected(
    channelId: number,
    workspaceId: string,
  ): Promise<{ success: true; channelId: number }> {
    const [row] = await db
      .select({ id: socialMediaChannels.id })
      .from(socialMediaChannels)
      .where(
        and(
          eq(socialMediaChannels.id, channelId),
          eq(socialMediaChannels.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException('Channel not found');

    await db
      .update(socialMediaChannels)
      .set({ connectionStatus: 'connected', lastError: null })
      .where(eq(socialMediaChannels.id, channelId));

    await db
      .update(channelSyncState)
      .set({ consecutiveFailures: 0 })
      .where(eq(channelSyncState.channelId, channelId));

    return { success: true, channelId };
  }

  async deleteChannel(channelId: number, workspaceId: string): Promise<void> {
    const channel = await db
      .select()
      .from(socialMediaChannels)
      .where(
        and(
          eq(socialMediaChannels.id, channelId),
          eq(socialMediaChannels.workspaceId, workspaceId),
        ),
      )
      .limit(1);

    if (channel.length === 0) {
      throw new NotFoundException('Channel not found');
    }

    // Cancel pending snapshot jobs and null out next-sync window before deletion
    await this.syncLifecycle.onChannelDisconnected(channelId);

    await db
      .delete(socialMediaChannels)
      .where(eq(socialMediaChannels.id, channelId));

    // Update workspace usage count
    await this.decrementChannelCount(workspaceId);

    this.logger.log(
      `Deleted ${channel[0].platform} channel ${channelId} from workspace ${workspaceId}`,
    );
  }

  /**
   * Reorder channels
   */
  async reorderChannels(
    workspaceId: string,
    channelIds: number[],
  ): Promise<void> {
    for (let i = 0; i < channelIds.length; i++) {
      await db
        .update(socialMediaChannels)
        .set({ displayOrder: i + 1, updatedAt: new Date() })
        .where(
          and(
            eq(socialMediaChannels.id, channelIds[i]),
            eq(socialMediaChannels.workspaceId, workspaceId),
          ),
        );
    }

    this.logger.log(`Reordered channels for workspace ${workspaceId}`);
  }

  // ==========================================================================
  // Token Management
  // ==========================================================================

  /**
   * Update tokens for a channel (after refresh)
   */
  async updateTokens(
    channelId: number,
    workspaceId: string,
    dto: UpdateTokensDto,
  ): Promise<void> {
    const channel = await this.getChannelById(channelId, workspaceId);

    const oldExpiresAt = channel.tokenExpiresAt;

    // Build update data, conditionally adding optional fields to avoid Drizzle null errors
    const updateData: any = {
      accessToken: encrypt(dto.accessToken),
      tokenScope: dto.tokenScope,
      connectionStatus: 'connected',
      consecutiveErrors: 0,
      updatedAt: new Date(),
    };
    if (dto.refreshToken) updateData.refreshToken = encrypt(dto.refreshToken);
    if (dto.tokenExpiresAt)
      updateData.tokenExpiresAt = new Date(dto.tokenExpiresAt);

    await db
      .update(socialMediaChannels)
      .set(updateData)
      .where(eq(socialMediaChannels.id, channelId));

    // Log the refresh - build data conditionally
    const refreshLogData: any = {
      channelId,
      status: 'success',
    };
    if (oldExpiresAt) refreshLogData.oldExpiresAt = oldExpiresAt;
    if (dto.tokenExpiresAt)
      refreshLogData.newExpiresAt = new Date(dto.tokenExpiresAt);
    await db
      .insert(tokenRefreshLogs)
      .values(refreshLogData as NewTokenRefreshLog);

    this.logger.log(`Updated tokens for channel ${channelId}`);
  }

  /**
   * Get decrypted access token for a channel (with automatic refresh)
   */
  async getAccessToken(
    channelId: number,
    workspaceId: string,
  ): Promise<string> {
    const channel = await db
      .select()
      .from(socialMediaChannels)
      .where(
        and(
          eq(socialMediaChannels.id, channelId),
          eq(socialMediaChannels.workspaceId, workspaceId),
        ),
      )
      .limit(1);

    if (channel.length === 0) {
      throw new NotFoundException('Channel not found');
    }

    const channelData = channel[0];
    const platform = channelData.platform as SupportedPlatform;
    const platformConfig = PLATFORM_CONFIG[platform];

    // Bluesky has its own session-refresh flow (com.atproto.server.refreshSession,
    // NOT OAuth2). Its accessJwt lives ~2h; we never track tokenExpiresAt for it
    // so the OAuth-style refresh below would never fire. Handle inline.
    if (platform === 'bluesky') {
      return this.getBlueskyAccessToken(channelData);
    }

    // Check if token is expired or about to expire
    const now = new Date();
    const bufferTime = new Date(now.getTime() + this.TOKEN_REFRESH_BUFFER_MS);
    const isExpired =
      channelData.tokenExpiresAt && channelData.tokenExpiresAt < now;
    const isAboutToExpire =
      channelData.tokenExpiresAt && channelData.tokenExpiresAt < bufferTime;

    // If token is expired or about to expire, try to refresh it
    if (
      (isExpired || isAboutToExpire) &&
      channelData.refreshToken &&
      platformConfig?.supportsRefreshToken
    ) {
      this.logger.log(
        `Token for channel ${channelId} (${platform}) is ${isExpired ? 'expired' : 'about to expire'}, attempting refresh...`,
      );

      try {
        const refreshToken = decrypt(channelData.refreshToken);
        const refreshedTokens = await this.oauthService.refreshAccessToken(
          platform,
          refreshToken,
        );

        // Calculate new expiration time
        const newExpiresAt = refreshedTokens.expiresIn
          ? new Date(Date.now() + refreshedTokens.expiresIn * 1000)
          : null;

        // Update the channel with new tokens
        // Use conditional SQL to handle null timestamp properly
        const newRefreshToken = refreshedTokens.refreshToken
          ? encrypt(refreshedTokens.refreshToken)
          : channelData.refreshToken;

        if (newExpiresAt) {
          await db.execute(sql`
            UPDATE social_media_channels
            SET
              access_token = ${encrypt(refreshedTokens.accessToken)},
              refresh_token = ${newRefreshToken},
              token_expires_at = ${newExpiresAt},
              connection_status = 'connected',
              last_error = NULL,
              last_error_at = NULL,
              consecutive_errors = 0,
              updated_at = ${new Date()}
            WHERE id = ${channelId}
          `);
        } else {
          await db.execute(sql`
            UPDATE social_media_channels
            SET
              access_token = ${encrypt(refreshedTokens.accessToken)},
              refresh_token = ${newRefreshToken},
              token_expires_at = NULL,
              connection_status = 'connected',
              last_error = NULL,
              last_error_at = NULL,
              consecutive_errors = 0,
              updated_at = ${new Date()}
            WHERE id = ${channelId}
          `);
        }

        // Log the successful refresh
        // Build refresh log data conditionally to avoid Drizzle timestamp null errors
        const refreshLogData: any = {
          channelId,
          status: 'success',
        };
        if (channelData.tokenExpiresAt) {
          refreshLogData.oldExpiresAt = channelData.tokenExpiresAt;
        }
        if (newExpiresAt) {
          refreshLogData.newExpiresAt = newExpiresAt;
        }
        await db
          .insert(tokenRefreshLogs)
          .values(refreshLogData as NewTokenRefreshLog);

        this.logger.log(
          `Successfully refreshed token for channel ${channelId} (${platform})`,
        );

        return refreshedTokens.accessToken;
      } catch (error) {
        this.logger.error(
          `Failed to refresh token for channel ${channelId}: ${error}`,
        );

        // Log the failed refresh - build conditionally to avoid null timestamps
        const failedRefreshLogData: any = {
          channelId,
          status: 'failed',
          errorMessage: error instanceof Error ? error.message : String(error),
        };
        if (channelData.tokenExpiresAt) {
          failedRefreshLogData.oldExpiresAt = channelData.tokenExpiresAt;
        }
        await db
          .insert(tokenRefreshLogs)
          .values(failedRefreshLogData as NewTokenRefreshLog);

        // If token is expired (not just about to expire), throw error
        if (isExpired) {
          // Mark channel as expired
          await db
            .update(socialMediaChannels)
            .set({
              connectionStatus: 'expired',
              lastError: 'Token refresh failed',
              lastErrorAt: new Date(),
              consecutiveErrors: (channelData.consecutiveErrors || 0) + 1,
              updatedAt: new Date(),
            })
            .where(eq(socialMediaChannels.id, channelId));

          throw new BadRequestException(
            `Access token has expired and refresh failed. Please reconnect the ${platform} channel.`,
          );
        }
        // If just about to expire, return current token and let it work until actual expiration
      }
    } else if (isExpired) {
      // Token is expired but no refresh token available or platform doesn't support refresh
      throw new BadRequestException(
        `Access token has expired. Please reconnect the ${platform} channel.`,
      );
    }

    return decrypt(channelData.accessToken);
  }

  /**
   * Bluesky-specific token resolution.
   *
   * Bluesky `accessJwt` lives ~2h (per AT Protocol) and we never populate
   * `tokenExpiresAt` for Bluesky channels (the OAuth-shaped `tokenExpirationDays`
   * is null), so the standard OAuth refresh path can't fire. Without inline
   * refresh, every inbox poll / publishing call would fail with `ExpiredToken`
   * 2 hours after the user last connected/refreshed.
   *
   * Strategy: keep `updated_at` as a proxy for last-refresh timestamp. If it's
   * older than 90 minutes, proactively refresh via `com.atproto.server.refreshSession`
   * and persist the new accessJwt + refreshJwt. Refresh failure falls back to
   * returning the existing token (caller may still succeed, or will get a
   * fresh error to surface).
   */
  private async getBlueskyAccessToken(
    channelData: typeof socialMediaChannels.$inferSelect,
  ): Promise<string> {
    const REFRESH_AFTER_MS = 90 * 60 * 1000; // 90 min — comfortable margin under the 2h JWT TTL
    const lastTouched = channelData.updatedAt?.getTime() ?? 0;
    const ageMs = Date.now() - lastTouched;

    if (ageMs < REFRESH_AFTER_MS) {
      return decrypt(channelData.accessToken);
    }

    if (!channelData.refreshToken) {
      this.logger.warn(
        `Bluesky channel ${channelData.id} has no refresh token — returning existing access token`,
      );
      return decrypt(channelData.accessToken);
    }

    this.logger.log(
      `Bluesky channel ${channelData.id}: token ${Math.round(ageMs / 60_000)}min old, refreshing session`,
    );

    try {
      const refreshJwt = decrypt(channelData.refreshToken);
      const res = await fetch(
        'https://bsky.social/xrpc/com.atproto.server.refreshSession',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${refreshJwt}` },
        },
      );

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        this.logger.warn(
          `Bluesky refresh failed for channel ${channelData.id}: HTTP ${res.status} ${errText}`,
        );

        // Mark channel as expired so the UI surfaces a reconnect CTA. The
        // refreshJwt itself can expire if the App Password was revoked.
        if (res.status === 400 || res.status === 401) {
          await db
            .update(socialMediaChannels)
            .set({
              connectionStatus: 'expired',
              lastError: `Bluesky session refresh failed: ${errText}`,
              lastErrorAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(socialMediaChannels.id, channelData.id));
        }
        return decrypt(channelData.accessToken);
      }

      const data = (await res.json()) as {
        accessJwt?: string;
        refreshJwt?: string;
        did?: string;
        handle?: string;
      };

      if (!data.accessJwt) {
        this.logger.warn(
          `Bluesky refresh returned no accessJwt for channel ${channelData.id}`,
        );
        return decrypt(channelData.accessToken);
      }

      const newAccessToken = encrypt(data.accessJwt);
      const newRefreshToken = data.refreshJwt
        ? encrypt(data.refreshJwt)
        : channelData.refreshToken;

      await db
        .update(socialMediaChannels)
        .set({
          accessToken: newAccessToken,
          refreshToken: newRefreshToken,
          connectionStatus: 'connected',
          lastError: null,
          lastErrorAt: null,
          consecutiveErrors: 0,
          updatedAt: new Date(),
        })
        .where(eq(socialMediaChannels.id, channelData.id));

      this.logger.log(
        `Bluesky channel ${channelData.id} session refreshed successfully`,
      );
      return data.accessJwt;
    } catch (err) {
      this.logger.error(
        `Bluesky refresh threw for channel ${channelData.id}: ${(err as Error).message}`,
      );
      return decrypt(channelData.accessToken);
    }
  }

  /**
   * Force refresh access token regardless of expiration status.
   * Useful when a 401 is received from the platform API.
   */
  async forceRefreshToken(
    channelId: number,
    workspaceId: string,
  ): Promise<string> {
    const channel = await db
      .select()
      .from(socialMediaChannels)
      .where(
        and(
          eq(socialMediaChannels.id, channelId),
          eq(socialMediaChannels.workspaceId, workspaceId),
        ),
      )
      .limit(1);

    if (channel.length === 0) {
      throw new NotFoundException('Channel not found');
    }

    const channelData = channel[0];
    const platform = channelData.platform as SupportedPlatform;
    const platformConfig = PLATFORM_CONFIG[platform];

    if (!channelData.refreshToken || !platformConfig?.supportsRefreshToken) {
      throw new BadRequestException(
        `Cannot refresh token for ${platform}. Please reconnect the channel.`,
      );
    }

    this.logger.log(
      `Force refreshing token for channel ${channelId} (${platform})`,
    );

    const refreshToken = decrypt(channelData.refreshToken);
    const refreshedTokens = await this.oauthService.refreshAccessToken(
      platform,
      refreshToken,
    );

    const newExpiresAt = refreshedTokens.expiresIn
      ? new Date(Date.now() + refreshedTokens.expiresIn * 1000)
      : null;

    const newRefreshToken = refreshedTokens.refreshToken
      ? encrypt(refreshedTokens.refreshToken)
      : channelData.refreshToken;

    if (newExpiresAt) {
      await db.execute(sql`
        UPDATE social_media_channels
        SET
          access_token = ${encrypt(refreshedTokens.accessToken)},
          refresh_token = ${newRefreshToken},
          token_expires_at = ${newExpiresAt},
          connection_status = 'connected',
          last_error = NULL,
          last_error_at = NULL,
          consecutive_errors = 0,
          updated_at = ${new Date()}
        WHERE id = ${channelId}
      `);
    } else {
      await db.execute(sql`
        UPDATE social_media_channels
        SET
          access_token = ${encrypt(refreshedTokens.accessToken)},
          refresh_token = ${newRefreshToken},
          token_expires_at = NULL,
          connection_status = 'connected',
          last_error = NULL,
          last_error_at = NULL,
          consecutive_errors = 0,
          updated_at = ${new Date()}
        WHERE id = ${channelId}
      `);
    }

    this.logger.log(
      `Force refresh successful for channel ${channelId} (${platform})`,
    );

    return refreshedTokens.accessToken;
  }

  /**
   * Get decrypted refresh token for a channel
   */
  async getRefreshToken(
    channelId: number,
    workspaceId: string,
  ): Promise<string | null> {
    const channel = await db
      .select()
      .from(socialMediaChannels)
      .where(
        and(
          eq(socialMediaChannels.id, channelId),
          eq(socialMediaChannels.workspaceId, workspaceId),
        ),
      )
      .limit(1);

    if (channel.length === 0) {
      throw new NotFoundException('Channel not found');
    }

    if (!channel[0].refreshToken) {
      return null;
    }

    return decrypt(channel[0].refreshToken);
  }

  /**
   * Mark a channel as having an error
   */
  async markChannelError(
    channelId: number,
    error: string,
    status: ConnectionStatus = 'error',
  ): Promise<void> {
    const channel = await db
      .select()
      .from(socialMediaChannels)
      .where(eq(socialMediaChannels.id, channelId))
      .limit(1);

    if (channel.length === 0) {
      return;
    }

    const consecutiveErrors = (channel[0].consecutiveErrors || 0) + 1;

    // If too many consecutive errors, mark as revoked
    const finalStatus = consecutiveErrors >= 5 ? 'revoked' : status;

    await db
      .update(socialMediaChannels)
      .set({
        connectionStatus: finalStatus,
        lastError: error,
        lastErrorAt: new Date(),
        consecutiveErrors,
        updatedAt: new Date(),
      })
      .where(eq(socialMediaChannels.id, channelId));

    // Log the failure
    await db.insert(tokenRefreshLogs).values({
      channelId,
      status: 'failed',
      errorMessage: error,
    } as NewTokenRefreshLog);

    this.logger.warn(`Channel ${channelId} error: ${error}`);
  }

  // ==========================================================================
  // Channel Relationships
  // ==========================================================================

  /**
   * Create a relationship between channels
   */
  async createRelationship(
    parentChannelId: number,
    childChannelId: number,
    relationshipType: string,
    metadata?: Record<string, any>,
  ): Promise<void> {
    await db.insert(channelRelationships).values({
      parentChannelId,
      childChannelId,
      relationshipType,
      metadata: metadata || {},
    } as NewChannelRelationship);

    this.logger.log(
      `Created ${relationshipType} relationship: ${parentChannelId} -> ${childChannelId}`,
    );
  }

  /**
   * Get child channels for a parent channel
   */
  async getChildChannels(
    parentChannelId: number,
  ): Promise<ChannelResponseDto[]> {
    const relationships = await db
      .select()
      .from(channelRelationships)
      .where(eq(channelRelationships.parentChannelId, parentChannelId));

    const childIds = relationships.map((r) => r.childChannelId);

    if (childIds.length === 0) {
      return [];
    }

    const children = await db
      .select()
      .from(socialMediaChannels)
      .where(sql`${socialMediaChannels.id} IN ${childIds}`);

    return children.map((ch) => this.toResponseDto(ch));
  }

  // ==========================================================================
  // Statistics
  // ==========================================================================

  /**
   * Get channel statistics for a workspace
   */
  async getChannelStats(workspaceId: string): Promise<ChannelStatsResponseDto> {
    const channels = await db
      .select()
      .from(socialMediaChannels)
      .where(eq(socialMediaChannels.workspaceId, workspaceId));

    const stats: ChannelStatsResponseDto = {
      totalChannels: channels.length,
      activeChannels: channels.filter(
        (ch) => ch.isActive && ch.connectionStatus === 'connected',
      ).length,
      expiredChannels: channels.filter(
        (ch) => ch.connectionStatus === 'expired',
      ).length,
      errorChannels: channels.filter(
        (ch) =>
          ch.connectionStatus === 'error' || ch.connectionStatus === 'revoked',
      ).length,
      byPlatform: {},
    };

    // Count by platform
    for (const ch of channels) {
      stats.byPlatform[ch.platform] = (stats.byPlatform[ch.platform] || 0) + 1;
    }

    return stats;
  }

  /**
   * Get channels with expiring tokens
   */
  async getExpiringChannels(
    daysUntilExpiry: number = 7,
  ): Promise<ChannelResponseDto[]> {
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + daysUntilExpiry);

    const channels = await db
      .select()
      .from(socialMediaChannels)
      .where(
        and(
          eq(socialMediaChannels.isActive, true),
          sql`${socialMediaChannels.tokenExpiresAt} IS NOT NULL`,
          sql`${socialMediaChannels.tokenExpiresAt} < ${expiryDate}`,
          sql`${socialMediaChannels.tokenExpiresAt} > NOW()`,
        ),
      );

    return channels.map((ch) => this.toResponseDto(ch));
  }

  // ==========================================================================
  // Billing Integration
  // ==========================================================================

  /**
   * Enforce channel limit based on subscription
   */
  private async enforceChannelLimit(workspaceId: string): Promise<void> {
    const usage = await db
      .select()
      .from(workspaceUsage)
      .where(eq(workspaceUsage.workspaceId, workspaceId))
      .limit(1);

    if (usage.length === 0) {
      // No usage record, allow (will be created on first subscription)
      return;
    }

    const { channelsCount, channelsLimit, extraChannelsPurchased } = usage[0];
    const totalLimit = channelsLimit + extraChannelsPurchased;

    if (channelsCount >= totalLimit) {
      throw new ForbiddenException(
        `Channel limit reached (${channelsCount}/${totalLimit}). ` +
          'Please upgrade your plan or purchase additional channels.',
      );
    }
  }

  /**
   * Increment channel count in workspace usage
   */
  private async incrementChannelCount(workspaceId: string): Promise<void> {
    await db
      .update(workspaceUsage)
      .set({
        channelsCount: sql`${workspaceUsage.channelsCount} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(workspaceUsage.workspaceId, workspaceId));
  }

  /**
   * Decrement channel count in workspace usage
   */
  private async decrementChannelCount(workspaceId: string): Promise<void> {
    await db
      .update(workspaceUsage)
      .set({
        channelsCount: sql`GREATEST(${workspaceUsage.channelsCount} - 1, 0)`,
        updatedAt: new Date(),
      })
      .where(eq(workspaceUsage.workspaceId, workspaceId));
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  /**
   * Convert database model to response DTO (strips sensitive data)
   */
  private toResponseDto(
    channel: typeof socialMediaChannels.$inferSelect,
  ): ChannelResponseDto {
    const isTokenExpired = channel.tokenExpiresAt
      ? channel.tokenExpiresAt < new Date()
      : false;

    const hasRefreshToken = !!channel.refreshToken;

    const refreshTokenExpiresInDays = (() => {
      if (!channel.refreshToken || !channel.refreshTokenIssuedAt) return null;
      const ttlDays = getRefreshTokenTtlDays(
        channel.platform as SupportedPlatform,
      );
      if (ttlDays === null) return null;
      const issuedAt = new Date(channel.refreshTokenIssuedAt).getTime();
      const expiresAt = issuedAt + ttlDays * 24 * 60 * 60 * 1000;
      const remainingMs = expiresAt - Date.now();
      return Math.floor(remainingMs / (24 * 60 * 60 * 1000));
    })();

    return {
      id: channel.id,
      workspaceId: channel.workspaceId,
      platform: channel.platform,
      accountType: channel.accountType,
      platformAccountId: channel.platformAccountId,
      accountName: channel.accountName,
      username: channel.username,
      profilePictureUrl: channel.profilePictureUrl,
      permissions: (channel.permissions as string[]) || [],
      capabilities: channel.capabilities as Record<string, any> | null,
      isActive: channel.isActive,
      connectionStatus: channel.connectionStatus,
      lastError: channel.lastError,
      lastSyncedAt: channel.lastSyncedAt,
      lastPostedAt: channel.lastPostedAt,
      metadata: (channel.metadata as Record<string, any>) || {},
      displayOrder: channel.displayOrder,
      timezone: channel.timezone,
      color: channel.color,
      tokenExpiresAt: channel.tokenExpiresAt,
      isTokenExpired,
      hasRefreshToken,
      refreshTokenExpiresInDays,
      createdAt: channel.createdAt,
      updatedAt: channel.updatedAt,
    };
  }

  // ==========================================================================
  // OAuth State Management
  // ==========================================================================

  /**
   * Create an OAuth state for CSRF protection and token storage
   */
  async createOAuthState(
    workspaceId: string,
    userId: string,
    platform: string,
    stateToken: string,
    redirectUrl?: string,
    codeVerifier?: string,
    additionalData?: Record<string, any>,
  ): Promise<void> {
    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + 15); // 15 minutes expiry

    await db.insert(oauthStates).values({
      workspaceId,
      userId,
      platform,
      stateToken,
      redirectUrl,
      codeVerifier,
      additionalData,
      expiresAt,
    });
  }

  /**
   * Get OAuth state by state token
   */
  async getOAuthStateByToken(stateToken: string) {
    const [state] = await db
      .select()
      .from(oauthStates)
      .where(
        and(
          eq(oauthStates.stateToken, stateToken),
          sql`${oauthStates.expiresAt} > NOW()`,
          sql`${oauthStates.usedAt} IS NULL`,
        ),
      )
      .limit(1);

    return state || null;
  }

  /**
   * Mark OAuth state as used
   */
  async markOAuthStateUsed(stateToken: string): Promise<void> {
    await db
      .update(oauthStates)
      .set({ usedAt: new Date() })
      .where(eq(oauthStates.stateToken, stateToken));
  }
}
