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
} from '../../drizzle/schema/channels.schema';
import { workspaceUsage } from '../../drizzle/schema';
import { encrypt, decrypt, maskSensitiveData } from '../../common/utils/encryption.util';
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
    // Check channel limit before creating
    await this.enforceChannelLimit(workspaceId);

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
      throw new ConflictException(
        `This ${dto.platform} account is already connected to this workspace`,
      );
    }

    // Get platform config for defaults
    const platformConfig = PLATFORM_CONFIG[dto.platform as SupportedPlatform];

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
    if (dto.profilePictureUrl) newChannel.profilePictureUrl = dto.profilePictureUrl;
    if (dto.refreshToken) newChannel.refreshToken = encrypt(dto.refreshToken);
    if (dto.tokenExpiresAt) newChannel.tokenExpiresAt = new Date(dto.tokenExpiresAt);
    if (dto.tokenScope) newChannel.tokenScope = dto.tokenScope;
    if (dto.color) newChannel.color = dto.color;

    const inserted = await db
      .insert(socialMediaChannels)
      .values(newChannel)
      .returning();

    // Update workspace usage count
    await this.incrementChannelCount(workspaceId);

    this.logger.log(
      `Created ${dto.platform} channel for workspace ${workspaceId}: ${dto.accountName}`,
    );

    return this.toResponseDto(inserted[0]);
  }

  /**
   * Get all channels for a workspace
   */
  async getWorkspaceChannels(
    workspaceId: string,
    query?: ChannelQueryDto,
  ): Promise<ChannelResponseDto[]> {
    let conditions = [eq(socialMediaChannels.workspaceId, workspaceId)];

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
    accountName: string;
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
      accountName: ch.accountName,
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
    if (dto.displayOrder !== undefined) updateData.displayOrder = dto.displayOrder;
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
    if (dto.tokenExpiresAt) updateData.tokenExpiresAt = new Date(dto.tokenExpiresAt);

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
    if (dto.tokenExpiresAt) refreshLogData.newExpiresAt = new Date(dto.tokenExpiresAt);
    await db.insert(tokenRefreshLogs).values(refreshLogData as NewTokenRefreshLog);

    this.logger.log(`Updated tokens for channel ${channelId}`);
  }

  /**
   * Get decrypted access token for a channel (with automatic refresh)
   */
  async getAccessToken(channelId: number, workspaceId: string): Promise<string> {
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

    // Check if token is expired or about to expire
    const now = new Date();
    const bufferTime = new Date(now.getTime() + this.TOKEN_REFRESH_BUFFER_MS);
    const isExpired = channelData.tokenExpiresAt && channelData.tokenExpiresAt < now;
    const isAboutToExpire = channelData.tokenExpiresAt && channelData.tokenExpiresAt < bufferTime;

    // If token is expired or about to expire, try to refresh it
    if ((isExpired || isAboutToExpire) && channelData.refreshToken && platformConfig?.supportsRefreshToken) {
      this.logger.log(`Token for channel ${channelId} (${platform}) is ${isExpired ? 'expired' : 'about to expire'}, attempting refresh...`);

      try {
        const refreshToken = decrypt(channelData.refreshToken);
        const refreshedTokens = await this.oauthService.refreshAccessToken(platform, refreshToken);

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
        await db.insert(tokenRefreshLogs).values(refreshLogData as NewTokenRefreshLog);

        this.logger.log(`Successfully refreshed token for channel ${channelId} (${platform})`);

        return refreshedTokens.accessToken;
      } catch (error) {
        this.logger.error(`Failed to refresh token for channel ${channelId}: ${error}`);

        // Log the failed refresh - build conditionally to avoid null timestamps
        const failedRefreshLogData: any = {
          channelId,
          status: 'failed',
          errorMessage: error instanceof Error ? error.message : String(error),
        };
        if (channelData.tokenExpiresAt) {
          failedRefreshLogData.oldExpiresAt = channelData.tokenExpiresAt;
        }
        await db.insert(tokenRefreshLogs).values(failedRefreshLogData as NewTokenRefreshLog);

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
  async getChildChannels(parentChannelId: number): Promise<ChannelResponseDto[]> {
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
  async getExpiringChannels(daysUntilExpiry: number = 7): Promise<ChannelResponseDto[]> {
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
