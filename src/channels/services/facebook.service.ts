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
      pages.push(this.mapPage(page));
    }

    // FLB fallback — `/me/accounts` came back empty but the user may have
    // granted access to specific Pages via the new granular permissions
    // flow. The page IDs live inside the token's `granular_scopes`.
    if (pages.length === 0) {
      this.logger.log(
        'me/accounts returned empty — trying granular_scopes fallback (FLB)',
      );
      const grantedPageIds = await this.getGrantedPageIdsFromToken(
        userAccessToken,
      );
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
        this.logger.error(
          'debug_token call failed:',
          JSON.stringify(data),
        );
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
      const err = (await startRes.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new BadRequestException(
        `Facebook Reel init failed: ${err?.error?.message ?? `HTTP ${startRes.status}`}`,
      );
    }
    const startData = (await startRes.json()) as { video_id?: string; upload_url?: string };
    if (!startData.video_id || !startData.upload_url) {
      throw new BadRequestException('Facebook Reel start phase returned no video_id/upload_url');
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
      throw new BadRequestException(`Facebook Reel transfer failed: HTTP ${uploadRes.status}`);
    }
    const uploadData = (await uploadRes.json().catch(() => ({}))) as { success?: boolean };
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
      const err = (await finishRes.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new BadRequestException(
        `Facebook Reel finish failed: ${err?.error?.message ?? `HTTP ${finishRes.status}`}`,
      );
    }
    const finishData = (await finishRes.json().catch(() => ({}))) as { success?: boolean };
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
        const grantedScopes = await this.debugTokenScopes(pageAccessToken).catch(
          () => null,
        );
        this.logger.error(
          `Facebook comment permission denied. Token scopes from /debug_token: ${
            grantedScopes ? JSON.stringify(grantedScopes) : '<debug_token call failed>'
          }`,
        );
        const hasEngagement = grantedScopes?.includes('pages_manage_engagement');
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
    let nextUrl: string | null = this.buildCommentsUrl(postId, pageAccessToken, since);

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
          const replies = await this.fetchCommentReplies(
            pageAccessToken,
            id,
          );
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
      ['id', 'message', 'created_time', 'like_count', 'from{id,name,picture}', 'parent{id}'].join(','),
    );
    url.searchParams.set('limit', '100');

    let nextUrl: string | null = url.toString();
    for (let i = 0; i < 3 && nextUrl; i++) {
      const res = await fetch(nextUrl);
      if (!res.ok) {
        const errText = await res.text();
        if (
          res.status === 400 &&
          (/code"\s*:\s*100/.test(errText) || /nonexisting field/i.test(errText))
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
      this.logger.error(`FB subscribePageToWebhooks failed for ${pageId}: ${err}`);
      throw new Error(`FB webhook subscription failed: ${res.status} ${err}`);
    }
    const data = (await res.json()) as { success?: boolean };
    this.logger.log(`FB Page ${pageId} subscribed to webhook fields [${fields.join(',')}]`);
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
