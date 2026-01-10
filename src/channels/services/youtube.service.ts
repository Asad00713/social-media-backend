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
}
