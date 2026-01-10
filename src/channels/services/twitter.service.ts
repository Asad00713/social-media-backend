import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OAuth from 'oauth-1.0a';
import * as crypto from 'crypto';

export interface TwitterOAuth1Credentials {
  oauthToken: string;
  oauthTokenSecret: string;
}

export interface TwitterUser {
  id: string;
  username: string;
  name: string;
  profileImageUrl: string | null;
  description: string | null;
  verified: boolean;
  verifiedType: string | null;
  publicMetrics: {
    followersCount: number;
    followingCount: number;
    tweetCount: number;
    listedCount: number;
  };
  createdAt: string;
}

export interface Tweet {
  id: string;
  text: string;
  createdAt: string;
  publicMetrics?: {
    retweetCount: number;
    replyCount: number;
    likeCount: number;
    quoteCount: number;
    bookmarkCount: number;
    impressionCount: number;
  };
}

@Injectable()
export class TwitterService {
  private readonly logger = new Logger(TwitterService.name);
  private readonly apiBaseUrl = 'https://api.twitter.com/2';
  private readonly oauth: OAuth;

  constructor(private readonly configService: ConfigService) {
    // Initialize OAuth 1.0a for media uploads
    // Uses TWITTER_API_KEY and TWITTER_API_SECRET from .env (OAuth 1.0a credentials)
    // Note: These are different from TWITTER_CLIENT_ID/SECRET which are OAuth 2.0 credentials
    this.oauth = new OAuth({
      consumer: {
        key: this.configService.get<string>('TWITTER_API_KEY') || '',
        secret: this.configService.get<string>('TWITTER_API_SECRET') || '',
      },
      signature_method: 'HMAC-SHA1',
      hash_function(baseString: string, key: string) {
        return crypto.createHmac('sha1', key).update(baseString).digest('base64');
      },
    });
  }

  /**
   * Get the authenticated user's Twitter profile
   */
  async getCurrentUser(accessToken: string): Promise<TwitterUser> {
    const response = await fetch(
      `${this.apiBaseUrl}/users/me?user.fields=id,name,username,profile_image_url,description,verified,verified_type,public_metrics,created_at`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(`Failed to get Twitter user info: ${errorData}`);
      throw new BadRequestException('Failed to fetch Twitter profile');
    }

    const data = await response.json();

    if (data.errors) {
      this.logger.error(`Twitter API error: ${JSON.stringify(data.errors)}`);
      throw new BadRequestException(data.errors[0]?.message || 'Twitter API error');
    }

    const user = data.data;
    if (!user) {
      throw new BadRequestException('No user data returned from Twitter');
    }

    return {
      id: user.id,
      username: user.username,
      name: user.name,
      profileImageUrl: user.profile_image_url || null,
      description: user.description || null,
      verified: user.verified || false,
      verifiedType: user.verified_type || null,
      publicMetrics: {
        followersCount: user.public_metrics?.followers_count || 0,
        followingCount: user.public_metrics?.following_count || 0,
        tweetCount: user.public_metrics?.tweet_count || 0,
        listedCount: user.public_metrics?.listed_count || 0,
      },
      createdAt: user.created_at,
    };
  }

  /**
   * Post a tweet with optional media
   */
  async createTweet(
    accessToken: string,
    text: string,
    options?: {
      replyToTweetId?: string;
      quoteTweetId?: string;
      mediaIds?: string[];
    },
  ): Promise<Tweet> {
    const body: Record<string, any> = { text };

    if (options?.replyToTweetId) {
      body.reply = { in_reply_to_tweet_id: options.replyToTweetId };
    }

    if (options?.quoteTweetId) {
      body.quote_tweet_id = options.quoteTweetId;
    }

    if (options?.mediaIds && options.mediaIds.length > 0) {
      body.media = { media_ids: options.mediaIds };
    }

    const response = await fetch(`${this.apiBaseUrl}/tweets`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(`Failed to create tweet: ${response.status} - ${errorData}`);

      // Parse error for more specific message
      try {
        const errorJson = JSON.parse(errorData);
        const errorMessage = errorJson.detail || errorJson.errors?.[0]?.message || errorJson.title || errorData;
        throw new BadRequestException(`Failed to create tweet: ${errorMessage}`);
      } catch (parseError) {
        if (parseError instanceof BadRequestException) throw parseError;
        throw new BadRequestException(`Failed to create tweet: ${errorData}`);
      }
    }

    const data = await response.json();

    if (data.errors) {
      throw new BadRequestException(data.errors[0]?.message || 'Twitter API error');
    }

    return {
      id: data.data.id,
      text: data.data.text,
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Delete a tweet
   */
  async deleteTweet(accessToken: string, tweetId: string): Promise<boolean> {
    const response = await fetch(`${this.apiBaseUrl}/tweets/${tweetId}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(`Failed to delete tweet: ${errorData}`);
      throw new BadRequestException('Failed to delete tweet');
    }

    const data = await response.json();
    return data.data?.deleted || false;
  }

  /**
   * Get user's recent tweets
   */
  async getUserTweets(
    accessToken: string,
    userId: string,
    maxResults: number = 10,
    paginationToken?: string,
  ): Promise<{
    tweets: Tweet[];
    nextToken?: string;
  }> {
    const url = new URL(`${this.apiBaseUrl}/users/${userId}/tweets`);
    url.searchParams.set('max_results', Math.min(maxResults, 100).toString());
    url.searchParams.set(
      'tweet.fields',
      'id,text,created_at,public_metrics',
    );

    if (paginationToken) {
      url.searchParams.set('pagination_token', paginationToken);
    }

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(`Failed to get user tweets: ${errorData}`);
      throw new BadRequestException('Failed to fetch tweets');
    }

    const data = await response.json();

    if (data.errors) {
      throw new BadRequestException(data.errors[0]?.message || 'Twitter API error');
    }

    return {
      tweets: (data.data || []).map((tweet: any) => ({
        id: tweet.id,
        text: tweet.text,
        createdAt: tweet.created_at,
        publicMetrics: tweet.public_metrics
          ? {
              retweetCount: tweet.public_metrics.retweet_count || 0,
              replyCount: tweet.public_metrics.reply_count || 0,
              likeCount: tweet.public_metrics.like_count || 0,
              quoteCount: tweet.public_metrics.quote_count || 0,
              bookmarkCount: tweet.public_metrics.bookmark_count || 0,
              impressionCount: tweet.public_metrics.impression_count || 0,
            }
          : undefined,
      })),
      nextToken: data.meta?.next_token,
    };
  }

  /**
   * Upload media using Twitter API with OAuth 1.0a
   * Note: Media upload requires OAuth 1.0a authentication
   * Uses chunked upload for files > 5MB (required for videos)
   */
  async uploadMedia(
    accessToken: string,
    mediaData: Buffer,
    mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'video/mp4',
    oauth1Credentials?: TwitterOAuth1Credentials,
  ): Promise<string> {
    const uploadUrl = 'https://upload.twitter.com/1.1/media/upload.json';
    const fileSizeBytes = mediaData.length;
    const CHUNK_SIZE_THRESHOLD = 5 * 1024 * 1024; // 5MB

    this.logger.log(`Uploading media to Twitter: ${mediaType}, size: ${fileSizeBytes} bytes`);

    // Use chunked upload for large files (>5MB) or videos
    if (fileSizeBytes > CHUNK_SIZE_THRESHOLD || mediaType === 'video/mp4') {
      if (!oauth1Credentials) {
        throw new BadRequestException(
          'OAuth 1.0a credentials required for large file or video uploads. Please complete OAuth 1.0a authentication.',
        );
      }
      return this.uploadChunkedMedia(mediaData, mediaType, oauth1Credentials);
    }

    // Convert Buffer to base64 for Twitter API (simple upload)
    const mediaBase64 = mediaData.toString('base64');

    // If OAuth 1.0a credentials are provided, use them for media upload
    if (oauth1Credentials) {
      return this.uploadMediaWithOAuth1(uploadUrl, mediaBase64, oauth1Credentials);
    }

    // Fallback to OAuth 2.0 Bearer token (may not work for all accounts)
    const formData = new URLSearchParams();
    formData.append('media_data', mediaBase64);

    const response = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formData.toString(),
    });

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(`Failed to upload media to Twitter: ${response.status} - ${errorData}`);

      if (response.status === 401 || response.status === 403) {
        throw new BadRequestException(
          'Twitter media upload failed. Please ensure your Twitter app has OAuth 1.0a credentials configured.'
        );
      }

      throw new BadRequestException(`Failed to upload media: ${errorData}`);
    }

    const data = await response.json();
    this.logger.log(`Media uploaded successfully: ${data.media_id_string}`);
    return data.media_id_string;
  }

  /**
   * Upload large media files using Twitter's chunked upload API
   * Supports files up to 512MB for videos
   * Flow: INIT -> APPEND (chunks) -> FINALIZE -> STATUS (poll until complete)
   */
  private async uploadChunkedMedia(
    mediaData: Buffer,
    mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'video/mp4',
    credentials: TwitterOAuth1Credentials,
  ): Promise<string> {
    const uploadUrl = 'https://upload.twitter.com/1.1/media/upload.json';
    const totalBytes = mediaData.length;
    const CHUNK_SIZE = 4 * 1024 * 1024; // 4MB chunks

    // Determine media category based on type
    const mediaCategory = mediaType === 'video/mp4' ? 'tweet_video' :
                         mediaType === 'image/gif' ? 'tweet_gif' : 'tweet_image';

    this.logger.log(`Starting chunked upload: ${mediaType}, ${totalBytes} bytes, category: ${mediaCategory}`);

    // Step 1: INIT - Initialize the upload
    const initMediaId = await this.chunkedUploadInit(
      uploadUrl,
      totalBytes,
      mediaType,
      mediaCategory,
      credentials,
    );

    this.logger.log(`Chunked upload initialized: media_id=${initMediaId}`);

    // Step 2: APPEND - Upload chunks
    let segmentIndex = 0;
    for (let offset = 0; offset < totalBytes; offset += CHUNK_SIZE) {
      const chunk = mediaData.subarray(offset, Math.min(offset + CHUNK_SIZE, totalBytes));
      await this.chunkedUploadAppend(uploadUrl, initMediaId, segmentIndex, chunk, credentials);
      this.logger.log(`Uploaded chunk ${segmentIndex + 1}, bytes ${offset}-${offset + chunk.length}`);
      segmentIndex++;
    }

    // Step 3: FINALIZE - Complete the upload
    const finalizeResult = await this.chunkedUploadFinalize(uploadUrl, initMediaId, credentials);

    // Step 4: STATUS - Poll for processing completion (for videos)
    if (finalizeResult.processing_info) {
      await this.pollUploadStatus(uploadUrl, initMediaId, credentials);
    }

    this.logger.log(`Chunked upload completed: media_id=${initMediaId}`);
    return initMediaId;
  }

  /**
   * INIT command for chunked upload
   */
  private async chunkedUploadInit(
    uploadUrl: string,
    totalBytes: number,
    mediaType: string,
    mediaCategory: string,
    credentials: TwitterOAuth1Credentials,
  ): Promise<string> {
    const token = {
      key: credentials.oauthToken,
      secret: credentials.oauthTokenSecret,
    };

    const params = {
      command: 'INIT',
      total_bytes: totalBytes.toString(),
      media_type: mediaType,
      media_category: mediaCategory,
    };

    const requestData = {
      url: uploadUrl,
      method: 'POST' as const,
      data: params,
    };

    const authHeader = this.oauth.toHeader(this.oauth.authorize(requestData, token));

    const formData = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => formData.append(key, value));

    const response = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        ...authHeader,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formData.toString(),
    });

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(`Chunked upload INIT failed: ${response.status} - ${errorData}`);
      throw new BadRequestException(`Failed to initialize media upload: ${errorData}`);
    }

    const data = await response.json();
    return data.media_id_string;
  }

  /**
   * APPEND command for chunked upload
   * Uses multipart/form-data and signs OAuth without body params
   */
  private async chunkedUploadAppend(
    uploadUrl: string,
    mediaId: string,
    segmentIndex: number,
    chunk: Buffer,
    credentials: TwitterOAuth1Credentials,
  ): Promise<void> {
    const token = {
      key: credentials.oauthToken,
      secret: credentials.oauthTokenSecret,
    };

    // For APPEND with multipart, OAuth signature should NOT include body params
    // Only sign the URL without any data parameters
    const requestData = {
      url: uploadUrl,
      method: 'POST' as const,
    };

    const authHeader = this.oauth.toHeader(this.oauth.authorize(requestData, token));

    // Use multipart/form-data for chunked upload APPEND
    const boundary = `----WebKitFormBoundary${Date.now().toString(16)}`;
    const parts: string[] = [];

    // Add command
    parts.push(`--${boundary}`);
    parts.push('Content-Disposition: form-data; name="command"');
    parts.push('');
    parts.push('APPEND');

    // Add media_id
    parts.push(`--${boundary}`);
    parts.push('Content-Disposition: form-data; name="media_id"');
    parts.push('');
    parts.push(mediaId);

    // Add segment_index
    parts.push(`--${boundary}`);
    parts.push('Content-Disposition: form-data; name="segment_index"');
    parts.push('');
    parts.push(segmentIndex.toString());

    // Add media chunk (as binary)
    parts.push(`--${boundary}`);
    parts.push('Content-Disposition: form-data; name="media"; filename="chunk.mp4"');
    parts.push('Content-Type: application/octet-stream');
    parts.push('');

    // Build the multipart body
    const preMedia = parts.join('\r\n') + '\r\n';
    const postMedia = `\r\n--${boundary}--\r\n`;

    const preMediaBuffer = Buffer.from(preMedia, 'utf-8');
    const postMediaBuffer = Buffer.from(postMedia, 'utf-8');
    const body = Buffer.concat([preMediaBuffer, chunk, postMediaBuffer]);

    const response = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        ...authHeader,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length.toString(),
      },
      body,
    });

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(`Chunked upload APPEND failed: ${response.status} - ${errorData}`);
      throw new BadRequestException(`Failed to upload media chunk: ${errorData}`);
    }
  }

  /**
   * FINALIZE command for chunked upload
   */
  private async chunkedUploadFinalize(
    uploadUrl: string,
    mediaId: string,
    credentials: TwitterOAuth1Credentials,
  ): Promise<{ media_id_string: string; processing_info?: { state: string; check_after_secs?: number } }> {
    const token = {
      key: credentials.oauthToken,
      secret: credentials.oauthTokenSecret,
    };

    const params = {
      command: 'FINALIZE',
      media_id: mediaId,
    };

    const requestData = {
      url: uploadUrl,
      method: 'POST' as const,
      data: params,
    };

    const authHeader = this.oauth.toHeader(this.oauth.authorize(requestData, token));

    const formData = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => formData.append(key, value));

    const response = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        ...authHeader,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formData.toString(),
    });

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(`Chunked upload FINALIZE failed: ${response.status} - ${errorData}`);
      throw new BadRequestException(`Failed to finalize media upload: ${errorData}`);
    }

    return await response.json();
  }

  /**
   * Poll STATUS command until video processing is complete
   */
  private async pollUploadStatus(
    uploadUrl: string,
    mediaId: string,
    credentials: TwitterOAuth1Credentials,
  ): Promise<void> {
    const token = {
      key: credentials.oauthToken,
      secret: credentials.oauthTokenSecret,
    };

    const maxAttempts = 60; // Max 5 minutes (60 * 5 seconds)
    let attempts = 0;

    while (attempts < maxAttempts) {
      const statusUrl = `${uploadUrl}?command=STATUS&media_id=${mediaId}`;

      const requestData = {
        url: statusUrl,
        method: 'GET' as const,
      };

      const authHeader = this.oauth.toHeader(this.oauth.authorize(requestData, token));

      const response = await fetch(statusUrl, {
        method: 'GET',
        headers: {
          ...authHeader,
        },
      });

      if (!response.ok) {
        const errorData = await response.text();
        this.logger.error(`Chunked upload STATUS failed: ${response.status} - ${errorData}`);
        throw new BadRequestException(`Failed to check media upload status: ${errorData}`);
      }

      const data = await response.json();
      const processingInfo = data.processing_info;

      if (!processingInfo) {
        // Processing complete
        return;
      }

      const state = processingInfo.state;
      this.logger.log(`Video processing status: ${state}, progress: ${processingInfo.progress_percent || 0}%`);

      if (state === 'succeeded') {
        return;
      }

      if (state === 'failed') {
        const error = processingInfo.error?.message || 'Video processing failed';
        throw new BadRequestException(`Video processing failed: ${error}`);
      }

      // Wait before next poll
      const waitSeconds = processingInfo.check_after_secs || 5;
      await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
      attempts++;
    }

    throw new BadRequestException('Video processing timed out');
  }

  /**
   * Upload media using OAuth 1.0a authentication
   */
  private async uploadMediaWithOAuth1(
    url: string,
    mediaBase64: string,
    credentials: TwitterOAuth1Credentials,
  ): Promise<string> {
    const token = {
      key: credentials.oauthToken,
      secret: credentials.oauthTokenSecret,
    };

    const requestData = {
      url,
      method: 'POST' as const,
      data: { media_data: mediaBase64 },
    };

    // Generate OAuth authorization header
    const authHeader = this.oauth.toHeader(this.oauth.authorize(requestData, token));

    const formData = new URLSearchParams();
    formData.append('media_data', mediaBase64);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...authHeader,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formData.toString(),
    });

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(`Failed to upload media with OAuth 1.0a: ${response.status} - ${errorData}`);
      throw new BadRequestException(`Failed to upload media: ${errorData}`);
    }

    const data = await response.json();
    this.logger.log(`Media uploaded successfully with OAuth 1.0a: ${data.media_id_string}`);
    return data.media_id_string;
  }

  /**
   * Exchange OAuth 1.0a request token for access token
   */
  async getOAuth1AccessToken(
    oauthToken: string,
    oauthTokenSecret: string,
    oauthVerifier: string,
  ): Promise<TwitterOAuth1Credentials> {
    const url = 'https://api.twitter.com/oauth/access_token';

    const token = {
      key: oauthToken,
      secret: oauthTokenSecret,
    };

    const requestData = {
      url,
      method: 'POST' as const,
      data: { oauth_verifier: oauthVerifier },
    };

    const authHeader = this.oauth.toHeader(this.oauth.authorize(requestData, token));

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...authHeader,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `oauth_verifier=${oauthVerifier}`,
    });

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(`Failed to get OAuth 1.0a access token: ${errorData}`);
      throw new BadRequestException('Failed to complete Twitter OAuth 1.0a authentication');
    }

    const responseText = await response.text();
    const params = new URLSearchParams(responseText);

    return {
      oauthToken: params.get('oauth_token') || '',
      oauthTokenSecret: params.get('oauth_token_secret') || '',
    };
  }

  /**
   * Get OAuth 1.0a request token to start the auth flow
   */
  async getOAuth1RequestToken(callbackUrl: string): Promise<{
    oauthToken: string;
    oauthTokenSecret: string;
    authorizationUrl: string;
  }> {
    const url = 'https://api.twitter.com/oauth/request_token';

    const requestData = {
      url,
      method: 'POST' as const,
      data: { oauth_callback: callbackUrl },
    };

    const authHeader = this.oauth.toHeader(this.oauth.authorize(requestData));

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...authHeader,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `oauth_callback=${encodeURIComponent(callbackUrl)}`,
    });

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(`Failed to get OAuth 1.0a request token: ${errorData}`);
      throw new BadRequestException('Failed to initiate Twitter OAuth 1.0a authentication');
    }

    const responseText = await response.text();
    const params = new URLSearchParams(responseText);

    const oauthToken = params.get('oauth_token') || '';
    const oauthTokenSecret = params.get('oauth_token_secret') || '';

    return {
      oauthToken,
      oauthTokenSecret,
      authorizationUrl: `https://api.twitter.com/oauth/authorize?oauth_token=${oauthToken}`,
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
