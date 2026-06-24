import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import type {
  FetchedDm,
  CreatedDm,
  DmConversationSummary,
} from '../../inbox/adapters/inbox-adapter.interface';

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
  /** One-shot guard for the nested-comments diagnostic dump. */
  private static nestedDiagnosticLoggedOnce = false;

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
   * Get all Facebook Pages the user manages with their Page Access Tokens.
   *
   * Two-stage lookup to support both classic Facebook Login (returns Pages
   * via `/me/accounts` based on user-Page admin relationship) AND Facebook
   * Login for Business (FLB) which uses granular per-Page permissions —
   * with FLB, `/me/accounts` often returns empty even though Pages were
   * granted in the consent screen. In that case the granted Page IDs are
   * embedded in the token's `granular_scopes.target_ids`, so we read those
   * via `/debug_token` and fetch each Page individually.
   */
  async getUserPages(userAccessToken: string): Promise<FacebookPage[]> {
    const url = new URL(`${this.graphApiUrl}/me/accounts`);
    url.searchParams.set('access_token', userAccessToken);
    url.searchParams.set(
      'fields',
      'id,name,access_token,category,picture.type(large),username,followers_count,fan_count,instagram_business_account{id,username,name,profile_picture_url,followers_count,media_count,biography}',
    );

    this.logger.log(`Fetching pages from: ${this.graphApiUrl}/me/accounts`);
    this.logger.log(
      `Token (first 20 chars): ${userAccessToken.substring(0, 20)}...`,
    );

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
      pages.push(this.mapPage(page));
    }

    // FLB fallback — `/me/accounts` came back empty but the user may have
    // granted access to specific Pages via the new granular permissions
    // flow. The page IDs live inside the token's `granular_scopes`.
    if (pages.length === 0) {
      this.logger.log(
        'me/accounts returned empty — trying granular_scopes fallback (FLB)',
      );
      const grantedPageIds =
        await this.getGrantedPageIdsFromToken(userAccessToken);
      this.logger.log(
        `Granted page IDs from token: ${JSON.stringify(grantedPageIds)}`,
      );

      for (const pageId of grantedPageIds) {
        try {
          const page = await this.getPage(pageId, userAccessToken);
          if (page) pages.push(page);
        } catch (err) {
          this.logger.error(
            `Failed to fetch granted page ${pageId}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    }

    this.logger.log(`Found ${pages.length} Facebook pages for user`);
    return pages;
  }

  /**
   * Inspects a user access token via `/debug_token` and pulls every Page ID
   * granted to it through Facebook Login for Business' granular scopes.
   * Returns an empty array if the token has no granular_scopes (i.e. a
   * classic-Login token) — caller decides what to do then.
   */
  private async getGrantedPageIdsFromToken(
    userAccessToken: string,
  ): Promise<string[]> {
    const url = new URL(`${this.graphApiUrl}/debug_token`);
    url.searchParams.set('input_token', userAccessToken);
    url.searchParams.set('access_token', userAccessToken);

    try {
      const response = await fetch(url.toString());
      const data = await response.json();
      if (!response.ok || !data.data) {
        this.logger.error('debug_token call failed:', JSON.stringify(data));
        return [];
      }

      // Page-related scopes whose target_ids identify granted Pages.
      const pageScopes = new Set([
        'pages_show_list',
        'pages_read_engagement',
        'pages_manage_posts',
        'pages_manage_metadata',
        'pages_manage_engagement',
        'pages_read_user_content',
      ]);

      const granularScopes: Array<{
        scope: string;
        target_ids?: string[];
      }> = data.data.granular_scopes || [];

      const ids = new Set<string>();
      for (const scope of granularScopes) {
        if (!pageScopes.has(scope.scope)) continue;
        for (const id of scope.target_ids || []) ids.add(id);
      }

      return Array.from(ids);
    } catch (err) {
      this.logger.error(
        'debug_token request threw:',
        err instanceof Error ? err.message : err,
      );
      return [];
    }
  }

  /**
   * Maps a raw Facebook API page payload to our internal FacebookPage shape.
   * Extracted so both `/me/accounts` and `/{page_id}` paths can use it.
   */
  private mapPage(page: Record<string, any>): FacebookPage {
    const facebookPage: FacebookPage = {
      id: page.id,
      name: page.name,
      accessToken: page.access_token, // Page Access Token
      category: page.category || 'Page',
      pictureUrl: page.picture?.data?.url || null,
      username: page.username || null,
      followersCount: page.followers_count || 0,
      fanCount: page.fan_count || 0,
      instagramBusinessAccount: null,
    };

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

    return facebookPage;
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
  async verifyPageToken(pageAccessToken: string): Promise<{
    valid: boolean;
    pageId: string | null;
    expiresAt: Date | null;
  }> {
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
    this.logger.log(
      `Facebook photo story published: ${storyData.post_id || storyData.id}`,
    );
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
    this.logger.log(
      `Facebook video story published: ${finishData.post_id || finishData.id}`,
    );
    return { postId: finishData.post_id || finishData.id };
  }

  /**
   * Publishes a Reel to a Facebook Page using the resumable upload API with file_url.
   *
   * 3-phase flow:
   *  1. start  — POST /{page-id}/video_reels?upload_phase=start → returns video_id + upload_url
   *  2. upload — POST upload_url with `file_url` header (Facebook pulls the video)
   *  3. finish — POST /{page-id}/video_reels?upload_phase=finish&video_id=<id>&video_state=PUBLISHED&description=<caption>
   *
   * @param pageId — the Facebook Page ID
   * @param pageAccessToken — Page Access Token (NOT user token)
   * @param videoUrl — publicly accessible URL of the vertical 9:16 video
   * @param description — caption for the Reel (optional)
   * @returns the published Reel's post ID
   */
  async postReelToPage(
    pageId: string,
    pageAccessToken: string,
    videoUrl: string,
    description: string = '',
  ): Promise<{ postId: string }> {
    // Phase 1: start
    const startUrl = new URL(`${this.graphApiUrl}/${pageId}/video_reels`);
    startUrl.searchParams.set('upload_phase', 'start');
    startUrl.searchParams.set('access_token', pageAccessToken);
    const startRes = await fetch(startUrl.toString(), { method: 'POST' });
    if (!startRes.ok) {
      const err = (await startRes.json().catch(() => ({}))) as {
        error?: { message?: string };
      };
      throw new BadRequestException(
        `Facebook Reel init failed: ${err?.error?.message ?? `HTTP ${startRes.status}`}`,
      );
    }
    const startData = (await startRes.json()) as {
      video_id?: string;
      upload_url?: string;
    };
    if (!startData.video_id || !startData.upload_url) {
      throw new BadRequestException(
        'Facebook Reel start phase returned no video_id/upload_url',
      );
    }

    // Phase 2: transfer via file_url (Facebook pulls the video from the URL)
    const uploadRes = await fetch(startData.upload_url, {
      method: 'POST',
      headers: {
        Authorization: `OAuth ${pageAccessToken}`,
        file_url: videoUrl,
      },
    });
    if (!uploadRes.ok) {
      const errText = await uploadRes.text();
      this.logger.error(`Facebook Reel transfer failed: ${errText}`);
      throw new BadRequestException(
        `Facebook Reel transfer failed: HTTP ${uploadRes.status}`,
      );
    }
    const uploadData = (await uploadRes.json().catch(() => ({}))) as {
      success?: boolean;
    };
    if (uploadData.success === false) {
      throw new BadRequestException('Facebook Reel transfer reported failure');
    }

    // Phase 3: finish (publish immediately)
    const finishUrl = new URL(`${this.graphApiUrl}/${pageId}/video_reels`);
    finishUrl.searchParams.set('upload_phase', 'finish');
    finishUrl.searchParams.set('video_id', startData.video_id);
    finishUrl.searchParams.set('video_state', 'PUBLISHED');
    if (description) finishUrl.searchParams.set('description', description);
    finishUrl.searchParams.set('access_token', pageAccessToken);
    const finishRes = await fetch(finishUrl.toString(), { method: 'POST' });
    if (!finishRes.ok) {
      const err = (await finishRes.json().catch(() => ({}))) as {
        error?: { message?: string };
      };
      throw new BadRequestException(
        `Facebook Reel finish failed: ${err?.error?.message ?? `HTTP ${finishRes.status}`}`,
      );
    }
    const finishData = (await finishRes.json().catch(() => ({}))) as {
      success?: boolean;
    };
    if (finishData.success === false) {
      throw new BadRequestException('Facebook Reel finish reported failure');
    }

    // The video_id from phase 1 is the post ID for the published Reel
    this.logger.log(`Published Facebook Reel: ${startData.video_id}`);
    return { postId: startData.video_id };
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

  /**
   * Posts a comment on a published Facebook page post.
   * Uses the Graph API: POST /{post-id}/comments
   *
   * @returns the new comment's ID
   * @throws if the comment cannot be posted (caller should treat as a soft warning, not a publish failure)
   */
  async postComment(
    pageId: string,
    pageAccessToken: string,
    postId: string,
    message: string,
  ): Promise<{ commentId: string }> {
    if (!message || !message.trim()) {
      throw new Error('Comment message is required');
    }

    // Use postId AS-IS. Different FB endpoints return different ID shapes:
    //  • /feed → composite "pageid_postid" (works directly)
    //  • /video_reels → bare video_id (works directly on /{video_id}/comments)
    //  • /photo_stories / /video_stories → bare media_id (works directly)
    // Auto-prepending the pageId for bare IDs (the previous behavior) breaks
    // Reels because "pageid_videoid" is NOT a valid object on Reels.
    void pageId; // intentionally unused — kept in signature for callers that already pass it
    const url = new URL(`${this.graphApiUrl}/${postId}/comments`);
    url.searchParams.set('access_token', pageAccessToken);

    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });

    if (!response.ok) {
      const error = (await response.json().catch(() => ({}))) as {
        error?: { message?: string; code?: number };
      };
      const reason = error?.error?.message ?? `HTTP ${response.status}`;
      const code = error?.error?.code;

      // Permission-denied (#200) — surface what scopes the token ACTUALLY has
      // so the operator can immediately tell whether pages_manage_engagement
      // was actually granted or silently stripped by Meta App Console.
      if (code === 200 || /sufficient permissions/i.test(reason)) {
        const grantedScopes = await this.debugTokenScopes(
          pageAccessToken,
        ).catch(() => null);
        this.logger.error(
          `Facebook comment permission denied. Token scopes from /debug_token: ${
            grantedScopes
              ? JSON.stringify(grantedScopes)
              : '<debug_token call failed>'
          }`,
        );
        const hasEngagement = grantedScopes?.includes(
          'pages_manage_engagement',
        );
        const hint = hasEngagement
          ? 'Token DOES have pages_manage_engagement — verify the user has admin/editor role on the Page.'
          : 'Token is MISSING pages_manage_engagement. Enable it in Meta App Console (Permissions and Features) and reconnect the Facebook channel.';
        throw new Error(`Facebook comment post failed: ${reason}. ${hint}`);
      }

      throw new Error(`Facebook comment post failed: ${reason}`);
    }

    const data = (await response.json()) as { id?: string };
    if (!data.id) {
      throw new Error('Facebook returned no comment ID');
    }
    return { commentId: data.id };
  }

  /**
   * Inspects a Facebook access token via `/debug_token` and returns the
   * list of scopes (granular_scopes + legacy `scopes`) it carries.
   * Used for diagnostics when a Graph API call fails with a permission error.
   */
  private async debugTokenScopes(accessToken: string): Promise<string[]> {
    const url = new URL(`${this.graphApiUrl}/debug_token`);
    url.searchParams.set('input_token', accessToken);
    url.searchParams.set('access_token', accessToken);
    const res = await fetch(url.toString());
    if (!res.ok) return [];
    const data = (await res.json()) as {
      data?: {
        scopes?: string[];
        granular_scopes?: Array<{ scope: string }>;
      };
    };
    const flat = new Set<string>();
    for (const s of data?.data?.scopes ?? []) flat.add(s);
    for (const g of data?.data?.granular_scopes ?? []) flat.add(g.scope);
    return Array.from(flat);
  }

  // ==========================================================================
  // Inbox — fetch comments / reply to a comment
  // ==========================================================================

  /**
   * Fetch comments on a Page post (top-level + nested replies).
   * Returns FLAT — nested replies have `parent.id` pointing at the parent.
   *
   * Required scopes: pages_read_user_content (added 2026-05).
   */
  async fetchPostComments(
    pageAccessToken: string,
    postId: string,
    since?: Date,
  ): Promise<FacebookComment[]> {
    const out: FacebookComment[] = [];
    const rootIds: string[] = [];
    let nextUrl: string | null = this.buildCommentsUrl(
      postId,
      pageAccessToken,
      since,
    );

    // Cap at 5 pages to bound quota; Pages with massive comment counts are rare.
    for (let i = 0; i < 5 && nextUrl; i++) {
      const res = await fetch(nextUrl);
      if (!res.ok) {
        const errText = await res.text();
        // Known benign errors — log at WARN and return what we have. Without
        // this the poll crashes for the whole channel when a single object
        // happens to not expose /comments (FB Stories, certain Reel formats,
        // deleted posts, or our PostTarget storing an id whose object type
        // doesn't have a `comments` edge).
        //   - (#100) "Tried accessing nonexisting field (comments)" — the post
        //     id is for a media object whose edge isn't named `comments`
        //     (e.g. Stories) or has been deleted.
        //   - (#803) "Some of the aliases you requested do not exist" — same
        //     class of error, different code path.
        if (
          res.status === 400 &&
          (/code"\s*:\s*100/.test(errText) ||
            /nonexisting field/i.test(errText) ||
            /aliases you requested do not exist/i.test(errText))
        ) {
          this.logger.warn(
            `Facebook fetchPostComments: post ${postId} has no comments edge (story / deleted / non-commentable media) — skipping`,
          );
          return out;
        }
        this.logger.error(`Facebook fetchPostComments failed: ${errText}`);
        throw new Error(`Facebook fetchPostComments failed: ${res.status}`);
      }
      const data = (await res.json()) as {
        data?: FacebookCommentRaw[];
        paging?: { next?: string };
      };

      for (const raw of data.data ?? []) {
        out.push(this.toFacebookComment(raw, null));
        rootIds.push(raw.id);
      }
      nextUrl = data.paging?.next ?? null;
    }

    // Phase 2: per-root call to fetch nested replies. FB's UI flattens to
    // depth-2 visually, but in the API each reply still records its actual
    // parent — so "reply to a reply" lives under the inner reply's edge,
    // not the root's. We have to walk one level deeper (BFS, depth-cap 3)
    // to catch them all. Without this, replies-to-replies (the user's
    // "Hello" replying to "Hii" case) are silently dropped and their
    // likeCount never refreshes.
    //
    // No `since` filter — replies' `like_count` changes over time and
    // `since` (filters by `created_time`) would freeze old likeCount in DB.
    // Full re-fetch per cycle is the only reliable way to keep likes current.
    const MAX_NESTED_DEPTH = 3;
    for (const rootId of rootIds) {
      try {
        const queue: { id: string; depth: number }[] = [
          { id: rootId, depth: 0 },
        ];
        const visited = new Set<string>([rootId]);
        while (queue.length > 0) {
          const { id, depth } = queue.shift()!;
          if (depth >= MAX_NESTED_DEPTH) continue;
          const replies = await this.fetchCommentReplies(pageAccessToken, id);
          for (const reply of replies) {
            if (visited.has(reply.id)) continue;
            visited.add(reply.id);
            out.push(this.toFacebookComment(reply, id));
            queue.push({ id: reply.id, depth: depth + 1 });
          }
        }
      } catch (err) {
        this.logger.warn(
          `Facebook fetchCommentReplies failed for ${rootId}: ${(err as Error).message}`,
        );
      }
    }

    return out;
  }

  /**
   * Pull every nested reply under a top-level comment via the dedicated
   * `/{comment-id}/comments` endpoint. Reliable pagination, returns every
   * requested field — unlike the parent-level expansion which silently
   * truncates and drops sub-fields.
   */
  private async fetchCommentReplies(
    pageAccessToken: string,
    commentId: string,
  ): Promise<FacebookCommentRaw[]> {
    const out: FacebookCommentRaw[] = [];
    const url = new URL(`${this.graphApiUrl}/${commentId}/comments`);
    url.searchParams.set('access_token', pageAccessToken);
    url.searchParams.set(
      'fields',
      [
        'id',
        'message',
        'created_time',
        'like_count',
        'from{id,name,picture}',
        'parent{id}',
      ].join(','),
    );
    url.searchParams.set('limit', '100');

    let nextUrl: string | null = url.toString();
    for (let i = 0; i < 3 && nextUrl; i++) {
      const res = await fetch(nextUrl);
      if (!res.ok) {
        const errText = await res.text();
        if (
          res.status === 400 &&
          (/code"\s*:\s*100/.test(errText) ||
            /nonexisting field/i.test(errText))
        ) {
          return out;
        }
        throw new Error(`FB replies fetch failed: ${res.status} ${errText}`);
      }
      const data = (await res.json()) as {
        data?: FacebookCommentRaw[];
        paging?: { next?: string };
      };
      if (data.data?.length) out.push(...data.data);
      nextUrl = data.paging?.next ?? null;
    }
    return out;
  }

  private buildCommentsUrl(
    postId: string,
    pageAccessToken: string,
    _since?: Date,
  ): string {
    const url = new URL(`${this.graphApiUrl}/${postId}/comments`);
    url.searchParams.set('access_token', pageAccessToken);
    url.searchParams.set(
      'fields',
      [
        'id',
        'message',
        'created_time',
        'like_count',
        'from{id,name,picture}',
        // Note: deliberately NOT requesting nested via `comments.limit(N){...}`.
        // FB's expansion silently caps + drops fields on the sub-edge. We
        // fetch each root's replies via a separate /{comment-id}/comments
        // call instead (see fetchCommentReplies).
      ].join(','),
    );
    url.searchParams.set('limit', '100');
    // NOTE: `since` filter intentionally NOT applied. FB Graph's `since` is
    // a `created_time` filter — it excludes existing comments whose likes
    // might have changed, leaving their stale likeCount in our DB forever.
    // For Phase 1 (low-volume) full re-fetch every poll is fine. For high-
    // volume Pages, a smarter scheme (recent-N refresh + paginate older)
    // can replace this in Phase 2.
    return url.toString();
  }

  private toFacebookComment(
    raw: FacebookCommentRaw,
    parentIdOverride: string | null,
  ): FacebookComment {
    return {
      id: raw.id,
      parentId: parentIdOverride ?? raw.parent?.id ?? null,
      message: raw.message ?? '',
      createdAt: new Date(raw.created_time),
      likeCount: raw.like_count ?? 0,
      author: {
        id: raw.from?.id ?? '',
        name: raw.from?.name ?? '',
        pictureUrl: raw.from?.picture?.data?.url,
      },
    };
  }

  /**
   * Activate webhook delivery for this Page.
   *
   * App-level webhook config in Meta Dashboard is NOT enough — each Page must
   * also POST to its `/subscribed_apps` to opt in. Without this call Meta
   * never delivers events for the Page even though the App has the field
   * subscription enabled in the dashboard.
   *
   * Idempotent — safe to call repeatedly.
   */
  async subscribePageToWebhooks(
    pageId: string,
    pageAccessToken: string,
    fields: string[] = ['feed'],
  ): Promise<{ success: boolean }> {
    const url = new URL(`${this.graphApiUrl}/${pageId}/subscribed_apps`);
    url.searchParams.set('access_token', pageAccessToken);
    url.searchParams.set('subscribed_fields', fields.join(','));

    const res = await fetch(url.toString(), { method: 'POST' });
    if (!res.ok) {
      const err = await res.text();
      this.logger.error(
        `FB subscribePageToWebhooks failed for ${pageId}: ${err}`,
      );
      throw new Error(`FB webhook subscription failed: ${res.status} ${err}`);
    }
    const data = (await res.json()) as { success?: boolean };
    this.logger.log(
      `FB Page ${pageId} subscribed to webhook fields [${fields.join(',')}]`,
    );
    return { success: data.success ?? true };
  }

  /**
   * Reply to an existing comment (nested under it).
   * Uses POST /{comment-id}/comments — same shape as top-level commenting,
   * but the target is a comment id, not a post id.
   */
  async replyToComment(
    pageAccessToken: string,
    parentCommentId: string,
    message: string,
  ): Promise<{ commentId: string }> {
    const url = new URL(`${this.graphApiUrl}/${parentCommentId}/comments`);
    url.searchParams.set('access_token', pageAccessToken);

    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });

    if (!res.ok) {
      const err = await res.text();
      this.logger.error(`Facebook replyToComment failed: ${err}`);
      throw new Error(`Facebook replyToComment failed: ${res.status} ${err}`);
    }

    const data = (await res.json()) as { id?: string };
    if (!data.id) throw new Error('Facebook returned no reply id');
    return { commentId: data.id };
  }

  // ==========================================================================
  // Messenger DM — Phase 2.1.fb-impl
  // ==========================================================================

  /**
   * Resolve a Messenger user (PSID) to their public profile. Used by the
   * webhook handler to enrich author info on inbound DMs (the webhook payload
   * only contains the PSID — name + picture have to be fetched separately).
   *
   * Endpoint: GET /<psid>?fields=name,first_name,last_name,profile_pic
   *   &access_token=<page-token>
   *
   * Page-scoped: the PSID is only readable by the page that received the DM.
   * Returns null on failure (e.g. user blocked, deleted, restricted) — caller
   * persists the row with handle/name=null and we'll surface "Unknown" in UI.
   */
  async getMessengerUserProfile(
    psid: string,
    pageAccessToken: string,
  ): Promise<{
    name: string | null;
    firstName: string | null;
    profilePictureUrl: string | null;
  } | null> {
    try {
      const url = new URL(`${this.graphApiUrl}/${psid}`);
      url.searchParams.set('fields', 'name,first_name,last_name,profile_pic');
      url.searchParams.set('access_token', pageAccessToken);

      const res = await fetch(url.toString());
      if (!res.ok) {
        const err = await res.text();
        this.logger.warn(
          `Messenger getUserProfile failed for psid=${psid}: ${res.status} ${err}`,
        );
        return null;
      }
      const data = (await res.json()) as {
        name?: string;
        first_name?: string;
        profile_pic?: string;
      };
      return {
        name: data.name ?? null,
        firstName: data.first_name ?? null,
        profilePictureUrl: data.profile_pic ?? null,
      };
    } catch (err) {
      this.logger.warn(
        `Messenger getUserProfile threw for psid=${psid}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * List Messenger conversations on this Page.
   *
   * Endpoint: GET /<page-id>/conversations
   *   ?platform=messenger
   *   &fields=participants,updated_time,unread_count,
   *           messages.limit(1){message,from,created_time,id}
   *
   * Returns one DmConversationSummary per thread. Our internal conversation_id
   * is derived from `<pageId>:<otherPartyPsid>` (the non-page participant).
   */
  async listMessengerConversations(
    pageId: string,
    pageAccessToken: string,
    _since?: Date,
  ): Promise<DmConversationSummary[]> {
    const url = new URL(`${this.graphApiUrl}/${pageId}/conversations`);
    url.searchParams.set('platform', 'messenger');
    url.searchParams.set(
      'fields',
      'participants,updated_time,unread_count,messages.limit(1){message,from,created_time,id}',
    );
    url.searchParams.set('limit', '50');
    url.searchParams.set('access_token', pageAccessToken);

    const res = await fetch(url.toString());
    if (!res.ok) {
      const err = await res.text();
      this.logger.error(
        `Messenger listConversations failed for page=${pageId}: ${err}`,
      );
      throw new Error(`Messenger listConversations failed: ${res.status}`);
    }

    const data = (await res.json()) as {
      data?: Array<{
        id: string;
        participants?: { data: { id: string; name?: string }[] };
        updated_time?: string;
        unread_count?: number;
        messages?: {
          data: Array<{
            id: string;
            message?: string;
            created_time?: string;
            from?: { id: string; name?: string };
          }>;
        };
      }>;
    };

    const summaries: DmConversationSummary[] = [];
    for (const thread of data.data ?? []) {
      const participants = thread.participants?.data ?? [];
      const otherParty = participants.find((p) => p.id !== pageId);
      if (!otherParty) continue;

      const conversationId = `${pageId}:${otherParty.id}`;
      const lastMessageEntry = thread.messages?.data?.[0];

      summaries.push({
        conversationId,
        participant: {
          platformId: otherParty.id,
          handle: otherParty.name ?? undefined,
          displayName: otherParty.name ?? undefined,
        },
        lastMessageText: lastMessageEntry?.message ?? '',
        lastMessageAt: lastMessageEntry?.created_time
          ? new Date(lastMessageEntry.created_time)
          : thread.updated_time
            ? new Date(thread.updated_time)
            : new Date(),
        lastMessageFromMe: lastMessageEntry?.from?.id === pageId,
        unreadCount: thread.unread_count ?? 0,
        metadata: { thread_id: thread.id },
      });
    }
    return summaries;
  }

  /**
   * Fetch messages in a Messenger conversation (for backfill / initial sync).
   * The conversation_id is `<pageId>:<otherPartyPsid>` — we first resolve the
   * thread_id via `/<page>/conversations?user_id=<psid>`, then list messages.
   */
  async fetchMessengerThread(
    pageId: string,
    pageAccessToken: string,
    conversationId: string,
    _since?: Date,
  ): Promise<FetchedDm[]> {
    const [, otherPartyId] = conversationId.split(':');
    if (!otherPartyId) {
      throw new Error(`Invalid Messenger conversation id: ${conversationId}`);
    }

    // 1) Resolve thread_id from the other party's PSID.
    const lookupUrl = new URL(`${this.graphApiUrl}/${pageId}/conversations`);
    lookupUrl.searchParams.set('platform', 'messenger');
    lookupUrl.searchParams.set('user_id', otherPartyId);
    lookupUrl.searchParams.set('fields', 'id');
    lookupUrl.searchParams.set('access_token', pageAccessToken);

    const lookupRes = await fetch(lookupUrl.toString());
    if (!lookupRes.ok) {
      throw new Error(
        `Messenger thread lookup failed: ${lookupRes.status} ${await lookupRes.text()}`,
      );
    }
    const lookupData = (await lookupRes.json()) as {
      data?: { id: string }[];
    };
    const threadId = lookupData.data?.[0]?.id;
    if (!threadId) return [];

    // 2) Fetch messages in that thread.
    // `attachments` field surfaces image/video/audio attached to a message —
    // each entry has mime_type + image_data.url (for images) or file_url.
    const msgUrl = new URL(`${this.graphApiUrl}/${threadId}/messages`);
    msgUrl.searchParams.set(
      'fields',
      'id,message,from,to,created_time,attachments{id,mime_type,name,image_data,video_data,file_url}',
    );
    msgUrl.searchParams.set('limit', '100');
    msgUrl.searchParams.set('access_token', pageAccessToken);

    const msgRes = await fetch(msgUrl.toString());
    if (!msgRes.ok) {
      throw new Error(
        `Messenger thread fetch failed: ${msgRes.status} ${await msgRes.text()}`,
      );
    }
    const msgData = (await msgRes.json()) as {
      data?: Array<{
        id: string;
        message?: string;
        created_time?: string;
        from?: { id: string; name?: string };
        attachments?: {
          data?: Array<{
            id?: string;
            mime_type?: string;
            name?: string;
            image_data?: { url?: string; preview_url?: string };
            video_data?: { url?: string; preview_url?: string };
            file_url?: string;
          }>;
        };
      }>;
    };

    const messages: FetchedDm[] = [];
    for (const m of msgData.data ?? []) {
      const fromMe = m.from?.id === pageId;

      // Phase 2.3 — map FB attachment shapes to our DmAttachment normalized form.
      const attachments = (m.attachments?.data ?? [])
        .map((a) => {
          const mime = a.mime_type ?? '';
          const url =
            a.image_data?.url ?? a.video_data?.url ?? a.file_url ?? '';
          if (!url) return null;
          const kind: 'image' | 'video' | 'audio' | 'file' = mime.startsWith(
            'image/',
          )
            ? 'image'
            : mime.startsWith('video/')
              ? 'video'
              : mime.startsWith('audio/')
                ? 'audio'
                : 'file';
          return {
            kind,
            url,
            contentType: mime || undefined,
            thumbnailUrl:
              a.image_data?.preview_url ?? a.video_data?.preview_url,
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);

      messages.push({
        conversationId,
        platformItemId: m.id,
        author: fromMe
          ? null
          : {
              platformId: m.from?.id ?? otherPartyId,
              handle: m.from?.name ?? undefined,
              displayName: m.from?.name ?? undefined,
            },
        text: m.message ?? '',
        platformCreatedAt: m.created_time
          ? new Date(m.created_time)
          : new Date(),
        fromMe,
        attachments: attachments.length > 0 ? attachments : undefined,
      });
    }
    return messages;
  }

  /**
   * Send a Messenger DM. Standard messaging mode — only valid inside the
   * 24h window since the user's last message. Outside that window FB returns
   * error code 10 / subcode 2018278; the InboxService's window check should
   * prevent reaching this method, but we still surface FB's error verbatim.
   *
   * Endpoint: POST /me/messages?access_token=<page-token>
   *   body: { recipient: { id: psid }, message: { text },
   *           messaging_type: 'RESPONSE' }
   */
  /**
   * Delete a Facebook comment. Requires the comment to have been authored by
   * the page (i.e. `from.id === pageId`) — Graph API rejects otherwise with
   * "(#200) Comments cannot be removed by this user". Phase 2.3.
   *
   * Endpoint: DELETE /{comment-id}?access_token=PAGE_TOKEN
   */
  async deleteComment(
    pageAccessToken: string,
    commentId: string,
  ): Promise<boolean> {
    const url = new URL(`${this.graphApiUrl}/${commentId}`);
    url.searchParams.set('access_token', pageAccessToken);
    const res = await fetch(url.toString(), { method: 'DELETE' });
    if (!res.ok) {
      const err = await res.text();
      this.logger.error(`FB deleteComment failed: ${err}`);
      throw new Error(`Facebook delete failed: ${res.status} ${err}`);
    }
    return true;
  }

  /**
   * Unsend a Facebook Messenger message. Meta's Send API supports unsending
   * via `/me/messages` with `message: { unsend: { mid } }`. The window is
   * platform-enforced (~24h for some accounts, less for others). Phase 2.3.
   */
  async unsendMessengerMessage(
    pageAccessToken: string,
    recipientPsid: string,
    messageId: string,
  ): Promise<boolean> {
    const url = new URL(`${this.graphApiUrl}/me/messages`);
    url.searchParams.set('access_token', pageAccessToken);
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: recipientPsid },
        message: { unsend: { mid: messageId } },
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      this.logger.error(`FB unsendMessage failed: ${err}`);
      throw new Error(
        `Failed to unsend Messenger message: ${res.status} ${err}`,
      );
    }
    return true;
  }

  async sendMessengerMessage(
    pageId: string,
    pageAccessToken: string,
    recipientPsid: string,
    text: string,
  ): Promise<CreatedDm> {
    const url = new URL(`${this.graphApiUrl}/me/messages`);
    url.searchParams.set('access_token', pageAccessToken);

    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: recipientPsid },
        message: { text },
        messaging_type: 'RESPONSE',
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      this.logger.error(`Messenger send failed: ${err}`);
      throw new Error(`Messenger send failed: ${res.status} ${err}`);
    }

    const data = (await res.json()) as {
      message_id?: string;
      recipient_id?: string;
    };
    if (!data.message_id) {
      throw new Error('Messenger send: no message_id returned');
    }

    // FB's send response doesn't include a timestamp; use server now. The
    // echo webhook will follow shortly with the canonical timestamp and our
    // upsert merges them via the unique (channel, platform_item_id) constraint.
    return {
      conversationId: `${pageId}:${recipientPsid}`,
      platformItemId: data.message_id,
      text,
      platformCreatedAt: new Date(),
    };
  }

  /**
   * Send a Messenger message with a media attachment (image / video / audio /
   * file). Meta supports passing a public URL via attachment.payload.url so
   * we don't have to upload bytes — R2's public URL is sufficient.
   *
   * One attachment per message (Meta's API constraint); for multiple, the
   * caller sends multiple Messenger messages.
   *
   * Phase 2.3.
   */
  // ==========================================================================
  // Ads — page posts for boost picker
  // ==========================================================================

  /**
   * List recent FB Page posts suitable for boosting.
   * Returns the last `limit` posts with enough preview data for the
   * boost-wizard picker UI.
   *
   * Graph v21.0: GET /{pageId}/posts
   *   fields=id,message,created_time,full_picture,permalink_url,attachments{type}
   */
  async listPagePostsForBoost(
    pageId: string,
    pageAccessToken: string,
    limit = 25,
  ): Promise<
    {
      id: string;
      message?: string;
      createdTime: string;
      fullPicture?: string;
      permalinkUrl?: string;
      attachmentsType?: string;
    }[]
  > {
    const url = new URL(
      'https://graph.facebook.com/v21.0/' + pageId + '/posts',
    );
    url.searchParams.set('access_token', pageAccessToken);
    url.searchParams.set(
      'fields',
      'id,message,created_time,full_picture,permalink_url,attachments{type}',
    );
    url.searchParams.set('limit', String(limit));

    const res = await fetch(url.toString());
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as {
        error?: { message?: string };
      };
      const reason = err?.error?.message ?? `HTTP ${res.status}`;
      this.logger.error(
        `listPagePostsForBoost failed for page ${pageId}: ${reason}`,
      );
      throw new BadRequestException(`Failed to fetch page posts: ${reason}`);
    }

    const data = (await res.json()) as {
      data?: Array<{
        id: string;
        message?: string;
        created_time?: string;
        full_picture?: string;
        permalink_url?: string;
        attachments?: { data?: Array<{ type?: string }> };
      }>;
    };

    return (data.data ?? []).map((post) => ({
      id: post.id,
      message: post.message,
      createdTime: post.created_time ?? '',
      fullPicture: post.full_picture,
      permalinkUrl: post.permalink_url,
      attachmentsType: post.attachments?.data?.[0]?.type,
    }));
  }

  async sendMessengerAttachmentMessage(
    pageId: string,
    pageAccessToken: string,
    recipientPsid: string,
    attachment: {
      kind: 'image' | 'video' | 'audio' | 'file';
      url: string;
    },
    text?: string,
  ): Promise<CreatedDm> {
    const url = new URL(`${this.graphApiUrl}/me/messages`);
    url.searchParams.set('access_token', pageAccessToken);

    // FB's attachment.type taxonomy is: image | video | audio | file
    const fbType = attachment.kind;

    // If text is provided, FB requires it as a separate message. Send the
    // attachment first; the text-only message can follow via the caller.
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: recipientPsid },
        message: {
          attachment: {
            type: fbType,
            payload: { url: attachment.url, is_reusable: false },
          },
        },
        messaging_type: 'RESPONSE',
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      this.logger.error(`Messenger attachment send failed: ${err}`);
      throw new Error(`Messenger attachment send failed: ${res.status} ${err}`);
    }

    const data = (await res.json()) as { message_id?: string };
    if (!data.message_id) {
      throw new Error('Messenger attachment send: no message_id returned');
    }

    // Optional accompanying text — send as a second message right away.
    if (text && text.trim()) {
      await this.sendMessengerMessage(
        pageId,
        pageAccessToken,
        recipientPsid,
        text.trim(),
      );
    }

    return {
      conversationId: `${pageId}:${recipientPsid}`,
      platformItemId: data.message_id,
      text: text ?? '',
      platformCreatedAt: new Date(),
    };
  }
}

// ---------------------------------------------------------------------------
// Facebook comment shapes
// ---------------------------------------------------------------------------

export interface FacebookCommentRaw {
  id: string;
  message?: string;
  created_time: string;
  like_count?: number;
  /** Number of nested replies under this comment — used by the poller to
   *  decide whether to make a follow-up /{comment-id}/comments call. */
  comment_count?: number;
  from?: { id?: string; name?: string; picture?: { data?: { url?: string } } };
  parent?: { id: string };
  comments?: { data: FacebookCommentRaw[] };
}

export interface FacebookComment {
  id: string;
  parentId: string | null;
  message: string;
  createdAt: Date;
  likeCount: number;
  author: {
    id: string;
    name: string;
    pictureUrl?: string;
  };
}
