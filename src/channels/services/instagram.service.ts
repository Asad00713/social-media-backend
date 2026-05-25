import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import type {
  FetchedDm,
  CreatedDm,
  DmConversationSummary,
} from '../../inbox/adapters/inbox-adapter.interface';

export interface InstagramUser {
  id: string;
  username: string;
  name: string;
  profilePictureUrl: string | null;
  followersCount: number;
  followsCount: number;
  mediaCount: number;
  biography: string | null;
  website: string | null;
}

export interface InstagramMedia {
  id: string;
  caption: string | null;
  mediaType: 'IMAGE' | 'VIDEO' | 'CAROUSEL_ALBUM';
  mediaUrl: string | null;
  thumbnailUrl: string | null;
  permalink: string;
  timestamp: string;
  likeCount: number;
  commentsCount: number;
}

export interface InstagramInsights {
  impressions: number;
  reach: number;
  profileViews: number;
  websiteClicks: number;
}

@Injectable()
export class InstagramService {
  private readonly logger = new Logger(InstagramService.name);
  private readonly graphApiUrl = 'https://graph.facebook.com/v18.0';
  private readonly instagramApiUrl = 'https://graph.instagram.com';
  /** One-shot guard so the token-scope diagnostic prints once per process. */
  private static debugTokenLoggedOnce = false;

  // Instagram aspect ratio limits
  private readonly MIN_ASPECT_RATIO = 0.8; // 4:5 portrait
  private readonly MAX_ASPECT_RATIO = 1.91; // 1.91:1 landscape
  private readonly ASPECT_RATIO_TOLERANCE = 0.01; // Allow small tolerance for rounding

  /**
   * Get image dimensions from URL by fetching headers or partial content
   */
  private async getImageDimensions(
    imageUrl: string,
  ): Promise<{ width: number; height: number }> {
    try {
      // Fetch the image to get dimensions
      const response = await fetch(imageUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch image: ${response.status}`);
      }

      const buffer = await response.arrayBuffer();
      const uint8Array = new Uint8Array(buffer);

      // Try to parse dimensions from image headers (PNG, JPEG, GIF, WebP)
      const dimensions = this.parseImageDimensions(uint8Array);
      if (dimensions) {
        return dimensions;
      }

      throw new Error('Could not determine image dimensions');
    } catch (error) {
      this.logger.warn(`Failed to get image dimensions for ${imageUrl}: ${error}`);
      throw new BadRequestException(
        `Failed to validate image dimensions. Please ensure the image URL is accessible and is a valid image format (JPEG, PNG, GIF, or WebP).`,
      );
    }
  }

  /**
   * Parse image dimensions from binary data (supports PNG, JPEG, GIF, WebP)
   */
  private parseImageDimensions(
    data: Uint8Array,
  ): { width: number; height: number } | null {
    // PNG: Check for PNG signature and parse IHDR chunk
    if (
      data[0] === 0x89 &&
      data[1] === 0x50 &&
      data[2] === 0x4e &&
      data[3] === 0x47
    ) {
      // PNG dimensions are at bytes 16-23 (width: 16-19, height: 20-23)
      const width =
        (data[16] << 24) | (data[17] << 16) | (data[18] << 8) | data[19];
      const height =
        (data[20] << 24) | (data[21] << 16) | (data[22] << 8) | data[23];
      return { width, height };
    }

    // JPEG: Look for SOF0/SOF2 marker
    if (data[0] === 0xff && data[1] === 0xd8) {
      let offset = 2;
      while (offset < data.length - 9) {
        if (data[offset] !== 0xff) {
          offset++;
          continue;
        }
        const marker = data[offset + 1];
        // SOF0 (0xC0) or SOF2 (0xC2) contain dimensions
        if (marker === 0xc0 || marker === 0xc2) {
          const height = (data[offset + 5] << 8) | data[offset + 6];
          const width = (data[offset + 7] << 8) | data[offset + 8];
          return { width, height };
        }
        // Skip to next marker
        const length = (data[offset + 2] << 8) | data[offset + 3];
        offset += 2 + length;
      }
    }

    // GIF: Dimensions at bytes 6-9
    if (
      data[0] === 0x47 &&
      data[1] === 0x49 &&
      data[2] === 0x46 // "GIF"
    ) {
      const width = data[6] | (data[7] << 8);
      const height = data[8] | (data[9] << 8);
      return { width, height };
    }

    // WebP: Check for RIFF header and VP8 chunk
    if (
      data[0] === 0x52 &&
      data[1] === 0x49 &&
      data[2] === 0x46 &&
      data[3] === 0x46 && // "RIFF"
      data[8] === 0x57 &&
      data[9] === 0x45 &&
      data[10] === 0x42 &&
      data[11] === 0x50 // "WEBP"
    ) {
      // VP8L (lossless)
      if (data[12] === 0x56 && data[13] === 0x50 && data[14] === 0x38 && data[15] === 0x4c) {
        const bits = data[21] | (data[22] << 8) | (data[23] << 16) | (data[24] << 24);
        const width = (bits & 0x3fff) + 1;
        const height = ((bits >> 14) & 0x3fff) + 1;
        return { width, height };
      }
      // VP8X (extended)
      if (data[12] === 0x56 && data[13] === 0x50 && data[14] === 0x38 && data[15] === 0x58) {
        const width = 1 + (data[24] | (data[25] << 8) | (data[26] << 16));
        const height = 1 + (data[27] | (data[28] << 8) | (data[29] << 16));
        return { width, height };
      }
      // VP8 (lossy)
      if (data[12] === 0x56 && data[13] === 0x50 && data[14] === 0x38 && data[15] === 0x20) {
        const width = (data[26] | (data[27] << 8)) & 0x3fff;
        const height = (data[28] | (data[29] << 8)) & 0x3fff;
        return { width, height };
      }
    }

    return null;
  }

  /**
   * Validate aspect ratio for Instagram
   * Instagram allows aspect ratios between 4:5 (0.8) and 1.91:1 (1.91)
   */
  private validateAspectRatio(
    width: number,
    height: number,
    itemIndex?: number,
  ): void {
    const aspectRatio = width / height;
    const itemLabel = itemIndex !== undefined ? ` (item ${itemIndex + 1})` : '';

    if (aspectRatio < this.MIN_ASPECT_RATIO - this.ASPECT_RATIO_TOLERANCE) {
      throw new BadRequestException(
        `The aspect ratio is not supported${itemLabel}. Image is too tall (${aspectRatio.toFixed(2)}). ` +
          `Instagram requires aspect ratio between 4:5 (0.8) and 1.91:1 (1.91). ` +
          `Current dimensions: ${width}x${height}. Consider cropping the image to a supported ratio like 4:5 (portrait) or 1:1 (square).`,
      );
    }

    if (aspectRatio > this.MAX_ASPECT_RATIO + this.ASPECT_RATIO_TOLERANCE) {
      throw new BadRequestException(
        `The aspect ratio is not supported${itemLabel}. Image is too wide (${aspectRatio.toFixed(2)}). ` +
          `Instagram requires aspect ratio between 4:5 (0.8) and 1.91:1 (1.91). ` +
          `Current dimensions: ${width}x${height}. Consider cropping the image to a supported ratio like 1.91:1 (landscape) or 1:1 (square).`,
      );
    }
  }

  /**
   * Validate all carousel images have compatible aspect ratios
   */
  private async validateCarouselAspectRatios(
    mediaItems: Array<{ type: 'IMAGE' | 'VIDEO'; url: string }>,
  ): Promise<void> {
    const imageItems = mediaItems.filter((item) => item.type === 'IMAGE');

    if (imageItems.length === 0) {
      return; // No images to validate
    }

    this.logger.log(`Validating aspect ratios for ${imageItems.length} images`);

    const dimensions: Array<{ width: number; height: number; ratio: number }> = [];

    for (let i = 0; i < mediaItems.length; i++) {
      const item = mediaItems[i];
      if (item.type === 'IMAGE') {
        const dim = await this.getImageDimensions(item.url);
        const ratio = dim.width / dim.height;

        // Validate individual image aspect ratio
        this.validateAspectRatio(dim.width, dim.height, i);

        dimensions.push({ ...dim, ratio });
        this.logger.log(
          `Image ${i + 1}: ${dim.width}x${dim.height} (ratio: ${ratio.toFixed(2)})`,
        );
      }
    }

    // Check that all images have similar aspect ratios (Instagram requirement for carousels)
    if (dimensions.length > 1) {
      const firstRatio = dimensions[0].ratio;
      for (let i = 1; i < dimensions.length; i++) {
        const ratioDiff = Math.abs(dimensions[i].ratio - firstRatio);
        // Allow 10% tolerance for aspect ratio matching
        if (ratioDiff > 0.1) {
          throw new BadRequestException(
            `Carousel images must have similar aspect ratios. ` +
              `Image 1 has ratio ${firstRatio.toFixed(2)}, but image ${i + 1} has ratio ${dimensions[i].ratio.toFixed(2)}. ` +
              `Please ensure all images are cropped to the same aspect ratio (e.g., all 1:1 square or all 4:5 portrait).`,
          );
        }
      }
    }

    this.logger.log('All carousel images passed aspect ratio validation');
  }

  /**
   * Get Instagram account info using Instagram User Access Token
   * This works with tokens generated from Meta Developer Dashboard
   */
  async getAccountInfoWithUserToken(
    accessToken: string,
  ): Promise<InstagramUser> {
    // First get the user ID using /me endpoint
    const meUrl = new URL(`${this.instagramApiUrl}/me`);
    meUrl.searchParams.set('access_token', accessToken);
    meUrl.searchParams.set(
      'fields',
      'id,username,name,profile_picture_url,followers_count,follows_count,media_count,biography,website,account_type',
    );

    this.logger.log(`Fetching Instagram user info from: ${meUrl.toString().replace(accessToken, 'TOKEN_HIDDEN')}`);

    const response = await fetch(meUrl.toString());

    if (!response.ok) {
      const error = await response.json();
      this.logger.error('Failed to fetch Instagram account info:', error);
      throw new BadRequestException(
        error.error?.message || 'Failed to fetch Instagram account info',
      );
    }

    const data = await response.json();
    this.logger.log(`Instagram user data: ${JSON.stringify(data)}`);

    return {
      id: data.id,
      username: data.username || 'unknown',
      name: data.name || data.username || 'Instagram User',
      profilePictureUrl: data.profile_picture_url || null,
      followersCount: data.followers_count || 0,
      followsCount: data.follows_count || 0,
      mediaCount: data.media_count || 0,
      biography: data.biography || null,
      website: data.website || null,
    };
  }

  /**
   * Get Instagram Business/Creator account info
   * Note: Requires page access token from the connected Facebook Page
   */
  async getAccountInfo(
    instagramAccountId: string,
    pageAccessToken: string,
  ): Promise<InstagramUser> {
    const url = new URL(`${this.graphApiUrl}/${instagramAccountId}`);
    url.searchParams.set('access_token', pageAccessToken);
    url.searchParams.set(
      'fields',
      'id,username,name,profile_picture_url,followers_count,follows_count,media_count,biography,website',
    );

    const response = await fetch(url.toString());

    if (!response.ok) {
      const error = await response.json();
      this.logger.error('Failed to fetch Instagram account info:', error);
      throw new BadRequestException(
        error.error?.message || 'Failed to fetch Instagram account info',
      );
    }

    const data = await response.json();

    return {
      id: data.id,
      username: data.username,
      name: data.name || data.username,
      profilePictureUrl: data.profile_picture_url || null,
      followersCount: data.followers_count || 0,
      followsCount: data.follows_count || 0,
      mediaCount: data.media_count || 0,
      biography: data.biography || null,
      website: data.website || null,
    };
  }

  /**
   * Get user's Instagram media/posts
   */
  async getUserMedia(
    instagramAccountId: string,
    pageAccessToken: string,
    limit: number = 25,
    after?: string,
  ): Promise<{ media: InstagramMedia[]; nextCursor: string | null }> {
    const url = new URL(`${this.graphApiUrl}/${instagramAccountId}/media`);
    url.searchParams.set('access_token', pageAccessToken);
    url.searchParams.set(
      'fields',
      'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count',
    );
    url.searchParams.set('limit', limit.toString());

    if (after) {
      url.searchParams.set('after', after);
    }

    const response = await fetch(url.toString());

    if (!response.ok) {
      const error = await response.json();
      this.logger.error('Failed to fetch Instagram media:', error);
      throw new BadRequestException(
        error.error?.message || 'Failed to fetch Instagram media',
      );
    }

    const data = await response.json();

    return {
      media: (data.data || []).map((item: any) => ({
        id: item.id,
        caption: item.caption || null,
        mediaType: item.media_type,
        mediaUrl: item.media_url || null,
        thumbnailUrl: item.thumbnail_url || null,
        permalink: item.permalink,
        timestamp: item.timestamp,
        likeCount: item.like_count || 0,
        commentsCount: item.comments_count || 0,
      })),
      nextCursor: data.paging?.cursors?.after || null,
    };
  }

  /**
   * Create an image post on Instagram
   */
  async createImagePost(
    instagramAccountId: string,
    pageAccessToken: string,
    imageUrl: string,
    caption?: string,
  ): Promise<{ postId: string }> {
    // Step 1: Create media container
    const containerUrl = new URL(
      `${this.graphApiUrl}/${instagramAccountId}/media`,
    );

    const containerBody: Record<string, string> = {
      access_token: pageAccessToken,
      image_url: imageUrl,
    };

    if (caption) {
      containerBody.caption = caption;
    }

    const containerResponse = await fetch(containerUrl.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(containerBody),
    });

    if (!containerResponse.ok) {
      const error = await containerResponse.json();
      this.logger.error('Failed to create Instagram media container:', error);
      throw new BadRequestException(
        error.error?.message || 'Failed to create Instagram post',
      );
    }

    const containerData = await containerResponse.json();
    const creationId = containerData.id;

    // Step 2: Publish the container
    return await this.publishContainer(
      instagramAccountId,
      pageAccessToken,
      creationId,
    );
  }

  /**
   * Create a video/reel post on Instagram
   */
  async createVideoPost(
    instagramAccountId: string,
    pageAccessToken: string,
    videoUrl: string,
    caption?: string,
    isReel: boolean = false,
  ): Promise<{ postId: string }> {
    // Step 1: Create media container for video
    const containerUrl = new URL(
      `${this.graphApiUrl}/${instagramAccountId}/media`,
    );

    const containerBody: Record<string, string> = {
      access_token: pageAccessToken,
      video_url: videoUrl,
      media_type: isReel ? 'REELS' : 'VIDEO',
    };

    if (caption) {
      containerBody.caption = caption;
    }

    const containerResponse = await fetch(containerUrl.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(containerBody),
    });

    if (!containerResponse.ok) {
      const error = await containerResponse.json();
      this.logger.error('Failed to create Instagram video container:', error);
      throw new BadRequestException(
        error.error?.message || 'Failed to create Instagram video post',
      );
    }

    const containerData = await containerResponse.json();
    const creationId = containerData.id;

    // Wait for video to be processed (poll status)
    await this.waitForMediaReady(creationId, pageAccessToken);

    // Step 2: Publish the container
    return await this.publishContainer(
      instagramAccountId,
      pageAccessToken,
      creationId,
    );
  }

  /**
   * Create a carousel post on Instagram (multiple images/videos)
   */
  async createCarouselPost(
    instagramAccountId: string,
    pageAccessToken: string,
    mediaItems: Array<{ type: 'IMAGE' | 'VIDEO'; url: string }>,
    caption?: string,
  ): Promise<{ postId: string }> {
    if (mediaItems.length < 2 || mediaItems.length > 10) {
      throw new BadRequestException(
        'Carousel posts require between 2 and 10 media items',
      );
    }

    // Validate aspect ratios before sending to Instagram
    await this.validateCarouselAspectRatios(mediaItems);

    // Step 1: Create containers for each media item
    const childContainerIds: string[] = [];

    for (const item of mediaItems) {
      const containerUrl = new URL(
        `${this.graphApiUrl}/${instagramAccountId}/media`,
      );

      const containerBody: Record<string, string> = {
        access_token: pageAccessToken,
        is_carousel_item: 'true',
      };

      if (item.type === 'IMAGE') {
        containerBody.image_url = item.url;
      } else {
        containerBody.video_url = item.url;
        containerBody.media_type = 'VIDEO';
      }

      const containerResponse = await fetch(containerUrl.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(containerBody),
      });

      if (!containerResponse.ok) {
        const error = await containerResponse.json();
        this.logger.error('Failed to create carousel item container:', error);
        throw new BadRequestException(
          error.error?.message || 'Failed to create carousel item',
        );
      }

      const containerData = await containerResponse.json();
      childContainerIds.push(containerData.id);

      // Wait for video items to be ready
      if (item.type === 'VIDEO') {
        await this.waitForMediaReady(containerData.id, pageAccessToken);
      }
    }

    // Step 2: Create carousel container
    const carouselUrl = new URL(
      `${this.graphApiUrl}/${instagramAccountId}/media`,
    );

    const carouselBody: Record<string, string> = {
      access_token: pageAccessToken,
      media_type: 'CAROUSEL',
      children: childContainerIds.join(','),
    };

    if (caption) {
      carouselBody.caption = caption;
    }

    const carouselResponse = await fetch(carouselUrl.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(carouselBody),
    });

    if (!carouselResponse.ok) {
      const error = await carouselResponse.json();
      this.logger.error('Failed to create carousel container:', error);
      throw new BadRequestException(
        error.error?.message || 'Failed to create carousel post',
      );
    }

    const carouselData = await carouselResponse.json();

    // Step 3: Publish the carousel
    return await this.publishContainer(
      instagramAccountId,
      pageAccessToken,
      carouselData.id,
    );
  }

  /**
   * Create a story post on Instagram (image or video)
   * Stories expire after 24 hours and do not support captions
   */
  async createStoryPost(
    instagramAccountId: string,
    pageAccessToken: string,
    mediaUrl: string,
    mediaType: 'IMAGE' | 'VIDEO',
  ): Promise<{ postId: string }> {
    this.logger.log(`Creating Instagram story for account ${instagramAccountId}`);

    // Step 1: Create media container with media_type=STORIES
    const containerUrl = new URL(
      `${this.graphApiUrl}/${instagramAccountId}/media`,
    );

    const containerBody: Record<string, string> = {
      access_token: pageAccessToken,
      media_type: 'STORIES',
    };

    if (mediaType === 'IMAGE') {
      containerBody.image_url = mediaUrl;
    } else {
      containerBody.video_url = mediaUrl;
    }

    const containerResponse = await fetch(containerUrl.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(containerBody),
    });

    if (!containerResponse.ok) {
      const error = await containerResponse.json();
      this.logger.error('Failed to create Instagram story container:', error);
      throw new BadRequestException(
        error.error?.message || 'Failed to create Instagram story',
      );
    }

    const containerData = await containerResponse.json();
    const creationId = containerData.id;

    // Step 2: Wait for media to be processed
    await this.waitForMediaReady(creationId, pageAccessToken);

    // Step 3: Publish the container
    return await this.publishContainer(
      instagramAccountId,
      pageAccessToken,
      creationId,
    );
  }

  /**
   * Wait for media container to be ready (for video uploads)
   */
  private async waitForMediaReady(
    containerId: string,
    accessToken: string,
    maxAttempts: number = 30,
  ): Promise<void> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const url = new URL(`${this.graphApiUrl}/${containerId}`);
      url.searchParams.set('access_token', accessToken);
      url.searchParams.set('fields', 'status_code');

      const response = await fetch(url.toString());
      const data = await response.json();

      if (data.status_code === 'FINISHED') {
        return;
      }

      if (data.status_code === 'ERROR') {
        throw new BadRequestException('Media processing failed');
      }

      // Wait 2 seconds before next poll
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    throw new BadRequestException('Media processing timed out');
  }

  /**
   * Publish a media container
   */
  private async publishContainer(
    instagramAccountId: string,
    pageAccessToken: string,
    creationId: string,
  ): Promise<{ postId: string }> {
    const publishUrl = new URL(
      `${this.graphApiUrl}/${instagramAccountId}/media_publish`,
    );

    const publishResponse = await fetch(publishUrl.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        access_token: pageAccessToken,
        creation_id: creationId,
      }),
    });

    if (!publishResponse.ok) {
      const error = await publishResponse.json();
      this.logger.error('Failed to publish Instagram post:', error);
      throw new BadRequestException(
        error.error?.message || 'Failed to publish Instagram post',
      );
    }

    const publishData = await publishResponse.json();
    return { postId: publishData.id };
  }

  /**
   * Get account insights (requires Instagram Business account)
   */
  async getAccountInsights(
    instagramAccountId: string,
    pageAccessToken: string,
    period: 'day' | 'week' | 'days_28' = 'day',
  ): Promise<InstagramInsights> {
    const url = new URL(`${this.graphApiUrl}/${instagramAccountId}/insights`);
    url.searchParams.set('access_token', pageAccessToken);
    url.searchParams.set(
      'metric',
      'impressions,reach,profile_views,website_clicks',
    );
    url.searchParams.set('period', period);

    const response = await fetch(url.toString());

    if (!response.ok) {
      const error = await response.json();
      this.logger.error('Failed to fetch Instagram insights:', error);
      throw new BadRequestException(
        error.error?.message || 'Failed to fetch Instagram insights',
      );
    }

    const data = await response.json();
    const insights: InstagramInsights = {
      impressions: 0,
      reach: 0,
      profileViews: 0,
      websiteClicks: 0,
    };

    for (const metric of data.data || []) {
      const value = metric.values?.[0]?.value || 0;
      switch (metric.name) {
        case 'impressions':
          insights.impressions = value;
          break;
        case 'reach':
          insights.reach = value;
          break;
        case 'profile_views':
          insights.profileViews = value;
          break;
        case 'website_clicks':
          insights.websiteClicks = value;
          break;
      }
    }

    return insights;
  }

  /**
   * Delete a post
   */
  async deletePost(
    mediaId: string,
    pageAccessToken: string,
  ): Promise<boolean> {
    const url = new URL(`${this.graphApiUrl}/${mediaId}`);
    url.searchParams.set('access_token', pageAccessToken);

    const response = await fetch(url.toString(), {
      method: 'DELETE',
    });

    if (!response.ok) {
      const error = await response.json();
      this.logger.error('Failed to delete Instagram post:', error);
      throw new BadRequestException(
        error.error?.message || 'Failed to delete Instagram post',
      );
    }

    const data = await response.json();
    return data.success === true;
  }

  // ==========================================================================
  // Instagram Business Login Content Publishing
  // These methods use graph.instagram.com (not graph.facebook.com)
  // ==========================================================================

  /**
   * Create an image post using Instagram Business Login token
   * Uses graph.instagram.com API
   */
  async createImagePostWithUserToken(
    userId: string,
    accessToken: string,
    imageUrl: string,
    caption?: string,
  ): Promise<{ postId: string }> {
    this.logger.log(`Creating Instagram image post for user ${userId}`);

    // Step 1: Create media container
    // Instagram API expects form-urlencoded data, not JSON
    const containerUrl = new URL(`${this.instagramApiUrl}/${userId}/media`);

    const containerParams = new URLSearchParams();
    containerParams.set('access_token', accessToken);
    containerParams.set('image_url', imageUrl);

    if (caption) {
      containerParams.set('caption', caption);
    }

    this.logger.log(`Creating media container at: ${containerUrl.toString()}`);

    const containerResponse = await fetch(containerUrl.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: containerParams,
    });

    if (!containerResponse.ok) {
      const error = await containerResponse.json();
      this.logger.error('Failed to create Instagram media container:', error);
      throw new BadRequestException(
        error.error?.message || 'Failed to create Instagram post',
      );
    }

    const containerData = await containerResponse.json();
    const creationId = containerData.id;
    this.logger.log(`Media container created: ${creationId}, waiting for processing...`);

    // Step 2: Wait for the container to be ready (even images need processing time)
    await this.waitForMediaReadyWithUserToken(creationId, accessToken);

    // Step 3: Publish the container
    return await this.publishContainerWithUserToken(userId, accessToken, creationId);
  }

  /**
   * Create a video/reel post using Instagram Business Login token
   * Uses graph.instagram.com API
   *
   * `mediaType` controls the IG container `media_type` field:
   *   - 'VIDEO' (default for legacy callers) → standard feed video
   *   - 'REELS'                              → Reel
   * The boolean `isReel` form is kept for backwards compatibility but
   * `mediaType` takes precedence when both are passed.
   *
   * Shipped but untested with a live account — verify in smoke test.
   */
  async createVideoPostWithUserToken(
    userId: string,
    accessToken: string,
    videoUrl: string,
    caption?: string,
    isReel: boolean = false,
    mediaType?: 'VIDEO' | 'REELS',
  ): Promise<{ postId: string }> {
    const resolvedMediaType = mediaType ?? (isReel ? 'REELS' : 'VIDEO');
    this.logger.log(
      `Creating Instagram ${resolvedMediaType === 'REELS' ? 'reel' : 'video'} post for user ${userId}`,
    );

    // Step 1: Create media container for video
    const containerUrl = new URL(`${this.instagramApiUrl}/${userId}/media`);

    const containerParams = new URLSearchParams();
    containerParams.set('access_token', accessToken);
    containerParams.set('video_url', videoUrl);
    containerParams.set('media_type', resolvedMediaType);

    if (caption) {
      containerParams.set('caption', caption);
    }

    const containerResponse = await fetch(containerUrl.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: containerParams,
    });

    if (!containerResponse.ok) {
      const error = await containerResponse.json();
      this.logger.error('Failed to create Instagram video container:', error);
      throw new BadRequestException(
        error.error?.message || 'Failed to create Instagram video post',
      );
    }

    const containerData = await containerResponse.json();
    const creationId = containerData.id;
    this.logger.log(`Video container created: ${creationId}, waiting for processing...`);

    // Wait for video to be processed
    await this.waitForMediaReadyWithUserToken(creationId, accessToken);

    // Step 2: Publish the container
    return await this.publishContainerWithUserToken(userId, accessToken, creationId);
  }

  /**
   * Create a carousel post using Instagram Business Login token
   * Uses graph.instagram.com API
   */
  async createCarouselPostWithUserToken(
    userId: string,
    accessToken: string,
    mediaItems: Array<{ type: 'IMAGE' | 'VIDEO'; url: string }>,
    caption?: string,
  ): Promise<{ postId: string }> {
    if (mediaItems.length < 2 || mediaItems.length > 10) {
      throw new BadRequestException(
        'Carousel posts require between 2 and 10 media items',
      );
    }

    // Validate aspect ratios before sending to Instagram
    await this.validateCarouselAspectRatios(mediaItems);

    this.logger.log(`Creating Instagram carousel with ${mediaItems.length} items for user ${userId}`);

    // Step 1: Create containers for each media item
    const childContainerIds: string[] = [];

    for (const item of mediaItems) {
      const containerUrl = new URL(`${this.instagramApiUrl}/${userId}/media`);

      const containerParams = new URLSearchParams();
      containerParams.set('access_token', accessToken);
      containerParams.set('is_carousel_item', 'true');

      if (item.type === 'IMAGE') {
        containerParams.set('image_url', item.url);
      } else {
        containerParams.set('video_url', item.url);
        containerParams.set('media_type', 'VIDEO');
      }

      const containerResponse = await fetch(containerUrl.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: containerParams,
      });

      if (!containerResponse.ok) {
        const error = await containerResponse.json();
        this.logger.error('Failed to create carousel item container:', error);
        throw new BadRequestException(
          error.error?.message || 'Failed to create carousel item',
        );
      }

      const containerData = await containerResponse.json();
      childContainerIds.push(containerData.id);

      // Wait for all items to be ready (images and videos)
      await this.waitForMediaReadyWithUserToken(containerData.id, accessToken);
    }

    // Step 2: Create carousel container
    const carouselUrl = new URL(`${this.instagramApiUrl}/${userId}/media`);

    const carouselParams = new URLSearchParams();
    carouselParams.set('access_token', accessToken);
    carouselParams.set('media_type', 'CAROUSEL');
    carouselParams.set('children', childContainerIds.join(','));

    if (caption) {
      carouselParams.set('caption', caption);
    }

    const carouselResponse = await fetch(carouselUrl.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: carouselParams,
    });

    if (!carouselResponse.ok) {
      const error = await carouselResponse.json();
      this.logger.error('Failed to create carousel container:', error);
      throw new BadRequestException(
        error.error?.message || 'Failed to create carousel post',
      );
    }

    const carouselData = await carouselResponse.json();
    this.logger.log(`Carousel container created: ${carouselData.id}`);

    // Step 3: Wait for the carousel container itself to be FINISHED.
    // Child media being FINISHED is necessary but not sufficient — the carousel
    // container also goes through its own assembly phase before /media_publish
    // accepts it. Skipping this step trips IG error 2207027 ("Media not ready").
    await this.waitForMediaReadyWithUserToken(carouselData.id, accessToken);

    // Step 4: Publish the carousel
    return await this.publishContainerWithUserToken(userId, accessToken, carouselData.id);
  }

  /**
   * Create a story post using Instagram Business Login token
   * Uses graph.instagram.com API
   * Stories expire after 24 hours and do not support captions
   */
  async createStoryPostWithUserToken(
    userId: string,
    accessToken: string,
    mediaUrl: string,
    mediaType: 'IMAGE' | 'VIDEO',
  ): Promise<{ postId: string }> {
    this.logger.log(`Creating Instagram story for user ${userId}`);

    // Step 1: Create media container with media_type=STORIES
    const containerUrl = new URL(`${this.instagramApiUrl}/${userId}/media`);

    const containerParams = new URLSearchParams();
    containerParams.set('access_token', accessToken);
    containerParams.set('media_type', 'STORIES');

    if (mediaType === 'IMAGE') {
      containerParams.set('image_url', mediaUrl);
    } else {
      containerParams.set('video_url', mediaUrl);
    }

    const containerResponse = await fetch(containerUrl.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: containerParams,
    });

    if (!containerResponse.ok) {
      const error = await containerResponse.json();
      this.logger.error('Failed to create Instagram story container:', error);
      throw new BadRequestException(
        error.error?.message || 'Failed to create Instagram story',
      );
    }

    const containerData = await containerResponse.json();
    const creationId = containerData.id;
    this.logger.log(`Story container created: ${creationId}, waiting for processing...`);

    // Step 2: Wait for media to be processed
    await this.waitForMediaReadyWithUserToken(creationId, accessToken);

    // Step 3: Publish the container
    return await this.publishContainerWithUserToken(userId, accessToken, creationId);
  }

  /**
   * Convenience wrapper for the composer: post a Story given a boolean flag
   * for whether the media is a video. Delegates to createStoryPostWithUserToken.
   *
   * Shipped but untested with a live account — verify in smoke test.
   */
  async createStoryWithUserToken(
    userId: string,
    accessToken: string,
    mediaUrl: string,
    isVideo: boolean,
  ): Promise<{ postId: string }> {
    return this.createStoryPostWithUserToken(
      userId,
      accessToken,
      mediaUrl,
      isVideo ? 'VIDEO' : 'IMAGE',
    );
  }

  /**
   * Wait for media to be ready (for video uploads) - Instagram Business Login version
   */
  private async waitForMediaReadyWithUserToken(
    containerId: string,
    accessToken: string,
    maxAttempts: number = 30,
  ): Promise<void> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const url = new URL(`${this.instagramApiUrl}/${containerId}`);
      url.searchParams.set('access_token', accessToken);
      url.searchParams.set('fields', 'status_code');

      const response = await fetch(url.toString());
      const data = await response.json();

      this.logger.log(`Media status check ${attempt + 1}/${maxAttempts}: ${data.status_code}`);

      if (data.status_code === 'FINISHED') {
        return;
      }

      if (data.status_code === 'ERROR') {
        throw new BadRequestException('Media processing failed');
      }

      // Wait 2 seconds before next poll
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    throw new BadRequestException('Media processing timed out');
  }

  /**
   * Publish a media container - Instagram Business Login version.
   *
   * IG occasionally returns error_subcode 2207027 ("Media not ready") for a
   * brief window after the container reports FINISHED. We retry up to 3 times
   * with exponential backoff for that specific case so a transient race
   * doesn't fail the publish.
   */
  private async publishContainerWithUserToken(
    userId: string,
    accessToken: string,
    creationId: string,
  ): Promise<{ postId: string }> {
    const publishUrl = new URL(`${this.instagramApiUrl}/${userId}/media_publish`);

    this.logger.log(`Publishing media container ${creationId}`);

    const publishParams = new URLSearchParams();
    publishParams.set('access_token', accessToken);
    publishParams.set('creation_id', creationId);

    const MAX_ATTEMPTS = 3;
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const publishResponse = await fetch(publishUrl.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: publishParams,
      });

      if (publishResponse.ok) {
        const publishData = await publishResponse.json();
        this.logger.log(`Instagram post published successfully: ${publishData.id}`);
        return { postId: publishData.id };
      }

      const error = (await publishResponse.json().catch(() => ({}))) as {
        error?: { message?: string; error_subcode?: number; code?: number };
      };
      lastError = error;

      const subcode = error.error?.error_subcode;
      const isNotReady = subcode === 2207027;

      if (!isNotReady || attempt === MAX_ATTEMPTS) {
        this.logger.error('Failed to publish Instagram post:', error);
        throw new BadRequestException(
          error.error?.message || 'Failed to publish Instagram post',
        );
      }

      // Backoff: 3s, 6s, 12s
      const backoffMs = 3000 * Math.pow(2, attempt - 1);
      this.logger.warn(
        `IG reported "Media not ready" (subcode 2207027) on attempt ${attempt}/${MAX_ATTEMPTS} — retrying in ${backoffMs}ms`,
      );
      await new Promise((r) => setTimeout(r, backoffMs));
    }

    // Should be unreachable — the loop either returns or throws above.
    throw new BadRequestException(
      (lastError as { error?: { message?: string } })?.error?.message ||
        'Failed to publish Instagram post after retries',
    );
  }

  // ==========================================================================
  // Instagram Business Login Token Management
  // ==========================================================================

  /**
   * Exchange short-lived token for long-lived token (60 days)
   * Instagram Business Login returns short-lived tokens (1 hour)
   * This method exchanges them for long-lived tokens
   */
  async exchangeForLongLivedToken(shortLivedToken: string): Promise<{
    accessToken: string;
    expiresIn: number;
  }> {
    const clientSecret = process.env.INSTAGRAM_CLIENT_SECRET;
    if (!clientSecret) {
      throw new BadRequestException('INSTAGRAM_CLIENT_SECRET not configured');
    }

    const url = new URL('https://graph.instagram.com/access_token');
    url.searchParams.set('grant_type', 'ig_exchange_token');
    url.searchParams.set('client_secret', clientSecret);
    url.searchParams.set('access_token', shortLivedToken);

    this.logger.log('Exchanging Instagram short-lived token for long-lived token');

    const response = await fetch(url.toString());
    if (!response.ok) {
      const error = await response.text();
      this.logger.error(`Failed to exchange Instagram token: ${error}`);
      throw new BadRequestException(`Failed to exchange token: ${error}`);
    }

    const data = await response.json();
    this.logger.log(`Instagram long-lived token obtained, expires in ${data.expires_in} seconds`);

    return {
      accessToken: data.access_token,
      expiresIn: data.expires_in, // ~5184000 seconds (60 days)
    };
  }

  /**
   * Posts a comment on a published Instagram media.
   * Uses Instagram Graph API: POST /{ig-media-id}/comments
   *
   * Only works for Business and Creator accounts (User Token flow).
   *
   * @returns the new comment's ID
   */
  async postCommentWithUserToken(
    igUserAccessToken: string,
    mediaId: string,
    message: string,
  ): Promise<{ commentId: string }> {
    if (!message || !message.trim()) {
      throw new Error('Comment message is required');
    }

    // Match the file's *WithUserToken pattern: graph.instagram.com base URL
    // with form-urlencoded body for POST.
    const url = new URL(`${this.instagramApiUrl}/${mediaId}/comments`);

    const params = new URLSearchParams();
    params.set('access_token', igUserAccessToken);
    params.set('message', message);

    this.logger.log(`Posting Instagram comment on media ${mediaId}`);

    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    });

    if (!response.ok) {
      const error = (await response.json().catch(() => ({}))) as {
        error?: { message?: string; code?: number };
      };
      const reason = error?.error?.message ?? `HTTP ${response.status}`;
      this.logger.error(`Failed to post Instagram comment: ${reason}`);
      throw new Error(`Instagram comment post failed: ${reason}`);
    }

    const data = (await response.json()) as { id?: string };
    if (!data.id) {
      throw new Error('Instagram returned no comment ID');
    }

    this.logger.log(`Instagram comment posted: ${data.id}`);
    return { commentId: data.id };
  }

  /**
   * Refresh a long-lived token (extends by another 60 days)
   * Can only refresh tokens that are at least 24 hours old but not expired
   */
  async refreshLongLivedToken(longLivedToken: string): Promise<{
    accessToken: string;
    expiresIn: number;
  }> {
    const url = new URL('https://graph.instagram.com/refresh_access_token');
    url.searchParams.set('grant_type', 'ig_refresh_token');
    url.searchParams.set('access_token', longLivedToken);

    this.logger.log('Refreshing Instagram long-lived token');

    const response = await fetch(url.toString());
    if (!response.ok) {
      const error = await response.text();
      this.logger.error(`Failed to refresh Instagram token: ${error}`);
      throw new BadRequestException(`Failed to refresh token: ${error}`);
    }

    const data = await response.json();
    this.logger.log(`Instagram token refreshed, expires in ${data.expires_in} seconds`);

    return {
      accessToken: data.access_token,
      expiresIn: data.expires_in,
    };
  }

  // ==========================================================================
  // Inbox — fetch comments on a media item / reply to a comment
  // ==========================================================================

  /**
   * Fetch comments on a Business/Creator IG media post (including nested replies).
   * Uses graph.instagram.com so it works with the IG-direct token returned by
   * Instagram Business Login.
   *
   * Required scope: instagram_business_manage_comments.
   */
  async fetchMediaComments(
    igUserAccessToken: string,
    mediaId: string,
    since?: Date,
  ): Promise<InstagramComment[]> {
    // ONE-TIME diagnostic per process — verify the actual scopes granted to
    // this IG Business Login token. "Ready for testing" in the Meta App
    // console only means the scope is configurable; if it was added AFTER
    // the channel was connected, the existing token won't carry it.
    //
    // Note: IG Business Login tokens (issued by graph.instagram.com) cannot
    // be introspected via graph.facebook.com/debug_token — that's for FB
    // access tokens only. Use the IG /me/permissions endpoint instead.
    if (!InstagramService.debugTokenLoggedOnce) {
      InstagramService.debugTokenLoggedOnce = true;
      try {
        const dbg = await fetch(
          `${this.instagramApiUrl}/me/permissions?access_token=${encodeURIComponent(
            igUserAccessToken,
          )}`,
        );
        const dbgBody = await dbg.text();
        this.logger.log(
          `IG /me/permissions (first call this process): ${dbgBody.slice(0, 1000)}`,
        );
        // Also log basic /me to confirm the token can hit ANY IG endpoint —
        // helps tell "scope missing" from "token invalid".
        const me = await fetch(
          `${this.instagramApiUrl}/me?fields=id,username,account_type&access_token=${encodeURIComponent(
            igUserAccessToken,
          )}`,
        );
        const meBody = await me.text();
        this.logger.log(
          `IG /me (account_type check): ${meBody.slice(0, 500)}`,
        );
      } catch (err) {
        this.logger.warn(
          `IG token diagnostic failed: ${(err as Error).message}`,
        );
      }
    }

    const out: InstagramComment[] = [];
    let nextUrl: string | null = this.buildIgCommentsUrl(mediaId, igUserAccessToken);

    for (let i = 0; i < 5 && nextUrl; i++) {
      const res = await fetch(nextUrl);
      if (!res.ok) {
        const errText = await res.text();
        // Same graceful handling as the FB poller — Stories / Reels / deleted
        // media may not expose a /comments edge. Catch (#100) / "nonexisting
        // field" errors here so a single bad media doesn't crash the poll.
        if (
          res.status === 400 &&
          (/code"\s*:\s*100/.test(errText) ||
            /nonexisting field/i.test(errText) ||
            /aliases you requested do not exist/i.test(errText))
        ) {
          this.logger.warn(
            `Instagram fetchMediaComments: media ${mediaId} has no comments edge (story / deleted / non-commentable) — skipping`,
          );
          return out;
        }
        this.logger.error(`Instagram fetchMediaComments failed: ${errText}`);
        throw new Error(`Instagram fetchMediaComments failed: ${res.status}`);
      }

      // Diagnostic: log raw response body when the result is empty. In Meta
      // App development mode the API returns 200 OK with `data: []` for
      // comments made by accounts that aren't app testers/admins — there's
      // no error, no warning, just no data. Without this log it's impossible
      // to tell "post genuinely has no comments" from "dev-mode filter ate
      // them". Remove after the app passes Meta App Review.
      const cloned = res.clone();
      const rawBody = await cloned.text();
      try {
        const parsedForLog = JSON.parse(rawBody) as { data?: unknown[] };
        const dataLen = Array.isArray(parsedForLog.data)
          ? parsedForLog.data.length
          : 0;
        if (dataLen === 0) {
          this.logger.debug(
            `Instagram fetchMediaComments: media ${mediaId} raw response (data empty): ${rawBody.slice(0, 500)}`,
          );
        }
      } catch {
        // ignore JSON parse failure here — main path will still handle
      }
      const data = (await res.json()) as {
        data?: InstagramCommentRaw[];
        paging?: { next?: string };
      };

      for (const raw of data.data ?? []) {
        const createdAt = new Date(raw.timestamp);
        if (since && createdAt <= since) continue;

        out.push({
          id: raw.id,
          parentId: null,
          message: raw.text ?? '',
          createdAt,
          likeCount: raw.like_count ?? 0,
          author: {
            id: raw.from?.id ?? raw.username ?? '',
            name: raw.username ?? raw.from?.username ?? '',
          },
        });

        if (raw.replies?.data) {
          for (const reply of raw.replies.data) {
            const replyCreatedAt = new Date(reply.timestamp);
            if (since && replyCreatedAt <= since) continue;
            out.push({
              id: reply.id,
              parentId: raw.id,
              message: reply.text ?? '',
              createdAt: replyCreatedAt,
              likeCount: reply.like_count ?? 0,
              author: {
                id: reply.from?.id ?? reply.username ?? '',
                name: reply.username ?? reply.from?.username ?? '',
              },
            });
          }
        }
      }
      nextUrl = data.paging?.next ?? null;
    }
    return out;
  }

  private buildIgCommentsUrl(mediaId: string, igUserAccessToken: string): string {
    const url = new URL(`${this.instagramApiUrl}/${mediaId}/comments`);
    url.searchParams.set('access_token', igUserAccessToken);
    url.searchParams.set(
      'fields',
      [
        'id',
        'text',
        'timestamp',
        'username',
        'like_count',
        'from{id,username}',
        // Inline nested replies (IG depth limit is 2 — same as FB).
        'replies.limit(50){id,text,timestamp,username,like_count,from{id,username}}',
      ].join(','),
    );
    url.searchParams.set('limit', '100');
    return url.toString();
  }

  /**
   * Activate webhook delivery for this IG Business account.
   *
   * App-level webhook config in Meta Dashboard isn't enough — each IG account
   * must POST to its `/subscribed_apps` to opt in. Without this, Meta won't
   * deliver `comments` events for the account.
   *
   * Idempotent — safe to call repeatedly.
   */
  async subscribeAccountToWebhooks(
    igUserId: string,
    igUserAccessToken: string,
    fields: string[] = ['comments'],
  ): Promise<{ success: boolean }> {
    const url = new URL(`${this.instagramApiUrl}/${igUserId}/subscribed_apps`);
    url.searchParams.set('access_token', igUserAccessToken);
    url.searchParams.set('subscribed_fields', fields.join(','));

    const res = await fetch(url.toString(), { method: 'POST' });
    if (!res.ok) {
      const err = await res.text();
      this.logger.error(`IG subscribeAccountToWebhooks failed for ${igUserId}: ${err}`);
      throw new Error(`IG webhook subscription failed: ${res.status} ${err}`);
    }
    const data = (await res.json()) as { success?: boolean };
    this.logger.log(
      `IG account ${igUserId} subscribed to webhook fields [${fields.join(',')}]`,
    );
    return { success: data.success ?? true };
  }

  /**
   * Reply to an existing IG comment (nested under it).
   * Uses POST /{comment-id}/replies — same auth as posting top-level comments.
   */
  async replyToCommentWithUserToken(
    igUserAccessToken: string,
    parentCommentId: string,
    message: string,
  ): Promise<{ commentId: string }> {
    const url = new URL(`${this.instagramApiUrl}/${parentCommentId}/replies`);
    const params = new URLSearchParams();
    params.set('access_token', igUserAccessToken);
    params.set('message', message);

    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    });

    if (!res.ok) {
      const err = await res.text();
      this.logger.error(`Instagram replyToComment failed: ${err}`);
      throw new Error(`Instagram replyToComment failed: ${res.status} ${err}`);
    }

    const data = (await res.json()) as { id?: string };
    if (!data.id) throw new Error('Instagram returned no reply id');
    return { commentId: data.id };
  }

  // ==========================================================================
  // Instagram Direct DM — Phase 2.1.ig-impl
  // ==========================================================================
  // Uses the IG Business Login API host (graph.instagram.com) since that's
  // the auth flow the user wired in the Meta dashboard. Endpoints mirror the
  // FB Messenger unified Messaging API.

  /**
   * Resolve an IG sender (IGSID) to their public profile. Webhook payloads
   * only include the IGSID — name + avatar fetched via this call.
   */
  async getInstagramUserProfile(
    igsid: string,
    accessToken: string,
  ): Promise<{
    name: string | null;
    username: string | null;
    profilePictureUrl: string | null;
  } | null> {
    try {
      const url = new URL(`${this.instagramApiUrl}/v22.0/${igsid}`);
      url.searchParams.set('fields', 'name,username,profile_pic');
      url.searchParams.set('access_token', accessToken);

      const res = await fetch(url.toString());
      if (!res.ok) {
        const err = await res.text();
        this.logger.warn(
          `IG getUserProfile failed for igsid=${igsid}: ${res.status} ${err}`,
        );
        return null;
      }
      const data = (await res.json()) as {
        name?: string;
        username?: string;
        profile_pic?: string;
      };
      return {
        name: data.name ?? null,
        username: data.username ?? null,
        profilePictureUrl: data.profile_pic ?? null,
      };
    } catch (err) {
      this.logger.warn(
        `IG getUserProfile threw for igsid=${igsid}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * List IG Direct conversations.
   *
   * Endpoint: GET /v22.0/<ig-user-id>/conversations
   *   ?platform=instagram&fields=participants,updated_time,unread_count,
   *           messages.limit(1){message,from,created_time,id}
   */
  async listDmConversations(
    igUserId: string,
    accessToken: string,
    _since?: Date,
  ): Promise<DmConversationSummary[]> {
    const url = new URL(`${this.instagramApiUrl}/v22.0/${igUserId}/conversations`);
    url.searchParams.set('platform', 'instagram');
    url.searchParams.set(
      'fields',
      'participants,updated_time,unread_count,messages.limit(1){message,from,created_time,id}',
    );
    url.searchParams.set('limit', '50');
    url.searchParams.set('access_token', accessToken);

    const res = await fetch(url.toString());
    if (!res.ok) {
      const err = await res.text();
      this.logger.error(
        `IG listConversations failed for ig=${igUserId}: ${err}`,
      );
      throw new Error(`IG listConversations failed: ${res.status}`);
    }

    const data = (await res.json()) as {
      data?: Array<{
        id: string;
        participants?: { data: { id: string; username?: string; name?: string }[] };
        updated_time?: string;
        unread_count?: number;
        messages?: {
          data: Array<{
            id: string;
            message?: string;
            created_time?: string;
            from?: { id: string; username?: string };
          }>;
        };
      }>;
    };

    const summaries: DmConversationSummary[] = [];
    for (const thread of data.data ?? []) {
      const participants = thread.participants?.data ?? [];
      const otherParty = participants.find((p) => p.id !== igUserId);
      if (!otherParty) continue;

      const conversationId = `${igUserId}:${otherParty.id}`;
      const lastMessageEntry = thread.messages?.data?.[0];

      summaries.push({
        conversationId,
        participant: {
          platformId: otherParty.id,
          handle: otherParty.username ?? undefined,
          displayName: otherParty.name ?? otherParty.username ?? undefined,
        },
        lastMessageText: lastMessageEntry?.message ?? '',
        lastMessageAt: lastMessageEntry?.created_time
          ? new Date(lastMessageEntry.created_time)
          : thread.updated_time
            ? new Date(thread.updated_time)
            : new Date(),
        lastMessageFromMe: lastMessageEntry?.from?.id === igUserId,
        unreadCount: thread.unread_count ?? 0,
        metadata: { thread_id: thread.id },
      });
    }
    return summaries;
  }

  /**
   * Fetch messages in an IG conversation.
   * conversationId = `<igUserId>:<otherPartyIgsid>`.
   */
  async fetchDmThread(
    igUserId: string,
    accessToken: string,
    conversationId: string,
    _since?: Date,
  ): Promise<FetchedDm[]> {
    const [, otherPartyId] = conversationId.split(':');
    if (!otherPartyId) {
      throw new Error(`Invalid IG conversation id: ${conversationId}`);
    }

    // 1) Resolve thread_id from the other party's IGSID.
    const lookupUrl = new URL(
      `${this.instagramApiUrl}/v22.0/${igUserId}/conversations`,
    );
    lookupUrl.searchParams.set('platform', 'instagram');
    lookupUrl.searchParams.set('user_id', otherPartyId);
    lookupUrl.searchParams.set('fields', 'id');
    lookupUrl.searchParams.set('access_token', accessToken);

    const lookupRes = await fetch(lookupUrl.toString());
    if (!lookupRes.ok) {
      throw new Error(
        `IG thread lookup failed: ${lookupRes.status} ${await lookupRes.text()}`,
      );
    }
    const lookupData = (await lookupRes.json()) as { data?: { id: string }[] };
    const threadId = lookupData.data?.[0]?.id;
    if (!threadId) return [];

    // 2) Fetch messages in that thread.
    const msgUrl = new URL(`${this.instagramApiUrl}/v22.0/${threadId}/messages`);
    msgUrl.searchParams.set('fields', 'id,message,from,to,created_time');
    msgUrl.searchParams.set('limit', '100');
    msgUrl.searchParams.set('access_token', accessToken);

    const msgRes = await fetch(msgUrl.toString());
    if (!msgRes.ok) {
      throw new Error(
        `IG thread fetch failed: ${msgRes.status} ${await msgRes.text()}`,
      );
    }
    const msgData = (await msgRes.json()) as {
      data?: Array<{
        id: string;
        message?: string;
        created_time?: string;
        from?: { id: string; username?: string };
      }>;
    };

    const messages: FetchedDm[] = [];
    for (const m of msgData.data ?? []) {
      const fromMe = m.from?.id === igUserId;
      messages.push({
        conversationId,
        platformItemId: m.id,
        author: fromMe
          ? null
          : {
              platformId: m.from?.id ?? otherPartyId,
              handle: m.from?.username ?? undefined,
              displayName: m.from?.username ?? undefined,
            },
        text: m.message ?? '',
        platformCreatedAt: m.created_time ? new Date(m.created_time) : new Date(),
        fromMe,
      });
    }
    return messages;
  }

  /**
   * Send an IG Direct DM.
   * Endpoint: POST /v22.0/<ig-user-id>/messages
   *   body: { recipient: { id: igsid }, message: { text } }
   */
  async sendDirectMessage(
    igUserId: string,
    accessToken: string,
    conversationId: string,
    text: string,
  ): Promise<CreatedDm> {
    const [, recipientIgsid] = conversationId.split(':');
    if (!recipientIgsid) {
      throw new Error(`Invalid IG conversation id: ${conversationId}`);
    }

    const url = new URL(`${this.instagramApiUrl}/v22.0/${igUserId}/messages`);
    url.searchParams.set('access_token', accessToken);

    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: recipientIgsid },
        message: { text },
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      this.logger.error(`IG Direct send failed: ${err}`);
      throw new Error(`IG Direct send failed: ${res.status} ${err}`);
    }

    const data = (await res.json()) as {
      message_id?: string;
      recipient_id?: string;
    };
    if (!data.message_id) {
      throw new Error('IG Direct send: no message_id returned');
    }

    return {
      conversationId: `${igUserId}:${recipientIgsid}`,
      platformItemId: data.message_id,
      text,
      platformCreatedAt: new Date(),
    };
  }
}

// ---------------------------------------------------------------------------
// Instagram comment shapes
// ---------------------------------------------------------------------------

export interface InstagramCommentRaw {
  id: string;
  text?: string;
  timestamp: string;
  username?: string;
  like_count?: number;
  from?: { id?: string; username?: string };
  replies?: { data: InstagramCommentRaw[] };
}

export interface InstagramComment {
  id: string;
  parentId: string | null;
  message: string;
  createdAt: Date;
  likeCount: number;
  author: { id: string; name: string };
}
