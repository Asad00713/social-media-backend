import { Injectable, Logger, BadRequestException } from '@nestjs/common';

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
   */
  async createVideoPostWithUserToken(
    userId: string,
    accessToken: string,
    videoUrl: string,
    caption?: string,
    isReel: boolean = false,
  ): Promise<{ postId: string }> {
    this.logger.log(`Creating Instagram ${isReel ? 'reel' : 'video'} post for user ${userId}`);

    // Step 1: Create media container for video
    const containerUrl = new URL(`${this.instagramApiUrl}/${userId}/media`);

    const containerParams = new URLSearchParams();
    containerParams.set('access_token', accessToken);
    containerParams.set('video_url', videoUrl);
    containerParams.set('media_type', isReel ? 'REELS' : 'VIDEO');

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

    // Step 3: Publish the carousel
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
   * Publish a media container - Instagram Business Login version
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

    const publishResponse = await fetch(publishUrl.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: publishParams,
    });

    if (!publishResponse.ok) {
      const error = await publishResponse.json();
      this.logger.error('Failed to publish Instagram post:', error);
      throw new BadRequestException(
        error.error?.message || 'Failed to publish Instagram post',
      );
    }

    const publishData = await publishResponse.json();
    this.logger.log(`Instagram post published successfully: ${publishData.id}`);
    return { postId: publishData.id };
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
}
