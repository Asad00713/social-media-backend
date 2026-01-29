import { Injectable, Logger, BadRequestException } from '@nestjs/common';

/**
 * Facebook/Instagram Page and Account data structures
 */
export interface FacebookPage {
  id: string;
  name: string;
  accessToken: string; // Page Access Token (long-lived)
  category: string;
  pictureUrl: string | null;
  username: string | null;
  followersCount: number;
  fanCount: number;
  instagramBusinessAccount: InstagramAccount | null;
}

export interface InstagramAccount {
  id: string;
  username: string;
  name: string;
  profilePictureUrl: string | null;
  followersCount: number;
  mediaCount: number;
  biography: string | null;
}

export interface FacebookUser {
  id: string;
  name: string;
  email: string | null;
  pictureUrl: string | null;
}

@Injectable()
export class FacebookService {
  private readonly logger = new Logger(FacebookService.name);
  private readonly graphApiUrl = 'https://graph.facebook.com/v18.0';

  /**
   * Exchange short-lived token for long-lived token (60 days for user, never expires for page)
   */
  async exchangeForLongLivedToken(
    shortLivedToken: string,
    clientId: string,
    clientSecret: string,
  ): Promise<{ accessToken: string; expiresIn: number }> {
    const url = new URL(`${this.graphApiUrl}/oauth/access_token`);
    url.searchParams.set('grant_type', 'fb_exchange_token');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('client_secret', clientSecret);
    url.searchParams.set('fb_exchange_token', shortLivedToken);

    const response = await fetch(url.toString());

    if (!response.ok) {
      const error = await response.json();
      this.logger.error('Failed to exchange for long-lived token:', error);
      throw new BadRequestException(
        error.error?.message || 'Failed to exchange token',
      );
    }

    const data = await response.json();

    return {
      accessToken: data.access_token,
      expiresIn: data.expires_in || 5184000, // Default to 60 days
    };
  }

  /**
   * Get current user info
   */
  async getCurrentUser(accessToken: string): Promise<FacebookUser> {
    const url = new URL(`${this.graphApiUrl}/me`);
    url.searchParams.set('access_token', accessToken);
    url.searchParams.set('fields', 'id,name,email,picture.type(large)');

    const response = await fetch(url.toString());

    if (!response.ok) {
      const error = await response.json();
      this.logger.error('Failed to fetch user info:', error);
      throw new BadRequestException(
        error.error?.message || 'Failed to fetch user info',
      );
    }

    const data = await response.json();

    return {
      id: data.id,
      name: data.name,
      email: data.email || null,
      pictureUrl: data.picture?.data?.url || null,
    };
  }

  /**
   * Get all Facebook Pages the user manages with their Page Access Tokens
   */
  async getUserPages(userAccessToken: string): Promise<FacebookPage[]> {
    const url = new URL(`${this.graphApiUrl}/me/accounts`);
    url.searchParams.set('access_token', userAccessToken);
    url.searchParams.set(
      'fields',
      'id,name,access_token,category,picture.type(large),username,followers_count,fan_count,instagram_business_account{id,username,name,profile_picture_url,followers_count,media_count,biography}',
    );

    this.logger.log(`Fetching pages from: ${this.graphApiUrl}/me/accounts`);
    this.logger.log(`Token (first 20 chars): ${userAccessToken.substring(0, 20)}...`);

    const response = await fetch(url.toString());
    const responseText = await response.text();

    this.logger.log(`Facebook API response status: ${response.status}`);
    this.logger.log(`Facebook API response: ${responseText}`);

    if (!response.ok) {
      const error = JSON.parse(responseText);
      this.logger.error('Failed to fetch pages:', error);
      throw new BadRequestException(
        error.error?.message || 'Failed to fetch Facebook pages',
      );
    }

    const data = JSON.parse(responseText);
    const pages: FacebookPage[] = [];

    for (const page of data.data || []) {
      const facebookPage: FacebookPage = {
        id: page.id,
        name: page.name,
        accessToken: page.access_token, // This is the Page Access Token
        category: page.category || 'Page',
        pictureUrl: page.picture?.data?.url || null,
        username: page.username || null,
        followersCount: page.followers_count || 0,
        fanCount: page.fan_count || 0,
        instagramBusinessAccount: null,
      };

      // If page has connected Instagram Business Account
      if (page.instagram_business_account) {
        const ig = page.instagram_business_account;
        facebookPage.instagramBusinessAccount = {
          id: ig.id,
          username: ig.username,
          name: ig.name || ig.username,
          profilePictureUrl: ig.profile_picture_url || null,
          followersCount: ig.followers_count || 0,
          mediaCount: ig.media_count || 0,
          biography: ig.biography || null,
        };
      }

      pages.push(facebookPage);
    }

    this.logger.log(`Found ${pages.length} Facebook pages for user`);
    return pages;
  }

  /**
   * Get a single page's details with Page Access Token
   */
  async getPage(
    pageId: string,
    userAccessToken: string,
  ): Promise<FacebookPage | null> {
    const url = new URL(`${this.graphApiUrl}/${pageId}`);
    url.searchParams.set('access_token', userAccessToken);
    url.searchParams.set(
      'fields',
      'id,name,access_token,category,picture.type(large),username,followers_count,fan_count,instagram_business_account{id,username,name,profile_picture_url,followers_count,media_count,biography}',
    );

    const response = await fetch(url.toString());

    if (!response.ok) {
      const error = await response.json();
      if (error.error?.code === 190) {
        // Token expired or invalid
        return null;
      }
      this.logger.error(`Failed to fetch page ${pageId}:`, error);
      throw new BadRequestException(
        error.error?.message || 'Failed to fetch page',
      );
    }

    const page = await response.json();

    return {
      id: page.id,
      name: page.name,
      accessToken: page.access_token,
      category: page.category || 'Page',
      pictureUrl: page.picture?.data?.url || null,
      username: page.username || null,
      followersCount: page.followers_count || 0,
      fanCount: page.fan_count || 0,
      instagramBusinessAccount: page.instagram_business_account
        ? {
            id: page.instagram_business_account.id,
            username: page.instagram_business_account.username,
            name:
              page.instagram_business_account.name ||
              page.instagram_business_account.username,
            profilePictureUrl:
              page.instagram_business_account.profile_picture_url || null,
            followersCount:
              page.instagram_business_account.followers_count || 0,
            mediaCount: page.instagram_business_account.media_count || 0,
            biography: page.instagram_business_account.biography || null,
          }
        : null,
    };
  }

  /**
   * Verify a Page Access Token is valid
   */
  async verifyPageToken(
    pageAccessToken: string,
  ): Promise<{ valid: boolean; pageId: string | null; expiresAt: Date | null }> {
    const url = new URL(`${this.graphApiUrl}/debug_token`);
    url.searchParams.set('input_token', pageAccessToken);
    url.searchParams.set('access_token', pageAccessToken); // Can use the same token

    try {
      const response = await fetch(url.toString());

      if (!response.ok) {
        return { valid: false, pageId: null, expiresAt: null };
      }

      const data = await response.json();
      const tokenData = data.data;

      return {
        valid: tokenData.is_valid,
        pageId: tokenData.profile_id || null,
        expiresAt:
          tokenData.expires_at === 0
            ? null // Never expires (page tokens)
            : new Date(tokenData.expires_at * 1000),
      };
    } catch {
      return { valid: false, pageId: null, expiresAt: null };
    }
  }

  /**
   * Post to a Facebook Page
   */
  async postToPage(
    pageId: string,
    pageAccessToken: string,
    message: string,
    link?: string,
  ): Promise<{ postId: string }> {
    const url = new URL(`${this.graphApiUrl}/${pageId}/feed`);

    const body: Record<string, string> = {
      access_token: pageAccessToken,
      message,
    };

    if (link) {
      body.link = link;
    }

    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.json();
      this.logger.error(`Failed to post to page ${pageId}:`, error);
      throw new BadRequestException(
        error.error?.message || 'Failed to post to page',
      );
    }

    const data = await response.json();
    return { postId: data.id };
  }

  /**
   * Post photo to a Facebook Page
   */
  async postPhotoToPage(
    pageId: string,
    pageAccessToken: string,
    imageUrl: string,
    caption?: string,
  ): Promise<{ postId: string }> {
    const url = new URL(`${this.graphApiUrl}/${pageId}/photos`);

    const body: Record<string, string> = {
      access_token: pageAccessToken,
      url: imageUrl,
    };

    if (caption) {
      body.caption = caption;
    }

    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.json();
      this.logger.error(`Failed to post photo to page ${pageId}:`, error);
      throw new BadRequestException(
        error.error?.message || 'Failed to post photo',
      );
    }

    const data = await response.json();
    return { postId: data.post_id || data.id };
  }

  /**
   * Post a photo story to a Facebook Page
   * Photo stories use a two-step process:
   * 1. Upload photo as unpublished
   * 2. Create photo story with the photo_id
   */
  async postPhotoStoryToPage(
    pageId: string,
    pageAccessToken: string,
    imageUrl: string,
  ): Promise<{ postId: string }> {
    this.logger.log(`Creating Facebook photo story for page ${pageId}`);

    // Step 1: Upload photo as unpublished
    const photoUrl = new URL(`${this.graphApiUrl}/${pageId}/photos`);

    const photoBody: Record<string, string> = {
      access_token: pageAccessToken,
      url: imageUrl,
      published: 'false',
    };

    const photoResponse = await fetch(photoUrl.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(photoBody),
    });

    if (!photoResponse.ok) {
      const error = await photoResponse.json();
      this.logger.error('Failed to upload unpublished photo for story:', error);
      throw new BadRequestException(
        error.error?.message || 'Failed to upload photo for story',
      );
    }

    const photoData = await photoResponse.json();
    const photoId = photoData.id;
    this.logger.log(`Unpublished photo created: ${photoId}`);

    // Step 2: Create photo story
    const storyUrl = new URL(`${this.graphApiUrl}/${pageId}/photo_stories`);

    const storyBody: Record<string, string> = {
      access_token: pageAccessToken,
      photo_id: photoId,
    };

    const storyResponse = await fetch(storyUrl.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(storyBody),
    });

    if (!storyResponse.ok) {
      const error = await storyResponse.json();
      this.logger.error('Failed to create Facebook photo story:', error);
      throw new BadRequestException(
        error.error?.message || 'Failed to create Facebook photo story',
      );
    }

    const storyData = await storyResponse.json();
    this.logger.log(`Facebook photo story published: ${storyData.post_id || storyData.id}`);
    return { postId: storyData.post_id || storyData.id };
  }

  /**
   * Post a video story to a Facebook Page
   * Video stories use a three-step process:
   * 1. Start upload to get video_id and upload_url
   * 2. Upload the video binary via the upload_url
   * 3. Finish and publish the video story
   */
  async postVideoStoryToPage(
    pageId: string,
    pageAccessToken: string,
    videoUrl: string,
  ): Promise<{ postId: string }> {
    this.logger.log(`Creating Facebook video story for page ${pageId}`);

    // Step 1: Start the upload
    const startUrl = new URL(`${this.graphApiUrl}/${pageId}/video_stories`);

    const startBody: Record<string, string> = {
      access_token: pageAccessToken,
      upload_phase: 'start',
    };

    const startResponse = await fetch(startUrl.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(startBody),
    });

    if (!startResponse.ok) {
      const error = await startResponse.json();
      this.logger.error('Failed to start video story upload:', error);
      throw new BadRequestException(
        error.error?.message || 'Failed to start video story upload',
      );
    }

    const startData = await startResponse.json();
    const videoId = startData.video_id;
    const uploadUrl = startData.upload_url;
    this.logger.log(`Video story upload started, video_id: ${videoId}`);

    // Step 2: Upload the video binary
    const uploadResponse = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        Authorization: `OAuth ${pageAccessToken}`,
        file_url: videoUrl,
      },
    });

    if (!uploadResponse.ok) {
      const error = await uploadResponse.json();
      this.logger.error('Failed to upload video for story:', error);
      throw new BadRequestException(
        error.error?.message || 'Failed to upload video for story',
      );
    }

    this.logger.log('Video uploaded successfully, finishing story...');

    // Step 3: Finish and publish
    const finishUrl = new URL(`${this.graphApiUrl}/${pageId}/video_stories`);

    const finishBody: Record<string, string> = {
      access_token: pageAccessToken,
      upload_phase: 'finish',
      video_id: videoId,
    };

    const finishResponse = await fetch(finishUrl.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(finishBody),
    });

    if (!finishResponse.ok) {
      const error = await finishResponse.json();
      this.logger.error('Failed to finish video story:', error);
      throw new BadRequestException(
        error.error?.message || 'Failed to publish video story',
      );
    }

    const finishData = await finishResponse.json();
    this.logger.log(`Facebook video story published: ${finishData.post_id || finishData.id}`);
    return { postId: finishData.post_id || finishData.id };
  }

  /**
   * Post to Instagram Business Account (via Facebook Graph API)
   */
  async postToInstagram(
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
}
