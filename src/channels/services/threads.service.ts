import { Injectable, Logger, BadRequestException } from '@nestjs/common';

export interface ThreadsUser {
  id: string;
  username: string;
  name: string | null;
  profilePictureUrl: string | null;
  biography: string | null;
  threadsProfileUrl: string | null;
}

export interface ThreadsPost {
  id: string;
  text: string | null;
  mediaType: 'TEXT' | 'IMAGE' | 'VIDEO' | 'CAROUSEL';
  mediaUrl: string | null;
  permalink: string;
  timestamp: string;
  shortcode: string | null;
  isQuotePost: boolean;
  children?: ThreadsPost[];
  username?: string;
  hasReplies?: boolean;
}

export interface ThreadsInsights {
  views: number;
  likes: number;
  replies: number;
  reposts: number;
  quotes: number;
}

@Injectable()
export class ThreadsService {
  private readonly logger = new Logger(ThreadsService.name);
  private readonly graphApiUrl = 'https://graph.threads.net/v1.0';

  /**
   * Get Threads user profile
   * Requires user access token with threads_basic scope
   */
  async getUserProfile(accessToken: string): Promise<ThreadsUser> {
    const url = new URL(`${this.graphApiUrl}/me`);
    url.searchParams.set('access_token', accessToken);
    url.searchParams.set(
      'fields',
      'id,username,name,threads_profile_picture_url,threads_biography',
    );

    const response = await fetch(url.toString());

    if (!response.ok) {
      const error = await response.json();
      this.logger.error('Failed to fetch Threads user profile:', error);
      throw new BadRequestException(
        error.error?.message || 'Failed to fetch Threads profile',
      );
    }

    const data = await response.json();

    return {
      id: data.id,
      username: data.username,
      name: data.name || null,
      profilePictureUrl: data.threads_profile_picture_url || null,
      biography: data.threads_biography || null,
      threadsProfileUrl: data.username
        ? `https://www.threads.net/@${data.username}`
        : null,
    };
  }

  /**
   * Get user's Threads posts
   */
  async getUserThreads(
    accessToken: string,
    userId: string = 'me',
    limit: number = 25,
    after?: string,
  ): Promise<{ posts: ThreadsPost[]; nextCursor: string | null }> {
    const url = new URL(`${this.graphApiUrl}/${userId}/threads`);
    url.searchParams.set('access_token', accessToken);
    url.searchParams.set(
      'fields',
      'id,text,media_type,media_url,permalink,timestamp,shortcode,is_quote_post',
    );
    url.searchParams.set('limit', limit.toString());

    if (after) {
      url.searchParams.set('after', after);
    }

    const response = await fetch(url.toString());

    if (!response.ok) {
      const error = await response.json();
      this.logger.error('Failed to fetch Threads posts:', error);
      throw new BadRequestException(
        error.error?.message || 'Failed to fetch Threads posts',
      );
    }

    const data = await response.json();

    return {
      posts: (data.data || []).map((post: any) => ({
        id: post.id,
        text: post.text || null,
        mediaType: post.media_type,
        mediaUrl: post.media_url || null,
        permalink: post.permalink,
        timestamp: post.timestamp,
        shortcode: post.shortcode || null,
        isQuotePost: post.is_quote_post || false,
      })),
      nextCursor: data.paging?.cursors?.after || null,
    };
  }

  /**
   * Create a text-only thread
   */
  async createTextThread(
    accessToken: string,
    userId: string,
    text: string,
    replyToId?: string,
  ): Promise<{ postId: string }> {
    // Step 1: Create media container
    const containerUrl = new URL(`${this.graphApiUrl}/${userId}/threads`);

    const containerBody: Record<string, string> = {
      access_token: accessToken,
      media_type: 'TEXT',
      text: text,
    };

    if (replyToId) {
      containerBody.reply_to_id = replyToId;
    }

    const containerResponse = await fetch(containerUrl.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(containerBody),
    });

    if (!containerResponse.ok) {
      const error = await containerResponse.json();
      this.logger.error('Failed to create Threads container:', error);
      throw new BadRequestException(
        error.error?.message || 'Failed to create thread',
      );
    }

    const containerData = await containerResponse.json();
    const creationId = containerData.id;

    // Step 2: Publish the thread
    return await this.publishThread(userId, accessToken, creationId);
  }

  /**
   * Create an image thread
   */
  async createImageThread(
    accessToken: string,
    userId: string,
    imageUrl: string,
    text?: string,
    replyToId?: string,
  ): Promise<{ postId: string }> {
    // Step 1: Create media container
    const containerUrl = new URL(`${this.graphApiUrl}/${userId}/threads`);

    const containerBody: Record<string, string> = {
      access_token: accessToken,
      media_type: 'IMAGE',
      image_url: imageUrl,
    };

    if (text) {
      containerBody.text = text;
    }

    if (replyToId) {
      containerBody.reply_to_id = replyToId;
    }

    const containerResponse = await fetch(containerUrl.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(containerBody),
    });

    if (!containerResponse.ok) {
      const error = await containerResponse.json();
      this.logger.error('Failed to create Threads image container:', error);
      throw new BadRequestException(
        error.error?.message || 'Failed to create image thread',
      );
    }

    const containerData = await containerResponse.json();
    const creationId = containerData.id;

    // Step 2: Publish the thread
    return await this.publishThread(userId, accessToken, creationId);
  }

  /**
   * Create a video thread
   */
  async createVideoThread(
    accessToken: string,
    userId: string,
    videoUrl: string,
    text?: string,
    replyToId?: string,
  ): Promise<{ postId: string }> {
    // Step 1: Create media container
    const containerUrl = new URL(`${this.graphApiUrl}/${userId}/threads`);

    const containerBody: Record<string, string> = {
      access_token: accessToken,
      media_type: 'VIDEO',
      video_url: videoUrl,
    };

    if (text) {
      containerBody.text = text;
    }

    if (replyToId) {
      containerBody.reply_to_id = replyToId;
    }

    const containerResponse = await fetch(containerUrl.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(containerBody),
    });

    if (!containerResponse.ok) {
      const error = await containerResponse.json();
      this.logger.error('Failed to create Threads video container:', error);
      throw new BadRequestException(
        error.error?.message || 'Failed to create video thread',
      );
    }

    const containerData = await containerResponse.json();
    const creationId = containerData.id;

    // Wait for video to be processed
    await this.waitForMediaReady(creationId, accessToken);

    // Step 2: Publish the thread
    return await this.publishThread(userId, accessToken, creationId);
  }

  /**
   * Create a carousel thread (multiple images/videos)
   */
  async createCarouselThread(
    accessToken: string,
    userId: string,
    mediaItems: Array<{ type: 'IMAGE' | 'VIDEO'; url: string }>,
    text?: string,
    replyToId?: string,
  ): Promise<{ postId: string }> {
    if (mediaItems.length < 2 || mediaItems.length > 10) {
      throw new BadRequestException(
        'Carousel threads require between 2 and 10 media items',
      );
    }

    // Step 1: Create containers for each media item
    const childContainerIds: string[] = [];

    for (const item of mediaItems) {
      const containerUrl = new URL(`${this.graphApiUrl}/${userId}/threads`);

      const containerBody: Record<string, string> = {
        access_token: accessToken,
        is_carousel_item: 'true',
      };

      if (item.type === 'IMAGE') {
        containerBody.media_type = 'IMAGE';
        containerBody.image_url = item.url;
      } else {
        containerBody.media_type = 'VIDEO';
        containerBody.video_url = item.url;
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
        await this.waitForMediaReady(containerData.id, accessToken);
      }
    }

    // Step 2: Create carousel container
    const carouselUrl = new URL(`${this.graphApiUrl}/${userId}/threads`);

    const carouselBody: Record<string, string> = {
      access_token: accessToken,
      media_type: 'CAROUSEL',
      children: childContainerIds.join(','),
    };

    if (text) {
      carouselBody.text = text;
    }

    if (replyToId) {
      carouselBody.reply_to_id = replyToId;
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
        error.error?.message || 'Failed to create carousel thread',
      );
    }

    const carouselData = await carouselResponse.json();

    // Step 3: Publish the carousel
    return await this.publishThread(userId, accessToken, carouselData.id);
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
      url.searchParams.set('fields', 'status');

      const response = await fetch(url.toString());
      const data = await response.json();

      if (data.status === 'FINISHED') {
        return;
      }

      if (data.status === 'ERROR') {
        throw new BadRequestException('Media processing failed');
      }

      // Wait 2 seconds before next poll
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    throw new BadRequestException('Media processing timed out');
  }

  /**
   * Publish a thread container
   */
  private async publishThread(
    userId: string,
    accessToken: string,
    creationId: string,
  ): Promise<{ postId: string }> {
    const publishUrl = new URL(
      `${this.graphApiUrl}/${userId}/threads_publish`,
    );

    const publishResponse = await fetch(publishUrl.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        access_token: accessToken,
        creation_id: creationId,
      }),
    });

    if (!publishResponse.ok) {
      const error = await publishResponse.json();
      this.logger.error('Failed to publish thread:', error);
      throw new BadRequestException(
        error.error?.message || 'Failed to publish thread',
      );
    }

    const publishData = await publishResponse.json();
    return { postId: publishData.id };
  }

  /**
   * Get thread post insights
   */
  async getThreadInsights(
    accessToken: string,
    threadId: string,
  ): Promise<ThreadsInsights> {
    const url = new URL(`${this.graphApiUrl}/${threadId}/insights`);
    url.searchParams.set('access_token', accessToken);
    url.searchParams.set('metric', 'views,likes,replies,reposts,quotes');

    const response = await fetch(url.toString());

    if (!response.ok) {
      const error = await response.json();
      this.logger.error('Failed to fetch thread insights:', error);
      throw new BadRequestException(
        error.error?.message || 'Failed to fetch thread insights',
      );
    }

    const data = await response.json();
    const insights: ThreadsInsights = {
      views: 0,
      likes: 0,
      replies: 0,
      reposts: 0,
      quotes: 0,
    };

    for (const metric of data.data || []) {
      const value = metric.values?.[0]?.value || 0;
      switch (metric.name) {
        case 'views':
          insights.views = value;
          break;
        case 'likes':
          insights.likes = value;
          break;
        case 'replies':
          insights.replies = value;
          break;
        case 'reposts':
          insights.reposts = value;
          break;
        case 'quotes':
          insights.quotes = value;
          break;
      }
    }

    return insights;
  }

  /**
   * Delete a thread
   */
  async deleteThread(accessToken: string, threadId: string): Promise<boolean> {
    const url = new URL(`${this.graphApiUrl}/${threadId}`);
    url.searchParams.set('access_token', accessToken);

    const response = await fetch(url.toString(), {
      method: 'DELETE',
    });

    if (!response.ok) {
      const error = await response.json();
      this.logger.error('Failed to delete thread:', error);
      throw new BadRequestException(
        error.error?.message || 'Failed to delete thread',
      );
    }

    const data = await response.json();
    return data.success === true;
  }

  /**
   * Get replies to a thread
   */
  async getThreadReplies(
    accessToken: string,
    threadId: string,
    limit: number = 25,
    after?: string,
  ): Promise<{ replies: ThreadsPost[]; nextCursor: string | null }> {
    const url = new URL(`${this.graphApiUrl}/${threadId}/replies`);
    url.searchParams.set('access_token', accessToken);
    url.searchParams.set(
      'fields',
      'id,text,media_type,media_url,permalink,timestamp,shortcode,username,has_replies',
    );
    url.searchParams.set('limit', limit.toString());

    if (after) {
      url.searchParams.set('after', after);
    }

    // Debug: Log the URL (without token) and first 20 chars of token
    this.logger.debug(`Fetching replies from: ${this.graphApiUrl}/${threadId}/replies`);
    this.logger.debug(`Token starts with: ${accessToken.substring(0, 20)}...`);

    const response = await fetch(url.toString());

    if (!response.ok) {
      const error = await response.json();
      this.logger.error('Failed to fetch thread replies:', error);
      throw new BadRequestException(
        error.error?.message || 'Failed to fetch thread replies',
      );
    }

    const data = await response.json();

    return {
      replies: (data.data || []).map((reply: any) => ({
        id: reply.id,
        text: reply.text || null,
        mediaType: reply.media_type,
        mediaUrl: reply.media_url || null,
        permalink: reply.permalink,
        timestamp: reply.timestamp,
        shortcode: reply.shortcode || null,
        isQuotePost: false,
        username: reply.username || null,
        hasReplies: reply.has_replies || false,
      })),
      nextCursor: data.paging?.cursors?.after || null,
    };
  }

  /**
   * Get the full conversation tree for a thread (all nested replies flattened).
   * Uses the /conversation endpoint instead of /replies.
   */
  async getThreadConversation(
    accessToken: string,
    threadId: string,
    limit: number = 25,
    after?: string,
  ): Promise<{ replies: ThreadsPost[]; nextCursor: string | null }> {
    const url = new URL(`${this.graphApiUrl}/${threadId}/conversation`);
    url.searchParams.set('access_token', accessToken);
    url.searchParams.set(
      'fields',
      'id,text,media_type,media_url,permalink,timestamp,shortcode,username,has_replies',
    );
    url.searchParams.set('limit', limit.toString());

    if (after) {
      url.searchParams.set('after', after);
    }

    const response = await fetch(url.toString());

    if (!response.ok) {
      const error = await response.json();
      this.logger.error('Failed to fetch thread conversation:', error);
      throw new BadRequestException(
        error.error?.message || 'Failed to fetch thread conversation',
      );
    }

    const data = await response.json();

    return {
      replies: (data.data || []).map((reply: any) => ({
        id: reply.id,
        text: reply.text || null,
        mediaType: reply.media_type,
        mediaUrl: reply.media_url || null,
        permalink: reply.permalink,
        timestamp: reply.timestamp,
        shortcode: reply.shortcode || null,
        isQuotePost: false,
        username: reply.username || null,
        hasReplies: reply.has_replies || false,
      })),
      nextCursor: data.paging?.cursors?.after || null,
    };
  }

  /**
   * Verify token is valid
   */
  async verifyToken(accessToken: string): Promise<boolean> {
    try {
      await this.getUserProfile(accessToken);
      return true;
    } catch {
      return false;
    }
  }
}
