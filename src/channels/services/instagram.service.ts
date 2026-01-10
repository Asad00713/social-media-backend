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
}
