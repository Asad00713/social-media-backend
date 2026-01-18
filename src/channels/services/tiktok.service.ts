import { Injectable, Logger, BadRequestException } from '@nestjs/common';

export interface TikTokUser {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  followerCount: number;
  followingCount: number;
  likesCount: number;
  videoCount: number;
  isVerified: boolean;
}

export interface TikTokVideoUploadOptions {
  title: string;
  privacyLevel?: 'PUBLIC_TO_EVERYONE' | 'MUTUAL_FOLLOW_FRIENDS' | 'FOLLOWER_OF_CREATOR' | 'SELF_ONLY';
  disableDuet?: boolean;
  disableStitch?: boolean;
  disableComment?: boolean;
  videoCoverTimestampMs?: number;
  brandContentToggle?: boolean;
  brandOrganicToggle?: boolean;
}

export interface TikTokCreatorInfo {
  creatorAvatarUrl: string;
  creatorUsername: string;
  creatorNickname: string;
  privacyLevelOptions: string[];
  commentDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
  maxVideoPostDurationSec: number;
}

@Injectable()
export class TikTokService {
  private readonly logger = new Logger(TikTokService.name);
  private readonly apiBaseUrl = 'https://open.tiktokapis.com/v2';

  /**
   * Get the authenticated user's TikTok profile
   */
  async getCurrentUser(accessToken: string): Promise<TikTokUser> {
    const response = await fetch(
      `${this.apiBaseUrl}/user/info/?fields=open_id,union_id,avatar_url,display_name,username,is_verified,follower_count,following_count,likes_count,video_count`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(`Failed to get TikTok user info: ${errorData}`);
      throw new BadRequestException('Failed to fetch TikTok profile');
    }

    const data = await response.json();

    if (data.error?.code !== 'ok' && data.error?.code) {
      this.logger.error(`TikTok API error: ${JSON.stringify(data.error)}`);
      throw new BadRequestException(data.error.message || 'TikTok API error');
    }

    const user = data.data?.user;
    if (!user) {
      throw new BadRequestException('No user data returned from TikTok');
    }

    return {
      id: user.open_id,
      username: user.username || '',
      displayName: user.display_name || '',
      avatarUrl: user.avatar_url || null,
      followerCount: user.follower_count || 0,
      followingCount: user.following_count || 0,
      likesCount: user.likes_count || 0,
      videoCount: user.video_count || 0,
      isVerified: user.is_verified || false,
    };
  }

  /**
   * Query creator info - get available posting options for the user
   * This should be called before posting to know what privacy options are available
   */
  async queryCreatorInfo(accessToken: string): Promise<TikTokCreatorInfo> {
    const response = await fetch(
      `${this.apiBaseUrl}/post/publish/creator_info/query/`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      },
    );

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(`Failed to query TikTok creator info: ${errorData}`);
      throw new BadRequestException('Failed to query creator info');
    }

    const data = await response.json();

    if (data.error?.code !== 'ok' && data.error?.code) {
      this.logger.error(`TikTok API error: ${JSON.stringify(data.error)}`);
      throw new BadRequestException(data.error.message || 'TikTok API error');
    }

    const info = data.data;
    return {
      creatorAvatarUrl: info.creator_avatar_url || '',
      creatorUsername: info.creator_username || '',
      creatorNickname: info.creator_nickname || '',
      privacyLevelOptions: info.privacy_level_options || [],
      commentDisabled: info.comment_disabled || false,
      duetDisabled: info.duet_disabled || false,
      stitchDisabled: info.stitch_disabled || false,
      maxVideoPostDurationSec: info.max_video_post_duration_sec || 600,
    };
  }

  /**
   * Post video directly from a URL (Pull from URL method)
   * This is the simplest way to post a video - TikTok will pull from your URL
   *
   * Requirements:
   * - Video must be publicly accessible
   * - Video must be between 1 second and 10 minutes
   * - Supported formats: mp4, webm, mov
   * - Max file size: 4GB
   */
  async postVideoFromUrl(
    accessToken: string,
    videoUrl: string,
    options: TikTokVideoUploadOptions,
  ): Promise<{ publishId: string }> {
    const {
      title,
      privacyLevel = 'SELF_ONLY', // Default to private for safety
      disableDuet = false,
      disableStitch = false,
      disableComment = false,
      videoCoverTimestampMs = 1000,
      brandContentToggle = false,
      brandOrganicToggle = false,
    } = options;

    // Validate title length (TikTok max is 2200 characters)
    if (title.length > 2200) {
      throw new BadRequestException('Title must be 2200 characters or less');
    }

    const requestBody: Record<string, any> = {
      post_info: {
        title,
        privacy_level: privacyLevel,
        disable_duet: disableDuet,
        disable_stitch: disableStitch,
        disable_comment: disableComment,
        video_cover_timestamp_ms: videoCoverTimestampMs,
        brand_content_toggle: brandContentToggle,
        brand_organic_toggle: brandOrganicToggle,
      },
      source_info: {
        source: 'PULL_FROM_URL',
        video_url: videoUrl,
      },
    };

    this.logger.log(`Posting video from URL: ${videoUrl}`);

    const response = await fetch(
      `${this.apiBaseUrl}/post/publish/video/init/`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json; charset=UTF-8',
        },
        body: JSON.stringify(requestBody),
      },
    );

    const responseText = await response.text();
    this.logger.log(`TikTok post response: ${responseText}`);

    let data: any;
    try {
      data = JSON.parse(responseText);
    } catch {
      this.logger.error(`Failed to parse TikTok response: ${responseText}`);
      throw new BadRequestException('Invalid response from TikTok');
    }

    if (data.error?.code && data.error.code !== 'ok') {
      this.logger.error(`TikTok API error: ${JSON.stringify(data.error)}`);
      throw new BadRequestException(
        data.error.message || `TikTok error: ${data.error.code}`,
      );
    }

    if (!data.data?.publish_id) {
      throw new BadRequestException('No publish ID returned from TikTok');
    }

    this.logger.log(`Video post initiated with publish_id: ${data.data.publish_id}`);

    return {
      publishId: data.data.publish_id,
    };
  }

  /**
   * Initialize direct file upload to Creator Inbox
   * Use this when you want to upload video chunks directly
   *
   * @param accessToken - OAuth access token
   * @param videoSize - Total video file size in bytes
   * @param chunkSize - Size of each chunk (min 5MB, max 64MB for chunks, or total size if single chunk)
   * @param totalChunkCount - Number of chunks
   */
  async initializeFileUpload(
    accessToken: string,
    videoSize: number,
    chunkSize: number,
    totalChunkCount: number,
  ): Promise<{
    publishId: string;
    uploadUrl: string;
  }> {
    // TikTok requires exact calculation:
    // total_chunk_count must equal ceil(video_size / chunk_size)
    const calculatedChunks = Math.ceil(videoSize / chunkSize);
    if (totalChunkCount !== calculatedChunks) {
      this.logger.warn(`Correcting chunk count: provided=${totalChunkCount}, calculated=${calculatedChunks}`);
      totalChunkCount = calculatedChunks;
    }

    const requestBody = {
      source_info: {
        source: 'FILE_UPLOAD',
        video_size: videoSize,
        chunk_size: chunkSize,
        total_chunk_count: totalChunkCount,
      },
    };

    this.logger.log(`Initializing file upload: size=${videoSize}, chunkSize=${chunkSize}, chunks=${totalChunkCount}`);

    const response = await fetch(
      `${this.apiBaseUrl}/post/publish/inbox/video/init/`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json; charset=UTF-8',
        },
        body: JSON.stringify(requestBody),
      },
    );

    const responseText = await response.text();
    this.logger.log(`TikTok init upload response: ${responseText}`);

    let data: any;
    try {
      data = JSON.parse(responseText);
    } catch {
      throw new BadRequestException('Invalid response from TikTok');
    }

    if (data.error?.code && data.error.code !== 'ok') {
      throw new BadRequestException(
        data.error.message || `TikTok error: ${data.error.code}`,
      );
    }

    return {
      publishId: data.data.publish_id,
      uploadUrl: data.data.upload_url,
    };
  }

  /**
   * Upload a video chunk to TikTok
   *
   * @param uploadUrl - The upload URL from initializeFileUpload
   * @param videoData - The video chunk data
   * @param chunkStart - Start byte position
   * @param chunkEnd - End byte position (exclusive)
   * @param totalSize - Total file size
   */
  async uploadVideoChunk(
    uploadUrl: string,
    videoData: ArrayBuffer,
    chunkStart: number,
    chunkEnd: number,
    totalSize: number,
  ): Promise<void> {
    const contentRange = `bytes ${chunkStart}-${chunkEnd - 1}/${totalSize}`;

    this.logger.log(`Uploading chunk: ${contentRange}`);

    const response = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': videoData.byteLength.toString(),
        'Content-Range': contentRange,
      },
      body: videoData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      this.logger.error(`Failed to upload chunk: ${errorText}`);
      throw new BadRequestException(`Failed to upload video chunk: ${response.status}`);
    }

    this.logger.log(`Chunk uploaded successfully`);
  }

  /**
   * Complete the video upload and publish
   * Call this after all chunks have been uploaded
   */
  async publishUploadedVideo(
    accessToken: string,
    publishId: string,
    options: TikTokVideoUploadOptions,
  ): Promise<{ publishId: string }> {
    const {
      title,
      privacyLevel = 'SELF_ONLY',
      disableDuet = false,
      disableStitch = false,
      disableComment = false,
      videoCoverTimestampMs = 1000,
    } = options;

    const requestBody = {
      publish_id: publishId,
      post_info: {
        title,
        privacy_level: privacyLevel,
        disable_duet: disableDuet,
        disable_stitch: disableStitch,
        disable_comment: disableComment,
        video_cover_timestamp_ms: videoCoverTimestampMs,
      },
    };

    const response = await fetch(
      `${this.apiBaseUrl}/post/publish/video/init/`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json; charset=UTF-8',
        },
        body: JSON.stringify(requestBody),
      },
    );

    const data = await response.json();

    if (data.error?.code && data.error.code !== 'ok') {
      throw new BadRequestException(
        data.error.message || `TikTok error: ${data.error.code}`,
      );
    }

    return {
      publishId: data.data.publish_id,
    };
  }

  /**
   * Upload video from URL using direct file upload method
   * Downloads the video and uploads it in chunks to TikTok's Creator Inbox
   *
   * This is useful when:
   * - The video URL requires authentication
   * - You want more control over the upload process
   * - The URL might not be directly accessible by TikTok
   *
   * NOTE: Videos uploaded via FILE_UPLOAD go to Creator Inbox.
   * The user must manually publish from the TikTok app.
   */
  async uploadVideoFromUrl(
    accessToken: string,
    videoUrl: string,
    _options: TikTokVideoUploadOptions, // Options not used for inbox uploads - user sets title/privacy in TikTok app
  ): Promise<{ publishId: string }> {
    // Download the video first
    this.logger.log(`Downloading video from: ${videoUrl}`);

    const videoResponse = await fetch(videoUrl);
    if (!videoResponse.ok) {
      throw new BadRequestException(`Failed to download video from ${videoUrl}`);
    }

    const videoBuffer = await videoResponse.arrayBuffer();
    const videoSize = videoBuffer.byteLength;

    this.logger.log(`Video downloaded: ${videoSize} bytes`);

    // Minimum video size check
    if (videoSize < 1024) {
      throw new BadRequestException('Video file is too small (minimum 1KB)');
    }

    // TikTok chunk requirements (from TikTok docs):
    // - For FILE_UPLOAD source:
    //   - If video <= 64MB: chunk_size = video_size, total_chunk_count = 1
    //   - If video > 64MB: chunk_size between 5MB-64MB, multiple chunks
    // - IMPORTANT: total_chunk_count must EXACTLY equal ceil(video_size / chunk_size)
    const MAX_SINGLE_CHUNK_SIZE = 64 * 1024 * 1024; // 64MB
    const MIN_CHUNK_SIZE = 5 * 1024 * 1024; // 5MB minimum for multi-chunk
    const PREFERRED_CHUNK_SIZE = 10 * 1024 * 1024; // 10MB preferred chunk size

    let chunkSize: number;
    let totalChunkCount: number;

    if (videoSize <= MAX_SINGLE_CHUNK_SIZE) {
      // Video is under 64MB - use single chunk with exact video size
      chunkSize = videoSize;
      totalChunkCount = 1;
      this.logger.log(`Using single chunk upload: ${chunkSize} bytes`);
    } else {
      // Video is over 64MB - use multiple chunks
      // Use a chunk size that divides evenly or close to it
      chunkSize = PREFERRED_CHUNK_SIZE;

      // Ensure chunk size is at least MIN_CHUNK_SIZE
      if (chunkSize < MIN_CHUNK_SIZE) {
        chunkSize = MIN_CHUNK_SIZE;
      }

      totalChunkCount = Math.ceil(videoSize / chunkSize);
      this.logger.log(`Using multi-chunk upload: ${totalChunkCount} chunks of ${chunkSize} bytes`);
    }

    this.logger.log(`Video size: ${videoSize}, Chunk size: ${chunkSize}, Total chunks: ${totalChunkCount}`);
    this.logger.log(`Verification: ceil(${videoSize} / ${chunkSize}) = ${Math.ceil(videoSize / chunkSize)}`);

    // Initialize the upload to Creator Inbox
    const { publishId, uploadUrl } = await this.initializeFileUpload(
      accessToken,
      videoSize,
      chunkSize,
      totalChunkCount,
    );

    // Upload chunks
    for (let i = 0; i < totalChunkCount; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, videoSize);
      const chunk = videoBuffer.slice(start, end);

      this.logger.log(`Uploading chunk ${i + 1}/${totalChunkCount}: bytes ${start}-${end - 1}`);
      await this.uploadVideoChunk(uploadUrl, chunk, start, end, videoSize);
    }

    // For inbox uploads, video is automatically sent to Creator Inbox after all chunks are uploaded
    // No separate publish step needed - user will see it in their TikTok app inbox
    this.logger.log(`Video uploaded to Creator Inbox. publish_id: ${publishId}`);
    this.logger.log(`User must open TikTok app to add title/description and publish manually.`);

    return { publishId };
  }

  /**
   * Check video publish status
   *
   * Status values:
   * - PROCESSING_UPLOAD: Video is still being uploaded
   * - PROCESSING_DOWNLOAD: TikTok is downloading the video (for PULL_FROM_URL)
   * - SEND_TO_USER_INBOX: Video sent to user's inbox for final review
   * - PUBLISH_COMPLETE: Video published successfully
   * - FAILED: Publishing failed
   */
  async getPublishStatus(
    accessToken: string,
    publishId: string,
  ): Promise<{
    status: string;
    videoId?: string;
    failReason?: string;
    publiclyAvailablePostId?: string[];
    uploadedBytes?: number;
  }> {
    const response = await fetch(
      `${this.apiBaseUrl}/post/publish/status/fetch/`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          publish_id: publishId,
        }),
      },
    );

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(`Failed to get TikTok publish status: ${errorData}`);
      throw new BadRequestException('Failed to get publish status');
    }

    const data = await response.json();

    if (data.error?.code && data.error.code !== 'ok') {
      throw new BadRequestException(data.error.message || 'TikTok API error');
    }

    const statusData = data.data;
    return {
      status: statusData.status,
      videoId: statusData.publicaly_available_post_id?.[0],
      publiclyAvailablePostId: statusData.publicaly_available_post_id,
      failReason: statusData.fail_reason,
      uploadedBytes: statusData.uploaded_bytes,
    };
  }

  /**
   * Poll for publish completion
   * Waits for the video to finish processing
   */
  async waitForPublishComplete(
    accessToken: string,
    publishId: string,
    maxWaitMs: number = 120000, // 2 minutes default
    pollIntervalMs: number = 5000, // 5 seconds
  ): Promise<{
    status: string;
    videoId?: string;
    failReason?: string;
  }> {
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      const status = await this.getPublishStatus(accessToken, publishId);

      this.logger.log(`Publish status: ${status.status}`);

      if (status.status === 'PUBLISH_COMPLETE') {
        return {
          status: 'PUBLISH_COMPLETE',
          videoId: status.videoId,
        };
      }

      if (status.status === 'FAILED') {
        return {
          status: 'FAILED',
          failReason: status.failReason,
        };
      }

      // Still processing, wait and poll again
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    // Timed out
    return {
      status: 'TIMEOUT',
      failReason: 'Publishing timed out - check status manually',
    };
  }

  /**
   * Get user's videos
   */
  async getUserVideos(
    accessToken: string,
    maxCount: number = 20,
    cursor?: string,
  ): Promise<{
    videos: Array<{
      id: string;
      title: string;
      coverImageUrl: string;
      shareUrl: string;
      viewCount: number;
      likeCount: number;
      commentCount: number;
      shareCount: number;
      createTime: number;
    }>;
    cursor: string;
    hasMore: boolean;
  }> {
    const body: Record<string, any> = {
      max_count: maxCount,
      fields: 'id,title,cover_image_url,share_url,view_count,like_count,comment_count,share_count,create_time',
    };

    if (cursor) {
      body.cursor = cursor;
    }

    const response = await fetch(`${this.apiBaseUrl}/video/list/`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(`Failed to get TikTok videos: ${errorData}`);
      throw new BadRequestException('Failed to fetch videos');
    }

    const data = await response.json();

    if (data.error?.code && data.error.code !== 'ok') {
      throw new BadRequestException(data.error.message || 'TikTok API error');
    }

    return {
      videos: (data.data?.videos || []).map((video: any) => ({
        id: video.id,
        title: video.title,
        coverImageUrl: video.cover_image_url,
        shareUrl: video.share_url,
        viewCount: video.view_count || 0,
        likeCount: video.like_count || 0,
        commentCount: video.comment_count || 0,
        shareCount: video.share_count || 0,
        createTime: video.create_time,
      })),
      cursor: data.data?.cursor || '',
      hasMore: data.data?.has_more || false,
    };
  }

  /**
   * Verify that an access token is valid
   */
  async verifyToken(accessToken: string): Promise<boolean> {
    try {
      await this.getCurrentUser(accessToken);
      return true;
    } catch {
      return false;
    }
  }
}
