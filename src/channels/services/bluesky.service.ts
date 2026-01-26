import { Injectable, Logger, BadRequestException } from '@nestjs/common';

export interface BlueskySession {
  did: string; // Decentralized Identifier
  handle: string;
  accessJwt: string;
  refreshJwt: string;
}

export interface BlueskyProfile {
  did: string;
  handle: string;
  displayName: string | null;
  description: string | null;
  avatar: string | null;
  banner: string | null;
  followersCount: number;
  followsCount: number;
  postsCount: number;
}

export interface BlueskyPost {
  uri: string;
  cid: string;
}

export interface BlueskyBlob {
  $type: 'blob';
  ref: {
    $link: string;
  };
  mimeType: string;
  size: number;
}

@Injectable()
export class BlueskyService {
  private readonly logger = new Logger(BlueskyService.name);
  private readonly apiBaseUrl = 'https://bsky.social/xrpc';

  /**
   * Create a session using identifier (handle/email) and app password
   * This is the primary authentication method for Bluesky
   */
  async createSession(
    identifier: string,
    appPassword: string,
  ): Promise<BlueskySession> {
    const response = await fetch(
      `${this.apiBaseUrl}/com.atproto.server.createSession`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          identifier,
          password: appPassword,
        }),
      },
    );

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(`Failed to create Bluesky session: ${errorData}`);

      if (response.status === 401) {
        throw new BadRequestException('Invalid Bluesky credentials. Make sure you\'re using an App Password, not your account password.');
      }

      throw new BadRequestException(`Failed to authenticate with Bluesky: ${errorData}`);
    }

    const data = await response.json();

    return {
      did: data.did,
      handle: data.handle,
      accessJwt: data.accessJwt,
      refreshJwt: data.refreshJwt,
    };
  }

  /**
   * Refresh the session using a refresh token
   */
  async refreshSession(refreshJwt: string): Promise<BlueskySession> {
    const response = await fetch(
      `${this.apiBaseUrl}/com.atproto.server.refreshSession`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${refreshJwt}`,
        },
      },
    );

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(`Failed to refresh Bluesky session: ${errorData}`);
      throw new BadRequestException('Failed to refresh Bluesky session. Please reconnect your account.');
    }

    const data = await response.json();

    return {
      did: data.did,
      handle: data.handle,
      accessJwt: data.accessJwt,
      refreshJwt: data.refreshJwt,
    };
  }

  /**
   * Get the authenticated user's profile
   */
  async getProfile(accessJwt: string, actor: string): Promise<BlueskyProfile> {
    const response = await fetch(
      `${this.apiBaseUrl}/app.bsky.actor.getProfile?actor=${encodeURIComponent(actor)}`,
      {
        headers: {
          Authorization: `Bearer ${accessJwt}`,
        },
      },
    );

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(`Failed to get Bluesky profile: ${errorData}`);
      throw new BadRequestException('Failed to fetch Bluesky profile');
    }

    const data = await response.json();

    return {
      did: data.did,
      handle: data.handle,
      displayName: data.displayName || null,
      description: data.description || null,
      avatar: data.avatar || null,
      banner: data.banner || null,
      followersCount: data.followersCount || 0,
      followsCount: data.followsCount || 0,
      postsCount: data.postsCount || 0,
    };
  }

  /**
   * Create a text-only post
   */
  async createTextPost(
    accessJwt: string,
    did: string,
    text: string,
    replyTo?: { uri: string; cid: string },
  ): Promise<BlueskyPost> {
    const record: Record<string, any> = {
      $type: 'app.bsky.feed.post',
      text,
      createdAt: new Date().toISOString(),
    };

    // Parse facets (mentions, links, hashtags)
    const facets = await this.parseFacets(text);
    if (facets.length > 0) {
      record.facets = facets;
    }

    // Add reply reference if replying to another post
    if (replyTo) {
      record.reply = {
        root: replyTo,
        parent: replyTo,
      };
    }

    return this.createRecord(accessJwt, did, 'app.bsky.feed.post', record);
  }

  /**
   * Create a post with images
   */
  async createImagePost(
    accessJwt: string,
    did: string,
    text: string,
    imageUrls: string[],
    altTexts?: string[],
  ): Promise<BlueskyPost> {
    // Upload all images first
    const images: Array<{ alt: string; image: BlueskyBlob }> = [];

    for (let i = 0; i < imageUrls.length && i < 4; i++) {
      const imageUrl = imageUrls[i];
      const altText = altTexts?.[i] || '';

      // Download image from URL
      const imageResponse = await fetch(imageUrl);
      if (!imageResponse.ok) {
        throw new BadRequestException(`Failed to fetch image: ${imageUrl}`);
      }

      const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
      const mimeType = imageResponse.headers.get('content-type') || 'image/jpeg';

      // Upload to Bluesky
      const blob = await this.uploadBlob(accessJwt, imageBuffer, mimeType);
      images.push({
        alt: altText,
        image: blob,
      });
    }

    const record: Record<string, any> = {
      $type: 'app.bsky.feed.post',
      text,
      createdAt: new Date().toISOString(),
      embed: {
        $type: 'app.bsky.embed.images',
        images,
      },
    };

    // Parse facets (mentions, links, hashtags)
    const facets = await this.parseFacets(text);
    if (facets.length > 0) {
      record.facets = facets;
    }

    return this.createRecord(accessJwt, did, 'app.bsky.feed.post', record);
  }

  /**
   * Create a post with a video
   */
  async createVideoPost(
    accessJwt: string,
    did: string,
    text: string,
    videoUrl: string,
    altText?: string,
  ): Promise<BlueskyPost> {
    // Download video from URL
    const videoResponse = await fetch(videoUrl);
    if (!videoResponse.ok) {
      throw new BadRequestException(`Failed to fetch video: ${videoUrl}`);
    }

    const videoBuffer = Buffer.from(await videoResponse.arrayBuffer());
    const mimeType = videoResponse.headers.get('content-type') || 'video/mp4';

    // Upload to Bluesky
    const blob = await this.uploadBlob(accessJwt, videoBuffer, mimeType);

    const record: Record<string, any> = {
      $type: 'app.bsky.feed.post',
      text,
      createdAt: new Date().toISOString(),
      embed: {
        $type: 'app.bsky.embed.video',
        video: blob,
        alt: altText || '',
      },
    };

    // Parse facets (mentions, links, hashtags)
    const facets = await this.parseFacets(text);
    if (facets.length > 0) {
      record.facets = facets;
    }

    return this.createRecord(accessJwt, did, 'app.bsky.feed.post', record);
  }

  /**
   * Create a post with an external link (link card)
   */
  async createLinkPost(
    accessJwt: string,
    did: string,
    text: string,
    linkUrl: string,
    linkTitle: string,
    linkDescription?: string,
    linkThumbUrl?: string,
  ): Promise<BlueskyPost> {
    const external: Record<string, any> = {
      uri: linkUrl,
      title: linkTitle,
      description: linkDescription || '',
    };

    // Upload thumbnail if provided
    if (linkThumbUrl) {
      try {
        const thumbResponse = await fetch(linkThumbUrl);
        if (thumbResponse.ok) {
          const thumbBuffer = Buffer.from(await thumbResponse.arrayBuffer());
          const mimeType = thumbResponse.headers.get('content-type') || 'image/jpeg';
          const blob = await this.uploadBlob(accessJwt, thumbBuffer, mimeType);
          external.thumb = blob;
        }
      } catch (error) {
        this.logger.warn(`Failed to upload link thumbnail: ${error}`);
        // Continue without thumbnail
      }
    }

    const record: Record<string, any> = {
      $type: 'app.bsky.feed.post',
      text,
      createdAt: new Date().toISOString(),
      embed: {
        $type: 'app.bsky.embed.external',
        external,
      },
    };

    // Parse facets
    const facets = await this.parseFacets(text);
    if (facets.length > 0) {
      record.facets = facets;
    }

    return this.createRecord(accessJwt, did, 'app.bsky.feed.post', record);
  }

  /**
   * Upload a blob (image/video) to Bluesky
   */
  async uploadBlob(
    accessJwt: string,
    data: Buffer,
    mimeType: string,
  ): Promise<BlueskyBlob> {
    const response = await fetch(
      `${this.apiBaseUrl}/com.atproto.repo.uploadBlob`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessJwt}`,
          'Content-Type': mimeType,
        },
        body: data as unknown as BodyInit,
      },
    );

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(`Failed to upload blob to Bluesky: ${errorData}`);
      throw new BadRequestException(`Failed to upload media to Bluesky: ${errorData}`);
    }

    const result = await response.json();
    return result.blob;
  }

  /**
   * Create a record (generic method for creating posts and other records)
   */
  private async createRecord(
    accessJwt: string,
    did: string,
    collection: string,
    record: Record<string, any>,
  ): Promise<BlueskyPost> {
    const response = await fetch(
      `${this.apiBaseUrl}/com.atproto.repo.createRecord`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessJwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          repo: did,
          collection,
          record,
        }),
      },
    );

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(`Failed to create Bluesky record: ${errorData}`);
      throw new BadRequestException(`Failed to create post on Bluesky: ${errorData}`);
    }

    const data = await response.json();

    return {
      uri: data.uri,
      cid: data.cid,
    };
  }

  /**
   * Delete a post
   */
  async deletePost(accessJwt: string, did: string, postUri: string): Promise<void> {
    // Extract rkey from URI: at://did:plc:xxx/app.bsky.feed.post/rkey
    const parts = postUri.split('/');
    const rkey = parts[parts.length - 1];

    const response = await fetch(
      `${this.apiBaseUrl}/com.atproto.repo.deleteRecord`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessJwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          repo: did,
          collection: 'app.bsky.feed.post',
          rkey,
        }),
      },
    );

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(`Failed to delete Bluesky post: ${errorData}`);
      throw new BadRequestException('Failed to delete post from Bluesky');
    }
  }

  /**
   * Get user's recent posts
   */
  async getAuthorFeed(
    accessJwt: string,
    actor: string,
    limit: number = 25,
    cursor?: string,
  ): Promise<{
    posts: Array<{
      uri: string;
      cid: string;
      text: string;
      createdAt: string;
      likeCount: number;
      repostCount: number;
      replyCount: number;
    }>;
    cursor?: string;
  }> {
    const url = new URL(`${this.apiBaseUrl}/app.bsky.feed.getAuthorFeed`);
    url.searchParams.set('actor', actor);
    url.searchParams.set('limit', Math.min(limit, 100).toString());
    if (cursor) {
      url.searchParams.set('cursor', cursor);
    }

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${accessJwt}`,
      },
    });

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(`Failed to get Bluesky feed: ${errorData}`);
      throw new BadRequestException('Failed to fetch Bluesky feed');
    }

    const data = await response.json();

    return {
      posts: (data.feed || []).map((item: any) => ({
        uri: item.post.uri,
        cid: item.post.cid,
        text: item.post.record?.text || '',
        createdAt: item.post.record?.createdAt || item.post.indexedAt,
        likeCount: item.post.likeCount || 0,
        repostCount: item.post.repostCount || 0,
        replyCount: item.post.replyCount || 0,
      })),
      cursor: data.cursor,
    };
  }

  /**
   * Parse facets (mentions, links, hashtags) from text
   * Bluesky requires explicit byte positions for rich text features
   */
  private async parseFacets(text: string): Promise<any[]> {
    const facets: any[] = [];
    const encoder = new TextEncoder();
    const textBytes = encoder.encode(text);

    // Parse URLs
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    let match;
    while ((match = urlRegex.exec(text)) !== null) {
      const url = match[1];
      const start = encoder.encode(text.slice(0, match.index)).length;
      const end = start + encoder.encode(url).length;

      facets.push({
        index: { byteStart: start, byteEnd: end },
        features: [
          {
            $type: 'app.bsky.richtext.facet#link',
            uri: url,
          },
        ],
      });
    }

    // Parse mentions (@handle or @handle.bsky.social)
    const mentionRegex = /@([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?/g;
    while ((match = mentionRegex.exec(text)) !== null) {
      const mention = match[0];
      const handle = mention.slice(1); // Remove @
      const start = encoder.encode(text.slice(0, match.index)).length;
      const end = start + encoder.encode(mention).length;

      try {
        // Resolve handle to DID
        const did = await this.resolveHandle(handle);
        if (did) {
          facets.push({
            index: { byteStart: start, byteEnd: end },
            features: [
              {
                $type: 'app.bsky.richtext.facet#mention',
                did,
              },
            ],
          });
        }
      } catch {
        // Skip invalid mentions
      }
    }

    // Parse hashtags
    const hashtagRegex = /#([a-zA-Z0-9_]+)/g;
    while ((match = hashtagRegex.exec(text)) !== null) {
      const hashtag = match[0];
      const tag = match[1];
      const start = encoder.encode(text.slice(0, match.index)).length;
      const end = start + encoder.encode(hashtag).length;

      facets.push({
        index: { byteStart: start, byteEnd: end },
        features: [
          {
            $type: 'app.bsky.richtext.facet#tag',
            tag,
          },
        ],
      });
    }

    return facets;
  }

  /**
   * Resolve a handle to a DID
   */
  async resolveHandle(handle: string): Promise<string | null> {
    try {
      const response = await fetch(
        `${this.apiBaseUrl}/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`,
      );

      if (!response.ok) {
        return null;
      }

      const data = await response.json();
      return data.did || null;
    } catch {
      return null;
    }
  }

  /**
   * Verify that credentials are valid
   */
  async verifyCredentials(accessJwt: string, did: string): Promise<boolean> {
    try {
      await this.getProfile(accessJwt, did);
      return true;
    } catch {
      return false;
    }
  }
}
