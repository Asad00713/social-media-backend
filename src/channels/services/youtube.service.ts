import { Injectable, Logger, BadRequestException } from '@nestjs/common';

export interface YouTubeChannel {
  id: string;
  title: string;
  description: string;
  customUrl: string | null;
  thumbnailUrl: string | null;
  subscriberCount: number;
  videoCount: number;
  viewCount: number;
}

export interface YouTubeVideoUploadOptions {
  title: string;
  description?: string;
  privacyStatus?: 'public' | 'private' | 'unlisted';
  tags?: string[];
  categoryId?: string;
  playlistId?: string;
  madeForKids?: boolean;
  thumbnailUrl?: string;
}

export interface YouTubeUploadResult {
  videoId: string;
  videoUrl: string;
  title: string;
  status: string;
}

@Injectable()
export class YouTubeService {
  private readonly logger = new Logger(YouTubeService.name);
  private readonly apiBaseUrl = 'https://www.googleapis.com/youtube/v3';

  /**
   * Delete a YouTube comment authored by the connected channel. Phase 2.3.
   *
   * Endpoint: DELETE /youtube/v3/comments?id={commentId}
   * Requires scope: youtube.force-ssl
   */
  async deleteComment(
    accessToken: string,
    commentId: string,
  ): Promise<boolean> {
    const url = new URL(`${this.apiBaseUrl}/comments`);
    url.searchParams.set('id', commentId);
    const res = await fetch(url.toString(), {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    // YouTube returns 204 No Content on success.
    if (res.status === 204) return true;
    if (!res.ok) {
      const err = await res.text();
      this.logger.error(`YouTube deleteComment failed: ${err}`);
      throw new Error(`YouTube delete failed: ${res.status} ${err}`);
    }
    return true;
  }

  /**
   * Get the authenticated user's YouTube channel
   */
  async getCurrentChannel(accessToken: string): Promise<YouTubeChannel> {
    const url = new URL(`${this.apiBaseUrl}/channels`);
    url.searchParams.set('part', 'snippet,statistics,contentDetails');
    url.searchParams.set('mine', 'true');

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(`Failed to get YouTube channel: ${errorData}`);
      throw new BadRequestException('Failed to fetch YouTube channel');
    }

    const data = await response.json();

    if (!data.items || data.items.length === 0) {
      throw new BadRequestException(
        'No YouTube channel found for this account',
      );
    }

    const channel = data.items[0];
    const snippet = channel.snippet;
    const statistics = channel.statistics;

    return {
      id: channel.id,
      title: snippet.title,
      description: snippet.description,
      customUrl: snippet.customUrl || null,
      thumbnailUrl: snippet.thumbnails?.high?.url || snippet.thumbnails?.default?.url || null,
      subscriberCount: parseInt(statistics.subscriberCount, 10) || 0,
      videoCount: parseInt(statistics.videoCount, 10) || 0,
      viewCount: parseInt(statistics.viewCount, 10) || 0,
    };
  }

  /**
   * Verify that an access token is valid
   */
  async verifyToken(accessToken: string): Promise<boolean> {
    try {
      await this.getCurrentChannel(accessToken);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get channel playlists (for organizing videos)
   */
  async getPlaylists(
    accessToken: string,
  ): Promise<
    Array<{
      id: string;
      title: string;
      description: string;
      thumbnailUrl: string | null;
      itemCount: number;
    }>
  > {
    const url = new URL(`${this.apiBaseUrl}/playlists`);
    url.searchParams.set('part', 'snippet,contentDetails');
    url.searchParams.set('mine', 'true');
    url.searchParams.set('maxResults', '50');

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(`Failed to get YouTube playlists: ${errorData}`);
      throw new BadRequestException('Failed to fetch playlists');
    }

    const data = await response.json();

    return (data.items || []).map((playlist: any) => ({
      id: playlist.id,
      title: playlist.snippet.title,
      description: playlist.snippet.description,
      thumbnailUrl:
        playlist.snippet.thumbnails?.high?.url ||
        playlist.snippet.thumbnails?.default?.url ||
        null,
      itemCount: playlist.contentDetails.itemCount,
    }));
  }

  /**
   * Upload a video to YouTube from a URL
   * Uses resumable upload for reliability
   */
  async uploadVideoFromUrl(
    accessToken: string,
    videoUrl: string,
    options: YouTubeVideoUploadOptions,
  ): Promise<YouTubeUploadResult> {
    const {
      title,
      description = '',
      privacyStatus = 'private',
      tags = [],
      categoryId = '22', // Default: People & Blogs
      madeForKids = false,
    } = options;

    // Step 1: Download the video from URL
    this.logger.log(`Downloading video from: ${videoUrl}`);
    const videoResponse = await fetch(videoUrl);
    if (!videoResponse.ok) {
      throw new BadRequestException(`Failed to download video from ${videoUrl}`);
    }

    const videoBuffer = await videoResponse.arrayBuffer();
    const videoSize = videoBuffer.byteLength;
    const contentType = videoResponse.headers.get('content-type') || 'video/mp4';

    this.logger.log(`Video downloaded: ${videoSize} bytes, type: ${contentType}`);

    // Step 2: Initialize resumable upload session
    const uploadUrl = await this.initResumableUpload(
      accessToken,
      {
        title,
        description,
        tags,
        categoryId,
      },
      {
        privacyStatus,
        selfDeclaredMadeForKids: madeForKids,
      },
      contentType,
      videoSize,
    );

    this.logger.log(`Resumable upload initialized: ${uploadUrl}`);

    // Step 3: Upload the video
    const result = await this.uploadVideoData(uploadUrl, videoBuffer, contentType);

    this.logger.log(`Video uploaded successfully: ${result.videoId}`);

    // Step 4: Upload thumbnail if provided
    if (options.thumbnailUrl) {
      await this.uploadThumbnail(accessToken, result.videoId, options.thumbnailUrl);
    }

    // Step 5: Add to playlist if specified
    if (options.playlistId) {
      await this.addVideoToPlaylist(accessToken, result.videoId, options.playlistId);
    }

    return result;
  }

  /**
   * Upload a custom thumbnail for a video
   * Note: Requires the channel to be verified for custom thumbnails
   */
  async uploadThumbnail(
    accessToken: string,
    videoId: string,
    thumbnailUrl: string,
  ): Promise<void> {
    try {
      // Download the thumbnail image
      this.logger.log(`Downloading thumbnail from: ${thumbnailUrl}`);
      const thumbnailResponse = await fetch(thumbnailUrl);
      if (!thumbnailResponse.ok) {
        this.logger.error(`Failed to download thumbnail from ${thumbnailUrl}`);
        return; // Don't fail the whole upload for thumbnail
      }

      const thumbnailBuffer = await thumbnailResponse.arrayBuffer();
      const contentType = thumbnailResponse.headers.get('content-type') || 'image/jpeg';

      // Validate thumbnail (YouTube requirements: JPEG, PNG, GIF, BMP, max 2MB)
      const maxSize = 2 * 1024 * 1024; // 2MB
      if (thumbnailBuffer.byteLength > maxSize) {
        this.logger.error('Thumbnail exceeds 2MB limit');
        return;
      }

      // Upload thumbnail to YouTube
      const url = `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${videoId}&uploadType=media`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': contentType,
          'Content-Length': thumbnailBuffer.byteLength.toString(),
        },
        body: thumbnailBuffer,
      });

      if (!response.ok) {
        const errorData = await response.text();
        this.logger.error(`Failed to upload thumbnail: ${errorData}`);
        // Don't throw - thumbnail is optional, video was already uploaded
      } else {
        this.logger.log(`Thumbnail uploaded successfully for video ${videoId}`);
      }
    } catch (error) {
      this.logger.error(`Error uploading thumbnail: ${error}`);
      // Don't throw - thumbnail is optional
    }
  }

  /**
   * Initialize a resumable upload session
   */
  private async initResumableUpload(
    accessToken: string,
    snippet: {
      title: string;
      description: string;
      tags: string[];
      categoryId: string;
    },
    status: {
      privacyStatus: string;
      selfDeclaredMadeForKids: boolean;
    },
    contentType: string,
    contentLength: number,
  ): Promise<string> {
    const url = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status';

    const metadata = {
      snippet,
      status,
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': contentType,
        'X-Upload-Content-Length': contentLength.toString(),
      },
      body: JSON.stringify(metadata),
    });

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(`Failed to initiate resumable upload: ${errorData}`);
      throw new BadRequestException('Failed to initiate YouTube upload');
    }

    const uploadUrl = response.headers.get('location');
    if (!uploadUrl) {
      throw new BadRequestException('No upload URL returned from YouTube');
    }

    return uploadUrl;
  }

  /**
   * Upload video data to the resumable upload URL
   */
  private async uploadVideoData(
    uploadUrl: string,
    videoData: ArrayBuffer,
    contentType: string,
  ): Promise<YouTubeUploadResult> {
    const response = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': contentType,
        'Content-Length': videoData.byteLength.toString(),
      },
      body: videoData,
    });

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(`Failed to upload video data: ${errorData}`);
      throw new BadRequestException('Failed to upload video to YouTube');
    }

    const data = await response.json();

    return {
      videoId: data.id,
      videoUrl: `https://www.youtube.com/watch?v=${data.id}`,
      title: data.snippet?.title || '',
      status: data.status?.uploadStatus || 'uploaded',
    };
  }

  /**
   * Add a video to a playlist
   */
  async addVideoToPlaylist(
    accessToken: string,
    videoId: string,
    playlistId: string,
  ): Promise<void> {
    const url = new URL(`${this.apiBaseUrl}/playlistItems`);
    url.searchParams.set('part', 'snippet');

    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        snippet: {
          playlistId,
          resourceId: {
            kind: 'youtube#video',
            videoId,
          },
        },
      }),
    });

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(`Failed to add video to playlist: ${errorData}`);
      // Don't throw - playlist add is optional
    } else {
      this.logger.log(`Video ${videoId} added to playlist ${playlistId}`);
    }
  }

  /**
   * Get video status/details after upload
   */
  async getVideoStatus(
    accessToken: string,
    videoId: string,
  ): Promise<{
    id: string;
    title: string;
    status: string;
    processingStatus: string;
  }> {
    const url = new URL(`${this.apiBaseUrl}/videos`);
    url.searchParams.set('part', 'snippet,status,processingDetails');
    url.searchParams.set('id', videoId);

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(`Failed to get video status: ${errorData}`);
      throw new BadRequestException('Failed to get video status');
    }

    const data = await response.json();

    if (!data.items || data.items.length === 0) {
      throw new BadRequestException('Video not found');
    }

    const video = data.items[0];

    return {
      id: video.id,
      title: video.snippet?.title || '',
      status: video.status?.uploadStatus || 'unknown',
      processingStatus: video.processingDetails?.processingStatus || 'unknown',
    };
  }

  /**
   * Get video categories
   */
  async getCategories(
    accessToken: string,
    regionCode: string = 'US',
  ): Promise<Array<{ id: string; title: string }>> {
    const url = new URL(`${this.apiBaseUrl}/videoCategories`);
    url.searchParams.set('part', 'snippet');
    url.searchParams.set('regionCode', regionCode);

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(`Failed to get YouTube categories: ${errorData}`);
      throw new BadRequestException('Failed to fetch categories');
    }

    const data = await response.json();

    return (data.items || [])
      .filter((cat: any) => cat.snippet.assignable)
      .map((category: any) => ({
        id: category.id,
        title: category.snippet.title,
      }));
  }

  /**
   * Posts a top-level comment on a YouTube video.
   * API: commentThreads.insert
   * Quota cost: 50 units (vs ~1600 for an upload).
   *
   * Required OAuth scope: youtube.force-ssl
   *
   * @returns the new comment's ID
   */
  async postComment(
    accessToken: string,
    videoId: string,
    text: string,
  ): Promise<{ commentId: string }> {
    if (!text || !text.trim()) {
      throw new Error('Comment text is required');
    }
    if (text.length > 10000) {
      throw new Error('YouTube comments are limited to 10,000 characters');
    }

    const url = new URL('https://www.googleapis.com/youtube/v3/commentThreads');
    url.searchParams.set('part', 'snippet');

    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        snippet: {
          videoId,
          topLevelComment: {
            snippet: {
              textOriginal: text,
            },
          },
        },
      }),
    });

    if (!response.ok) {
      const error = (await response.json().catch(() => ({}))) as {
        error?: { message?: string; code?: number };
      };
      const reason = error?.error?.message ?? `HTTP ${response.status}`;
      const isAuthIssue =
        response.status === 401 ||
        response.status === 403 ||
        /insufficient/i.test(reason) ||
        /not properly authorized/i.test(reason);

      if (isAuthIssue) {
        // Inspect the actual granted scopes via Google's tokeninfo endpoint so
        // the operator can immediately see whether youtube.force-ssl was really
        // granted on this token. Without this, "insufficient permissions" is
        // ambiguous — could be missing scope, brand-channel mismatch, or video
        // settings.
        const grantedScopes = await this.debugTokenScopes(accessToken).catch(
          () => null,
        );
        this.logger.error(
          `YouTube comment auth failed (status ${response.status}). Token scopes: ${
            grantedScopes ? JSON.stringify(grantedScopes) : '<tokeninfo call failed>'
          }`,
        );
        const hasForceSsl = grantedScopes?.some((s) =>
          s.includes('youtube.force-ssl'),
        );
        const hint = hasForceSsl
          ? 'Token has youtube.force-ssl. The video may be private (private videos disallow API comments), comments may be disabled by the uploader, OR the OAuth account differs from the channel that owns the video (brand-channel mismatch).'
          : 'Token is MISSING youtube.force-ssl. Disconnect, then REVOKE the app at https://myaccount.google.com/permissions, then reconnect — Google caches consent and a simple in-app reconnect often reuses the old token.';
        throw new Error(`YouTube comment post failed: ${reason}. ${hint}`);
      }

      throw new Error(`YouTube comment post failed: ${reason}`);
    }

    const data = (await response.json()) as { id?: string };
    if (!data.id) {
      throw new Error('YouTube returned no comment ID');
    }
    this.logger.log(
      `Posted YouTube comment on video ${videoId}: ${data.id} (quota: ~50 units)`,
    );
    return { commentId: data.id };
  }

  /**
   * Inspects a Google OAuth token via the public tokeninfo endpoint and
   * returns the list of granted scopes. No additional auth required —
   * tokeninfo accepts the access token itself.
   */
  private async debugTokenScopes(accessToken: string): Promise<string[]> {
    const url = `https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=${encodeURIComponent(accessToken)}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = (await res.json()) as { scope?: string };
    return typeof data.scope === 'string' ? data.scope.split(' ').filter(Boolean) : [];
  }

  // ==========================================================================
  // Inbox — fetch + reply
  // ==========================================================================

  /**
   * Fetch all comment threads on a video, including nested replies.
   * Uses commentThreads.list (1 quota unit per call) + paginates via nextPageToken.
   * Each thread carries up to 5 inline replies; for threads with more we'd need
   * a follow-up comments.list call, but that's rare and Phase 1 lives with it.
   *
   * Cap: 5 pages = ~500 threads. Beyond that we stop to protect quota.
   */
  async fetchVideoComments(
    accessToken: string,
    videoId: string,
  ): Promise<YouTubeCommentThread[]> {
    const out: YouTubeCommentThread[] = [];
    let pageToken: string | undefined;
    let pages = 0;
    const maxPages = 5;

    while (pages < maxPages) {
      const url = new URL('https://www.googleapis.com/youtube/v3/commentThreads');
      url.searchParams.set('part', 'snippet,replies');
      url.searchParams.set('videoId', videoId);
      url.searchParams.set('maxResults', '100');
      url.searchParams.set('order', 'time');
      if (pageToken) url.searchParams.set('pageToken', pageToken);

      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) {
        const err = await res.text();
        // Known benign reasons — log at INFO and return empty, don't spam
        // ERROR + don't bubble up (poll would crash for the whole channel).
        //   - 403 commentsDisabled: uploader turned comments off
        //   - 404 videoNotFound: video deleted, private, or a non-video target
        //     (e.g. a Short that no longer exists, or a wrong ID format from
        //     an old PostTarget where we stored a stale platformPostId)
        if (res.status === 403 && /commentsDisabled/i.test(err)) {
          this.logger.log(`Comments disabled on video ${videoId}`);
          return out;
        }
        if (res.status === 404 && /videoNotFound/i.test(err)) {
          this.logger.warn(
            `YouTube fetchVideoComments: video ${videoId} not found (deleted / private / stale id)`,
          );
          return out;
        }
        this.logger.error(`YouTube fetchVideoComments failed: ${err}`);
        throw new Error(`YouTube fetchVideoComments failed: ${res.status}`);
      }

      const data = (await res.json()) as {
        items?: YouTubeCommentThread[];
        nextPageToken?: string;
      };
      if (data.items?.length) out.push(...data.items);
      if (!data.nextPageToken) break;
      pageToken = data.nextPageToken;
      pages += 1;
    }
    return out;
  }

  /**
   * Reply to an existing top-level comment.
   * Uses comments.insert (~50 quota units) with parentId = the thread's
   * top-level comment id.
   */
  async replyToComment(
    accessToken: string,
    parentCommentId: string,
    text: string,
  ): Promise<{ commentId: string }> {
    const url = new URL('https://www.googleapis.com/youtube/v3/comments');
    url.searchParams.set('part', 'snippet');

    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        snippet: {
          parentId: parentCommentId,
          textOriginal: text,
        },
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      this.logger.error(`YouTube replyToComment failed: ${err}`);
      throw new Error(`YouTube replyToComment failed: ${res.status} ${err}`);
    }
    const data = (await res.json()) as { id?: string };
    if (!data.id) throw new Error('YouTube returned no reply id');
    return { commentId: data.id };
  }
}

// ---------------------------------------------------------------------------
// YouTube commentThreads response shapes (subset used by the inbox adapter)
// ---------------------------------------------------------------------------

export interface YouTubeCommentSnippet {
  textDisplay: string;
  textOriginal: string;
  authorDisplayName: string;
  authorProfileImageUrl: string;
  authorChannelId?: { value: string };
  authorChannelUrl?: string;
  videoId?: string;
  publishedAt: string;
  updatedAt: string;
  parentId?: string;
  /** Present only on top-level comments — channel id of the video owner */
  channelId?: string;
  /** Number of likes on this comment. YouTube doesn't expose dislike counts. */
  likeCount?: number;
}

export interface YouTubeComment {
  kind: 'youtube#comment';
  id: string;
  snippet: YouTubeCommentSnippet;
}

export interface YouTubeCommentThread {
  kind: 'youtube#commentThread';
  id: string;
  snippet: {
    channelId: string;
    videoId: string;
    topLevelComment: YouTubeComment;
    totalReplyCount: number;
    canReply: boolean;
  };
  replies?: { comments: YouTubeComment[] };
}
