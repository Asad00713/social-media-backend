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
}

export interface ThreadsConversationEntry {
  id: string;
  text: string | null;
  timestamp: string;
  permalink: string | null;
  /** Parent reply id (or null if direct child of root). */
  repliedToId: string | null;
  authorId: string | null;
  authorUsername: string | null;
  shortcode: string | null;
  likeCount: number;
}

export interface ThreadsInsights {
  views: number;
  likes: number;
  replies: number;
  reposts: number;
  quotes: number;
}

export interface ThreadsMention {
  id: string;
  text: string | null;
  authorUsername: string | null;
  permalink: string | null;
  timestamp: string;
  mediaType: string | null;
}

/**
 * The post-level settings Threads takes on the container-create call.
 *
 * Field names and values are from Meta's own publishing reference, not
 * from our composer's vocabulary:
 * - `reply_control`: everyone | accounts_you_follow | mentioned_only |
 *   parent_post_author_only | followers_only
 * - `topic_tag`: one per post; periods and ampersands are rejected
 * - `is_spoiler_media`: blurs the media until tapped
 * - `enable_reply_approvals`: replies stay hidden until the author approves
 * - `poll_attachment`: 2-4 options, each 1-25 characters
 *
 * `poll_attachment` is **text-only**. Meta: "Polls can only be attached to
 * text-only posts." So only `createTextThread` accepts it, and the other
 * three take this type without the poll.
 */
export interface ThreadsPostSettings {
  replyControl?:
    | 'everyone'
    | 'accounts_you_follow'
    | 'mentioned_only'
    | 'parent_post_author_only'
    | 'followers_only';
  topicTag?: string;
  isSpoilerMedia?: boolean;
  enableReplyApprovals?: boolean;
  locationId?: string;
  /**
   * `quote_post_id` — "the ID of the post being quoted" (stated,
   * developers.facebook.com/documentation/threads/posts/quote-posts).
   */
  quotePostId?: string;
  /**
   * `allowlisted_country_codes` — "A string list of valid ISO 3166-1
   * alpha-2 country codes" (stated, .../threads/posts/geo-gating). Sent
   * comma-joined, the shape of Meta's own example (`US,CA`).
   */
  allowlistedCountryCodes?: string[];
}

/**
 * How many pages of the account's own posts a quote link is looked up in,
 * 100 posts a page. DECISION (reversible here): 3 — the last ~300 posts.
 * The lookup costs one request a page, and a post older than that is
 * rarely the one being quoted.
 */
export const THREADS_QUOTE_LOOKUP_PAGES = 3;

/**
 * The shortcode in a Threads post link (threads.com or threads.net, with
 * or without `www.`), or null. Kept identical to the composer's
 * `isThreadsPostLink` (lib/threads-more-settings.ts).
 */
export function parseThreadsPostLink(link: string): string | null {
  const match =
    /^https?:\/\/(?:www\.)?threads\.(?:com|net)\/@[^/?#\s]+\/post\/([A-Za-z0-9_-]+)\/?(?:[?#]\S*)?$/i.exec(
      link.trim(),
    );
  return match ? match[1] : null;
}

/**
 * What an image or video container takes on top of the post's settings.
 *
 * `alt_text` - "(For images and videos only.) The accessibility text label
 * or description for an image or video" (Threads posts reference and
 * developers.facebook.com/docs/threads/posts/accessibility; max 1,000
 * characters). Never on a text container: "This feature isn't available
 * for text-only posts", so only the image, video and carousel-item creates
 * read it.
 */
export interface ThreadsMediaSettings extends ThreadsPostSettings {
  altText?: string;
}

/** Threads' cap on `alt_text` (posts reference: "maximum length ... 1,000"). */
export const THREADS_ALT_TEXT_MAX_CHARS = 1000;

/** Writes `alt_text` when there is some. */
function applyAltText(
  body: Record<string, string>,
  altText: string | undefined,
): void {
  const text = altText?.trim();
  if (text) body.alt_text = text;
}

/** A poll, which rides a text container only. */
export interface ThreadsPoll {
  optionA: string;
  optionB: string;
  optionC?: string;
  optionD?: string;
}

/**
 * Writes the settings into a container body, under the names Threads uses.
 *
 * Only values that were set are written. The container-create call is a
 * form POST, so every value has to reach it as a string — a raw boolean
 * would arrive as the text "undefined" for an unset field rather than
 * being left out, and `poll_attachment` has to be JSON-encoded because it
 * is the one structured parameter here.
 */
function applySettings(
  body: Record<string, string>,
  settings?: ThreadsPostSettings,
): void {
  if (!settings) return;
  if (settings.replyControl) body.reply_control = settings.replyControl;
  if (settings.topicTag) body.topic_tag = settings.topicTag;
  if (settings.locationId) body.location_id = settings.locationId;
  // Sent only when true: absent already means "not a spoiler" / "no
  // approvals", and these are claims about the post.
  if (settings.isSpoilerMedia) body.is_spoiler_media = 'true';
  if (settings.enableReplyApprovals) body.enable_reply_approvals = 'true';
  if (settings.quotePostId) body.quote_post_id = settings.quotePostId;
  if (settings.allowlistedCountryCodes?.length) {
    body.allowlisted_country_codes = settings.allowlistedCountryCodes.join(',');
  }
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
   * The media id of one of the account's OWN posts, from its link.
   *
   * The Threads API has no documented way to turn a post link into the id
   * `quote_post_id` takes — GET /{media-id} needs the id already, and
   * keyword search does not take a URL. What it does document is the
   * account's own posts (GET /{user-id}/threads) with a `shortcode` field,
   * so the link's shortcode is matched there. Someone else's post cannot
   * be found this way, and the error says so.
   */
  async findOwnPostByLink(
    accessToken: string,
    userId: string,
    link: string,
  ): Promise<string> {
    const shortcode = parseThreadsPostLink(link);
    if (!shortcode) {
      throw new Error(`"${link}" is not a link to a Threads post`);
    }
    let cursor: string | undefined;
    for (let page = 0; page < THREADS_QUOTE_LOOKUP_PAGES; page++) {
      const { posts, nextCursor } = await this.getUserThreads(
        accessToken,
        userId,
        100,
        cursor,
      );
      const match = posts.find((p) => p.shortcode === shortcode);
      if (match) return match.id;
      if (!nextCursor) break;
      cursor = nextCursor;
    }
    throw new Error(
      'The post to quote was not found among your recent Threads posts — only your own posts can be quoted by link',
    );
  }

  /**
   * Create a text-only thread
   */
  async createTextThread(
    accessToken: string,
    userId: string,
    text: string,
    replyToId?: string,
    settings?: ThreadsPostSettings & { poll?: ThreadsPoll },
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

    applySettings(containerBody, settings);

    // The one structured parameter: a JSON object, and text-only by Meta's
    // own rule, which is why no other container type accepts it.
    if (settings?.poll) {
      const poll: Record<string, string> = {
        option_a: settings.poll.optionA,
        option_b: settings.poll.optionB,
      };
      if (settings.poll.optionC) poll.option_c = settings.poll.optionC;
      if (settings.poll.optionD) poll.option_d = settings.poll.optionD;
      containerBody.poll_attachment = JSON.stringify(poll);
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
    settings?: ThreadsMediaSettings,
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

    applySettings(containerBody, settings);
    applyAltText(containerBody, settings?.altText);

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
    settings?: ThreadsMediaSettings,
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

    applySettings(containerBody, settings);
    applyAltText(containerBody, settings?.altText);

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
    mediaItems: Array<{
      type: 'IMAGE' | 'VIDEO';
      url: string;
      altText?: string;
    }>,
    text?: string,
    replyToId?: string,
    settings?: ThreadsPostSettings,
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
      // Each slide's own description (the accessibility page: alt text works
      // "on image, video, and carousel posts").
      applyAltText(containerBody, item.altText);

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

    // The PARENT container only. An item container carries just its own
    // media; post-level settings belong to the post, and `is_spoiler_media`
    // on the parent blurs every slide — which is what the composer's one
    // toggle means.
    applySettings(carouselBody, settings);

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
    const publishUrl = new URL(`${this.graphApiUrl}/${userId}/threads_publish`);

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
      'id,text,media_type,media_url,permalink,timestamp,shortcode',
    );
    url.searchParams.set('limit', limit.toString());

    if (after) {
      url.searchParams.set('after', after);
    }

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
      })),
      nextCursor: data.paging?.cursors?.after || null,
    };
  }

  /**
   * Fetch the full conversation under a thread (post + all descendants flat).
   * Uses `conversation` endpoint with extended fields so we can reconstruct
   * nested threading + identify who wrote each reply.
   *
   * `replied_to{id}` lets us pick the parent of each reply (flat → tree).
   * `from{id,username}` lets us flag fromMe.
   */
  async getThreadConversation(
    accessToken: string,
    threadId: string,
  ): Promise<ThreadsConversationEntry[]> {
    const out: ThreadsConversationEntry[] = [];
    let after: string | undefined;

    for (let page = 0; page < 5; page++) {
      const url = new URL(`${this.graphApiUrl}/${threadId}/conversation`);
      url.searchParams.set('access_token', accessToken);
      // Threads reply objects expose the author as a FLAT `username` field —
      // NOT a nested `from{id,username}` object (that IG/FB syntax returns null
      // on Threads, which mislabels every reply). `username` is only returned
      // for PUBLIC repliers and our own account (private repliers omit it).
      url.searchParams.set(
        'fields',
        'id,text,timestamp,permalink,username,replied_to{id},shortcode,like_count',
      );
      url.searchParams.set('limit', '100');
      if (after) url.searchParams.set('after', after);

      const res = await fetch(url.toString());
      if (!res.ok) {
        const err = await res.json();
        this.logger.error('Failed to fetch Threads conversation:', err);
        throw new BadRequestException(
          err.error?.message || 'Failed to fetch Threads conversation',
        );
      }
      const data = await res.json();
      if (data.data?.length) {
        for (const entry of data.data) {
          out.push({
            id: entry.id,
            text: entry.text ?? null,
            timestamp: entry.timestamp,
            permalink: entry.permalink ?? null,
            repliedToId: entry.replied_to?.id ?? null,
            authorId: entry.from?.id ?? null,
            authorUsername: entry.username ?? entry.from?.username ?? null,
            shortcode: entry.shortcode ?? null,
            likeCount: entry.like_count ?? 0,
          });
        }
      }
      after = data.paging?.cursors?.after;
      if (!after) break;
    }

    return out;
  }

  /**
   * Posts that @mention the connected account. Requires `threads_manage_mentions`.
   * Returns [] on permission errors so channels connected before the scope was
   * added degrade gracefully instead of failing the whole poll.
   */
  async getMentions(
    accessToken: string,
    userId: string,
    since?: Date,
  ): Promise<ThreadsMention[]> {
    const url = new URL(`${this.graphApiUrl}/${userId}/mentions`);
    url.searchParams.set('access_token', accessToken);
    url.searchParams.set(
      'fields',
      'id,text,username,permalink,timestamp,media_type',
    );
    // API lower bound is 2023-07-05 (1688540400); never send anything earlier.
    if (since) {
      const sinceSec = Math.max(Math.floor(since.getTime() / 1000), 1688540400);
      url.searchParams.set('since', String(sinceSec));
    }

    const response = await fetch(url.toString());
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      this.logger.warn(
        `getMentions failed (userId=${userId}): ${error.error?.message ?? response.status}`,
      );
      return [];
    }

    const body = await response.json();
    const data: any[] = Array.isArray(body.data) ? body.data : [];
    return data.map((m) => ({
      id: String(m.id),
      text: m.text ?? null,
      authorUsername: m.username ?? null,
      permalink: m.permalink ?? null,
      timestamp: m.timestamp,
      mediaType: m.media_type ?? null,
    }));
  }

  /**
   * Hide (or unhide) a reply on one of our posts. Requires
   * `threads_manage_replies`. Hiding auto-hides all nested replies.
   */
  async manageReply(
    accessToken: string,
    replyId: string,
    hide: boolean,
  ): Promise<void> {
    const url = new URL(`${this.graphApiUrl}/${replyId}/manage_reply`);
    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ access_token: accessToken, hide }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      this.logger.error('manageReply failed:', error);
      throw new BadRequestException(
        error.error?.message || 'Failed to hide/unhide reply',
      );
    }
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
