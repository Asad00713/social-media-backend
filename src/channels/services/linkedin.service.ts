import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import {
  MAX_IMAGE_BYTES,
  fetchPublicMedia,
} from '../../common/net/public-fetch';
import { type VideoThumbnail, downloadVideoThumbnail } from './video-thumbnail';
import { toLittleText } from './linkedin-little-text';

/**
 * A post's audience - the Post schema's `MemberNetworkVisibility`:
 * "CONNECTIONS - Represents 1st degree network of owner. PUBLIC - Anyone can
 * view this. LOGGED_IN - Viewable by logged in members only." (`CONTAINER`
 * is for group posts, which we never make.)
 */
export type LinkedInVisibility = 'PUBLIC' | 'CONNECTIONS' | 'LOGGED_IN';

/**
 * MultiImage: "minimum of 2 images and maximum of 20 images" (stated).
 * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/multiimage-post-api
 */
export const LINKEDIN_MULTI_IMAGE_MIN = 2;
export const LINKEDIN_MULTI_IMAGE_MAX = 20;

/**
 * `altText` - "Maximum length is 4,086 characters" (stated for MultiImage;
 * the single-media `altText` states no limit, so the same cap is used).
 */
const MAX_ALT_TEXT_CHARS = 4086;

/** An alt text worth sending: trimmed, capped, absent when blank. */
function altTextOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text ? text.slice(0, MAX_ALT_TEXT_CHARS) : undefined;
}

/**
 * The versioned ("rest") base path — Posts, Images and Documents APIs.
 *
 * Everything else in this service still talks to the unversioned `/v2`
 * paths (`apiBaseUrl`). LinkedIn states that the Posts API replaces
 * `ugcPosts`, and that the versioned APIs live under `/rest`.
 */
const LINKEDIN_REST_URL = 'https://api.linkedin.com/rest';

/**
 * `Linkedin-Version` (YYYYMM) sent on every versioned call.
 *
 * Stated by LinkedIn: the header is mandatory (the latest version is NOT
 * applied by default) and a version is supported for at least a year before
 * it is sunset. 202610 was the latest when this was written; bump it before
 * it is sunset, after reading the changelog for the Posts, Images and
 * Documents APIs.
 */
const LINKEDIN_REST_VERSION = '202610';

/** Documents API: "The file size can't exceed 100MB and 300 pages." */
const MAX_DOCUMENT_BYTES = 100 * 1024 * 1024;

/** Videos API: "File size: Between 75kb and 500MB." */
const MAX_VIDEO_BYTES = 500 * 1024 * 1024;

export interface LinkedInProfile {
  id: string;
  firstName: string;
  lastName: string;
  fullName: string;
  profilePictureUrl: string | null;
  email: string | null;
  vanityName: string | null;
}

export interface LinkedInOrganization {
  id: string;
  name: string;
  vanityName: string | null;
  logoUrl: string | null;
  followerCount: number;
}

@Injectable()
export class LinkedInService {
  private readonly logger = new Logger(LinkedInService.name);
  private readonly apiBaseUrl = 'https://api.linkedin.com/v2';

  /**
   * Get the authenticated user's LinkedIn profile
   */
  async getCurrentUser(accessToken: string): Promise<LinkedInProfile> {
    // Get basic profile info using OpenID userinfo endpoint
    const userInfoResponse = await fetch(
      'https://api.linkedin.com/v2/userinfo',
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );

    if (!userInfoResponse.ok) {
      const errorData = await userInfoResponse.text();
      this.logger.error(`Failed to get LinkedIn user info: ${errorData}`);
      throw new BadRequestException('Failed to fetch LinkedIn profile');
    }

    const userInfo = await userInfoResponse.json();

    return {
      id: userInfo.sub,
      firstName: userInfo.given_name || '',
      lastName: userInfo.family_name || '',
      fullName:
        userInfo.name || `${userInfo.given_name} ${userInfo.family_name}`,
      profilePictureUrl: userInfo.picture || null,
      email: userInfo.email || null,
      vanityName: null, // Not available in userinfo endpoint
    };
  }

  /**
   * Get organizations (company pages) the user can post on behalf of
   */
  async getUserOrganizations(
    accessToken: string,
  ): Promise<LinkedInOrganization[]> {
    // First get the organization access control
    const response = await fetch(
      `${this.apiBaseUrl}/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&projection=(elements*(organization~(id,localizedName,vanityName,logoV2(original~:playableStreams))))`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'X-Restli-Protocol-Version': '2.0.0',
        },
      },
    );

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(`Failed to get LinkedIn organizations: ${errorData}`);
      // Return empty array if user doesn't have organization access
      return [];
    }

    const data = await response.json();
    const organizations: LinkedInOrganization[] = [];

    for (const element of data.elements || []) {
      const org = element['organization~'];
      if (org) {
        organizations.push({
          id: org.id.toString(),
          name: org.localizedName,
          vanityName: org.vanityName || null,
          logoUrl:
            org.logoV2?.['original~']?.elements?.[0]?.identifiers?.[0]
              ?.identifier || null,
          followerCount: 0, // Would need separate API call
        });
      }
    }

    return organizations;
  }

  /**
   * Create a text post on LinkedIn (personal profile)
   */
  async createPost(
    accessToken: string,
    authorId: string,
    text: string,
    visibility: LinkedInVisibility = 'PUBLIC',
  ): Promise<{ postId: string }> {
    const postData = {
      author: `urn:li:person:${authorId}`,
      lifecycleState: 'PUBLISHED',
      specificContent: {
        'com.linkedin.ugc.ShareContent': {
          shareCommentary: {
            text,
          },
          shareMediaCategory: 'NONE',
        },
      },
      visibility: {
        'com.linkedin.ugc.MemberNetworkVisibility': visibility,
      },
    };

    const response = await fetch(`${this.apiBaseUrl}/ugcPosts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Restli-Protocol-Version': '2.0.0',
      },
      body: JSON.stringify(postData),
    });

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(`Failed to create LinkedIn post: ${errorData}`);
      throw new BadRequestException('Failed to create LinkedIn post');
    }

    const result = await response.json();
    return {
      postId: result.id,
    };
  }

  /**
   * Create a post with an image on LinkedIn
   * LinkedIn requires uploading images to their servers first
   */
  async createPostWithImage(
    accessToken: string,
    authorId: string,
    text: string,
    imageUrl: string,
    imageTitle?: string,
    visibility: LinkedInVisibility = 'PUBLIC',
  ): Promise<{ postId: string }> {
    // Step 1: Register the image upload
    const registerResponse = await this.registerImageUpload(
      accessToken,
      `urn:li:person:${authorId}`,
    );

    // Step 2: Upload the image
    await this.uploadImageToLinkedIn(imageUrl, registerResponse.uploadUrl);

    // Step 3: Create the post with the uploaded image
    const postData = {
      author: `urn:li:person:${authorId}`,
      lifecycleState: 'PUBLISHED',
      specificContent: {
        'com.linkedin.ugc.ShareContent': {
          shareCommentary: {
            text,
          },
          shareMediaCategory: 'IMAGE',
          media: [
            {
              status: 'READY',
              description: {
                text: imageTitle || 'Image',
              },
              media: registerResponse.imageUrn,
              title: {
                text: imageTitle || 'Image',
              },
            },
          ],
        },
      },
      visibility: {
        'com.linkedin.ugc.MemberNetworkVisibility': visibility,
      },
    };

    const response = await fetch(`${this.apiBaseUrl}/ugcPosts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Restli-Protocol-Version': '2.0.0',
      },
      body: JSON.stringify(postData),
    });

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(`Failed to create LinkedIn image post: ${errorData}`);
      throw new BadRequestException(
        'Failed to create LinkedIn post with image',
      );
    }

    const result = await response.json();
    return {
      postId: result.id,
    };
  }

  /**
   * Create a post with a link/article on LinkedIn
   */
  async createPostWithLink(
    accessToken: string,
    authorId: string,
    text: string,
    linkUrl: string,
    linkTitle?: string,
    linkDescription?: string,
    visibility: LinkedInVisibility = 'PUBLIC',
  ): Promise<{ postId: string }> {
    const postData = {
      author: `urn:li:person:${authorId}`,
      lifecycleState: 'PUBLISHED',
      specificContent: {
        'com.linkedin.ugc.ShareContent': {
          shareCommentary: {
            text,
          },
          shareMediaCategory: 'ARTICLE',
          media: [
            {
              status: 'READY',
              originalUrl: linkUrl,
              title: {
                text: linkTitle || linkUrl,
              },
              description: {
                text: linkDescription || '',
              },
            },
          ],
        },
      },
      visibility: {
        'com.linkedin.ugc.MemberNetworkVisibility': visibility,
      },
    };

    const response = await fetch(`${this.apiBaseUrl}/ugcPosts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Restli-Protocol-Version': '2.0.0',
      },
      body: JSON.stringify(postData),
    });

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(`Failed to create LinkedIn link post: ${errorData}`);
      throw new BadRequestException('Failed to create LinkedIn post with link');
    }

    const result = await response.json();
    return {
      postId: result.id,
    };
  }

  /**
   * Create a post on a company/organization page
   */
  async createOrganizationPost(
    accessToken: string,
    organizationId: string,
    text: string,
    visibility: 'PUBLIC' = 'PUBLIC',
  ): Promise<{ postId: string }> {
    const postData = {
      author: `urn:li:organization:${organizationId}`,
      lifecycleState: 'PUBLISHED',
      specificContent: {
        'com.linkedin.ugc.ShareContent': {
          shareCommentary: {
            text,
          },
          shareMediaCategory: 'NONE',
        },
      },
      visibility: {
        'com.linkedin.ugc.MemberNetworkVisibility': visibility,
      },
    };

    const response = await fetch(`${this.apiBaseUrl}/ugcPosts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Restli-Protocol-Version': '2.0.0',
      },
      body: JSON.stringify(postData),
    });

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(`Failed to create LinkedIn org post: ${errorData}`);
      throw new BadRequestException('Failed to create organization post');
    }

    const result = await response.json();
    return {
      postId: result.id,
    };
  }

  /**
   * Create a post with video on LinkedIn (personal profile)
   * LinkedIn requires uploading video to their servers first
   */
  async createPostWithVideo(
    accessToken: string,
    authorId: string,
    text: string,
    videoUrl: string,
    videoTitle?: string,
    visibility: LinkedInVisibility = 'PUBLIC',
  ): Promise<{ postId: string }> {
    // Step 1: Register the video upload
    const registerResponse = await this.registerVideoUpload(
      accessToken,
      `urn:li:person:${authorId}`,
    );

    // Step 2: Upload the video
    await this.uploadVideoToLinkedIn(videoUrl, registerResponse.uploadUrl);

    // Step 3: Create the post with the uploaded video
    const postData = {
      author: `urn:li:person:${authorId}`,
      lifecycleState: 'PUBLISHED',
      specificContent: {
        'com.linkedin.ugc.ShareContent': {
          shareCommentary: {
            text,
          },
          shareMediaCategory: 'VIDEO',
          media: [
            {
              status: 'READY',
              media: registerResponse.videoUrn,
              title: {
                text: videoTitle || 'Video',
              },
            },
          ],
        },
      },
      visibility: {
        'com.linkedin.ugc.MemberNetworkVisibility': visibility,
      },
    };

    const response = await fetch(`${this.apiBaseUrl}/ugcPosts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Restli-Protocol-Version': '2.0.0',
      },
      body: JSON.stringify(postData),
    });

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(`Failed to create LinkedIn video post: ${errorData}`);
      throw new BadRequestException(
        'Failed to create LinkedIn post with video',
      );
    }

    const result = await response.json();
    return {
      postId: result.id,
    };
  }

  /**
   * Register a video upload with LinkedIn
   */
  private async registerVideoUpload(
    accessToken: string,
    ownerUrn: string,
  ): Promise<{ uploadUrl: string; videoUrn: string }> {
    const registerData = {
      registerUploadRequest: {
        recipes: ['urn:li:digitalmediaRecipe:feedshare-video'],
        owner: ownerUrn,
        serviceRelationships: [
          {
            relationshipType: 'OWNER',
            identifier: 'urn:li:userGeneratedContent',
          },
        ],
      },
    };

    const response = await fetch(
      `${this.apiBaseUrl}/assets?action=registerUpload`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'X-Restli-Protocol-Version': '2.0.0',
        },
        body: JSON.stringify(registerData),
      },
    );

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(
        `Failed to register LinkedIn video upload: ${errorData}`,
      );
      throw new BadRequestException('Failed to register video upload');
    }

    const data = await response.json();
    const uploadMechanism =
      data.value.uploadMechanism[
        'com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest'
      ];

    return {
      uploadUrl: uploadMechanism.uploadUrl,
      videoUrn: data.value.asset,
    };
  }

  /**
   * Upload video data to LinkedIn's upload URL
   */
  private async uploadVideoToLinkedIn(
    videoUrl: string,
    uploadUrl: string,
  ): Promise<void> {
    // Download the video
    this.logger.log(`Downloading video from: ${videoUrl}`);
    let videoResponse: Response;
    try {
      videoResponse = await fetchPublicMedia(videoUrl);
    } catch (error) {
      this.logger.error(`Network error downloading video: ${error}`);
      throw new BadRequestException(
        `Failed to download video from ${videoUrl}: Network error`,
      );
    }

    if (!videoResponse.ok) {
      const errorText = await videoResponse.text().catch(() => 'No error body');
      this.logger.error(
        `Failed to download video. Status: ${videoResponse.status}, Body: ${errorText}`,
      );
      throw new BadRequestException(
        `Failed to download video from ${videoUrl}`,
      );
    }

    const videoBuffer = await videoResponse.arrayBuffer();
    this.logger.log(`Video downloaded: ${videoBuffer.byteLength} bytes`);

    // Upload to LinkedIn
    const uploadResponse = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
      },
      body: videoBuffer,
    });

    if (!uploadResponse.ok) {
      const errorData = await uploadResponse.text();
      this.logger.error(`Failed to upload video to LinkedIn: ${errorData}`);
      throw new BadRequestException('Failed to upload video to LinkedIn');
    }

    this.logger.log('Video uploaded to LinkedIn successfully');
  }

  /**
   * Register an image upload with LinkedIn
   */
  private async registerImageUpload(
    accessToken: string,
    ownerUrn: string,
  ): Promise<{ uploadUrl: string; imageUrn: string }> {
    const registerData = {
      registerUploadRequest: {
        recipes: ['urn:li:digitalmediaRecipe:feedshare-image'],
        owner: ownerUrn,
        serviceRelationships: [
          {
            relationshipType: 'OWNER',
            identifier: 'urn:li:userGeneratedContent',
          },
        ],
      },
    };

    const response = await fetch(
      `${this.apiBaseUrl}/assets?action=registerUpload`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'X-Restli-Protocol-Version': '2.0.0',
        },
        body: JSON.stringify(registerData),
      },
    );

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(
        `Failed to register LinkedIn image upload: ${errorData}`,
      );
      throw new BadRequestException('Failed to register image upload');
    }

    const data = await response.json();
    const uploadMechanism =
      data.value.uploadMechanism[
        'com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest'
      ];

    return {
      uploadUrl: uploadMechanism.uploadUrl,
      imageUrn: data.value.asset,
    };
  }

  /**
   * Upload image data to LinkedIn's upload URL
   */
  private async uploadImageToLinkedIn(
    imageUrl: string,
    uploadUrl: string,
  ): Promise<void> {
    // Download the image
    this.logger.log(`Downloading image from: ${imageUrl}`);
    let imageResponse: Response;
    try {
      imageResponse = await fetchPublicMedia(imageUrl, {
        maxBytes: MAX_IMAGE_BYTES,
      });
    } catch (error) {
      this.logger.error(`Network error downloading image: ${error}`);
      throw new BadRequestException(
        `Failed to download image from ${imageUrl}: Network error`,
      );
    }

    if (!imageResponse.ok) {
      const errorText = await imageResponse.text().catch(() => 'No error body');
      this.logger.error(
        `Failed to download image. Status: ${imageResponse.status}, Body: ${errorText}`,
      );
      throw new BadRequestException(
        `Failed to download image from ${imageUrl}`,
      );
    }

    const imageBuffer = await imageResponse.arrayBuffer();
    this.logger.log(`Image downloaded: ${imageBuffer.byteLength} bytes`);

    // Upload to LinkedIn
    const uploadResponse = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
      },
      body: imageBuffer,
    });

    if (!uploadResponse.ok) {
      const errorData = await uploadResponse.text();
      this.logger.error(`Failed to upload image to LinkedIn: ${errorData}`);
      throw new BadRequestException('Failed to upload image to LinkedIn');
    }

    this.logger.log('Image uploaded to LinkedIn successfully');
  }

  /**
   * Create organization post with image
   */
  async createOrganizationPostWithImage(
    accessToken: string,
    organizationId: string,
    text: string,
    imageUrl: string,
    imageTitle?: string,
    visibility: 'PUBLIC' = 'PUBLIC',
  ): Promise<{ postId: string }> {
    // Step 1: Register the image upload
    const registerResponse = await this.registerImageUpload(
      accessToken,
      `urn:li:organization:${organizationId}`,
    );

    // Step 2: Upload the image
    await this.uploadImageToLinkedIn(imageUrl, registerResponse.uploadUrl);

    // Step 3: Create the post with the uploaded image
    const postData = {
      author: `urn:li:organization:${organizationId}`,
      lifecycleState: 'PUBLISHED',
      specificContent: {
        'com.linkedin.ugc.ShareContent': {
          shareCommentary: {
            text,
          },
          shareMediaCategory: 'IMAGE',
          media: [
            {
              status: 'READY',
              description: {
                text: imageTitle || 'Image',
              },
              media: registerResponse.imageUrn,
              title: {
                text: imageTitle || 'Image',
              },
            },
          ],
        },
      },
      visibility: {
        'com.linkedin.ugc.MemberNetworkVisibility': visibility,
      },
    };

    const response = await fetch(`${this.apiBaseUrl}/ugcPosts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Restli-Protocol-Version': '2.0.0',
      },
      body: JSON.stringify(postData),
    });

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(
        `Failed to create LinkedIn org image post: ${errorData}`,
      );
      throw new BadRequestException(
        'Failed to create organization post with image',
      );
    }

    const result = await response.json();
    return {
      postId: result.id,
    };
  }

  /**
   * Create organization post with video
   */
  async createOrganizationPostWithVideo(
    accessToken: string,
    organizationId: string,
    text: string,
    videoUrl: string,
    videoTitle?: string,
    visibility: 'PUBLIC' = 'PUBLIC',
  ): Promise<{ postId: string }> {
    // Step 1: Register the video upload
    const registerResponse = await this.registerVideoUpload(
      accessToken,
      `urn:li:organization:${organizationId}`,
    );

    // Step 2: Upload the video
    await this.uploadVideoToLinkedIn(videoUrl, registerResponse.uploadUrl);

    // Step 3: Create the post with the uploaded video
    const postData = {
      author: `urn:li:organization:${organizationId}`,
      lifecycleState: 'PUBLISHED',
      specificContent: {
        'com.linkedin.ugc.ShareContent': {
          shareCommentary: {
            text,
          },
          shareMediaCategory: 'VIDEO',
          media: [
            {
              status: 'READY',
              media: registerResponse.videoUrn,
              title: {
                text: videoTitle || 'Video',
              },
            },
          ],
        },
      },
      visibility: {
        'com.linkedin.ugc.MemberNetworkVisibility': visibility,
      },
    };

    const response = await fetch(`${this.apiBaseUrl}/ugcPosts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Restli-Protocol-Version': '2.0.0',
      },
      body: JSON.stringify(postData),
    });

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(
        `Failed to create LinkedIn org video post: ${errorData}`,
      );
      throw new BadRequestException(
        'Failed to create organization post with video',
      );
    }

    const result = await response.json();
    return {
      postId: result.id,
    };
  }

  /**
   * Create organization post with link
   */
  async createOrganizationPostWithLink(
    accessToken: string,
    organizationId: string,
    text: string,
    linkUrl: string,
    linkTitle?: string,
    linkDescription?: string,
    visibility: 'PUBLIC' = 'PUBLIC',
  ): Promise<{ postId: string }> {
    const postData = {
      author: `urn:li:organization:${organizationId}`,
      lifecycleState: 'PUBLISHED',
      specificContent: {
        'com.linkedin.ugc.ShareContent': {
          shareCommentary: {
            text,
          },
          shareMediaCategory: 'ARTICLE',
          media: [
            {
              status: 'READY',
              originalUrl: linkUrl,
              title: {
                text: linkTitle || linkUrl,
              },
              description: {
                text: linkDescription || '',
              },
            },
          ],
        },
      },
      visibility: {
        'com.linkedin.ugc.MemberNetworkVisibility': visibility,
      },
    };

    const response = await fetch(`${this.apiBaseUrl}/ugcPosts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Restli-Protocol-Version': '2.0.0',
      },
      body: JSON.stringify(postData),
    });

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(
        `Failed to create LinkedIn org link post: ${errorData}`,
      );
      throw new BadRequestException(
        'Failed to create organization post with link',
      );
    }

    const result = await response.json();
    return {
      postId: result.id,
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

  /**
   * Posts a comment on a published LinkedIn share/UGC post.
   * Uses the Social Actions API: POST /v2/socialActions/{post-urn}/comments
   *
   * @param accessToken — Member access token (same token used for the post)
   * @param actorUrn — The author's URN (e.g., "urn:li:person:{id}" or "urn:li:organization:{id}")
   * @param postUrn — The published post's URN
   * @returns the new comment's URN
   */
  async postComment(
    accessToken: string,
    actorUrn: string,
    postUrn: string,
    message: string,
  ): Promise<{ commentUrn: string }> {
    if (!message || !message.trim()) {
      throw new Error('Comment message is required');
    }

    // Social Actions API expects the URN AS-IS. LinkedIn post creation returns
    // the URN in different shapes depending on the endpoint:
    //   • /v2/ugcPosts → urn:li:share:{id}  (most common, our default)
    //   • /v2/posts    → urn:li:share:{id} (header) or urn:li:ugcPost:{id}
    //
    // An earlier version of this code converted everything to urn:li:activity:{id}
    // assuming share/ugcPost/activity share the same numeric ID. That's NOT true
    // in all cases — activity URNs are derived asynchronously by LinkedIn and the
    // ID does not always match the share's ID. The comment endpoint accepts the
    // original share/ugcPost URN directly, so use it raw.
    const tryComment = async (entityUrn: string) => {
      const url = `${this.apiBaseUrl}/socialActions/${encodeURIComponent(entityUrn)}/comments`;
      return fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'X-Restli-Protocol-Version': '2.0.0',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          actor: actorUrn,
          object: entityUrn,
          message: { text: message },
        }),
      });
    };

    let response = await tryComment(postUrn);

    // LinkedIn has eventual consistency on freshly-created posts. If the first
    // attempt 404s, wait briefly and retry once — this fixes the common "post
    // created but social-actions index not yet populated" race.
    if (response.status === 404) {
      this.logger.warn(
        `LinkedIn social-actions returned 404 for ${postUrn} — likely propagation delay, retrying in 2s`,
      );
      await new Promise((r) => setTimeout(r, 2000));
      response = await tryComment(postUrn);
    }

    if (!response.ok) {
      const error = (await response.json().catch(() => ({}))) as {
        message?: string;
        serviceErrorCode?: number;
      };
      const reason = error?.message ?? `HTTP ${response.status}`;
      throw new Error(`LinkedIn comment post failed: ${reason}`);
    }

    // LinkedIn returns the new comment URN as x-restli-id header,
    // or in the response body as $URN. Try both.
    let commentUrn = response.headers.get('x-restli-id') ?? '';
    if (!commentUrn) {
      const data = (await response.json().catch(() => ({}))) as {
        $URN?: string;
      };
      commentUrn = data['$URN'] ?? '';
    }
    if (!commentUrn) {
      throw new Error('LinkedIn returned no comment URN');
    }
    return { commentUrn };
  }

  /**
   * Create a LinkedIn poll post via the versioned Posts API
   * (`POST /rest/posts` with `content.poll`, the Poll API guide's own
   * sample).
   *
   * It used to call `/v2/posts` with a hard-coded `LinkedIn-Version: 202404`
   * while every other format sent `LINKEDIN_REST_VERSION`. It now goes
   * through the same envelope and request as the rest, so the version, the
   * little-text commentary and the page-is-always-PUBLIC rule are shared.
   *
   * @param accessToken — Member access token
   * @param actorUrn — Full URN of the author (e.g. "urn:li:person:{id}" or "urn:li:organization:{id}")
   * @param question — The poll question (max 140 chars). A plain String in
   *   the Poll schema, not little text, so it is sent as typed.
   * @param options — 2–4 poll option strings (plain Strings, max 30 chars)
   * @param durationDays — 1 | 3 | 7 | 14 (LinkedIn-supported durations)
   * @param commentary — Optional commentary that appears as the post body above the poll card
   * @param visibility — PUBLIC | CONNECTIONS | LOGGED_IN (member audiences only valid for person authors)
   */
  async createPollPost(
    accessToken: string,
    actorUrn: string,
    question: string,
    options: string[],
    durationDays: number = 7,
    commentary: string = '',
    visibility: LinkedInVisibility = 'PUBLIC',
    /** `isReshareDisabledByAuthor` — stops others resharing the post. */
    disableReshare: boolean = false,
  ): Promise<{ postId: string }> {
    if (!question || !question.trim())
      throw new Error('Poll question is required');
    if (!Array.isArray(options) || options.length < 2) {
      throw new Error('Poll requires at least 2 options');
    }
    if (options.length > 4) throw new Error('Poll allows at most 4 options');

    // Map allowed durations
    const durationMap: Record<number, string> = {
      1: 'ONE_DAY',
      3: 'THREE_DAYS',
      7: 'SEVEN_DAYS',
      14: 'FOURTEEN_DAYS',
    };
    const duration = durationMap[durationDays] ?? 'SEVEN_DAYS';

    return this.createRestPost(
      accessToken,
      {
        ...this.restPostEnvelope(
          actorUrn,
          commentary || '',
          visibility,
          disableReshare,
        ),
        content: {
          poll: {
            question: question.trim(),
            options: options.map((o) => ({ text: o.trim() })),
            settings: {
              duration,
              // voteSelectionType:'SINGLE_VOTE' is the default; not setting it.
            },
          },
        },
      },
      'poll post',
    );
  }

  // ==========================================================================
  // Versioned APIs: Posts, Images and Documents
  //
  // None of this exists on the legacy `/v2/ugcPosts` path the other formats
  // use. A PDF is a Documents API asset referenced from a Posts API post; a
  // custom article thumbnail is an Images API asset referenced from
  // `content.article.thumbnail`. Both therefore ride the versioned Posts API,
  // which also carries `isReshareDisabledByAuthor`.
  // ==========================================================================

  private restHeaders(accessToken: string): Record<string, string> {
    return {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'X-Restli-Protocol-Version': '2.0.0',
      'Linkedin-Version': LINKEDIN_REST_VERSION,
    };
  }

  /** LinkedIn's own words for a failed call, so the cause reaches the user. */
  private async restFailure(response: Response): Promise<string> {
    const text = await response.text().catch(() => '');
    let reason = text.slice(0, 200);
    try {
      const parsed = JSON.parse(text) as { message?: unknown };
      if (typeof parsed.message === 'string') reason = parsed.message;
    } catch {
      // not JSON — the raw text above stands
    }
    return `HTTP ${response.status}${reason ? `: ${reason}` : ''}`;
  }

  /**
   * The file's address comes from the draft, so before anything is registered
   * with LinkedIn it has to be a web address: only http(s) is ever fetched.
   */
  private assertWebUrl(
    url: string,
    noun: 'image' | 'document' | 'video',
  ): void {
    if (!/^https?:\/\//i.test(url)) {
      throw new BadRequestException(
        `The ${noun} must be a web (http or https) address`,
      );
    }
  }

  /**
   * Register an upload with the Images or Documents API.
   *
   * `POST /rest/{images|documents}?action=initializeUpload` with
   * `{ initializeUploadRequest: { owner } }`; the answer is
   * `{ value: { uploadUrl, image | document } }`.
   */
  private async initializeRestUpload(
    kind: 'images' | 'documents',
    accessToken: string,
    ownerUrn: string,
  ): Promise<{ uploadUrl: string; urn: string }> {
    const noun = kind === 'images' ? 'image' : 'document';
    const response = await fetch(
      `${LINKEDIN_REST_URL}/${kind}?action=initializeUpload`,
      {
        method: 'POST',
        headers: this.restHeaders(accessToken),
        body: JSON.stringify({ initializeUploadRequest: { owner: ownerUrn } }),
      },
    );

    if (!response.ok) {
      const reason = await this.restFailure(response);
      this.logger.error(
        `Failed to initialize LinkedIn ${noun} upload: ${reason}`,
      );
      throw new BadRequestException(
        `Failed to start the LinkedIn ${noun} upload (${reason})`,
      );
    }

    const data = (await response.json()) as {
      value?: { uploadUrl?: string; image?: string; document?: string };
    };
    const urn = kind === 'images' ? data.value?.image : data.value?.document;
    if (!data.value?.uploadUrl || !urn) {
      throw new BadRequestException(
        `LinkedIn returned no upload target for the ${noun}`,
      );
    }
    return { uploadUrl: data.value.uploadUrl, urn };
  }

  /**
   * Fetch the file from our storage and PUT it to LinkedIn's upload URL.
   *
   * LinkedIn states that the image upload call requires the OAuth token in
   * `Authorization` (unlike the legacy video upload, which refuses one), and
   * the Documents API's own example sends it too — so it is sent for both.
   */
  private async uploadToRestAsset(
    sourceUrl: string,
    uploadUrl: string,
    accessToken: string,
    noun: 'image' | 'document',
    maxBytes?: number,
  ): Promise<void> {
    let source: Response;
    try {
      source = await fetchPublicMedia(sourceUrl);
    } catch (error) {
      this.logger.error(`Network error downloading ${noun}: ${error}`);
      throw new BadRequestException(
        `Failed to download the ${noun} from ${sourceUrl}: Network error`,
      );
    }
    if (!source.ok) {
      throw new BadRequestException(
        `Failed to download the ${noun} from ${sourceUrl} (HTTP ${source.status})`,
      );
    }

    const tooLarge = () =>
      new BadRequestException(
        `The ${noun} is larger than LinkedIn's ${Math.round((maxBytes ?? 0) / (1024 * 1024))} MB limit`,
      );
    // Refuse on the declared size first, so a 400 MB file is never buffered.
    const declared = Number(source.headers.get('content-length'));
    if (maxBytes && declared > maxBytes) throw tooLarge();

    const bytes = await source.arrayBuffer();
    if (maxBytes && bytes.byteLength > maxBytes) throw tooLarge();

    const upload = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/octet-stream',
      },
      body: bytes,
    });
    if (!upload.ok) {
      const reason = await this.restFailure(upload);
      this.logger.error(`Failed to upload ${noun} to LinkedIn: ${reason}`);
      throw new BadRequestException(
        `Failed to upload the ${noun} to LinkedIn (${reason})`,
      );
    }
  }

  /** `POST /rest/posts`; the new post's URN is the `x-restli-id` header. */
  private async createRestPost(
    accessToken: string,
    body: Record<string, unknown>,
    what: string,
  ): Promise<{ postId: string }> {
    const response = await fetch(`${LINKEDIN_REST_URL}/posts`, {
      method: 'POST',
      headers: this.restHeaders(accessToken),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const reason = await this.restFailure(response);
      this.logger.error(`Failed to create LinkedIn ${what}: ${reason}`);
      throw new BadRequestException(
        `Failed to create the LinkedIn ${what} (${reason})`,
      );
    }

    const fromHeader = response.headers.get('x-restli-id');
    if (fromHeader) return { postId: fromHeader };
    const data = (await response.json().catch(() => ({}))) as { id?: string };
    if (!data.id) {
      throw new BadRequestException(`LinkedIn returned no ID for the ${what}`);
    }
    return { postId: data.id };
  }

  /** The fields every versioned post carries, whatever its content. */
  private restPostEnvelope(
    authorUrn: string,
    commentary: string,
    visibility: LinkedInVisibility,
    disableReshare: boolean,
  ) {
    return {
      author: authorUrn,
      // `commentary` is little text: reserved characters escaped, hashtags
      // as templates (see linkedin-little-text.ts). Every Posts API post -
      // text, image, multi-image, video, document, link card, poll - is
      // built here, so this is the one place it happens.
      commentary: toLittleText(commentary),
      // `CONNECTIONS` / `LOGGED_IN` are member audiences; a page can only
      // post publicly.
      visibility: authorUrn.startsWith('urn:li:organization:')
        ? 'PUBLIC'
        : visibility,
      distribution: {
        feedDistribution: 'MAIN_FEED',
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: disableReshare,
    };
  }

  /**
   * A PDF (or PPT/PPTX/DOC/DOCX) post.
   *
   * Documents API `initializeUpload` -> PUT the file -> Posts API with
   * `content.media = { title, id: urn:li:document:… }`. The `title` is
   * required for documents (stated). The file is not polled for readiness:
   * the Posts API publishes a post whose media is still processing as
   * `PUBLISH_REQUESTED` and finishes it asynchronously (stated), and a
   * token with only `w_member_social` cannot read assets back anyway.
   */
  async createDocumentPost(
    accessToken: string,
    authorUrn: string,
    commentary: string,
    documentUrl: string,
    title: string,
    visibility: LinkedInVisibility = 'PUBLIC',
    disableReshare: boolean = false,
  ): Promise<{ postId: string }> {
    this.assertWebUrl(documentUrl, 'document');
    const { uploadUrl, urn } = await this.initializeRestUpload(
      'documents',
      accessToken,
      authorUrn,
    );
    await this.uploadToRestAsset(
      documentUrl,
      uploadUrl,
      accessToken,
      'document',
      MAX_DOCUMENT_BYTES,
    );

    return this.createRestPost(
      accessToken,
      {
        ...this.restPostEnvelope(
          authorUrn,
          commentary,
          visibility,
          disableReshare,
        ),
        content: { media: { title, id: urn } },
      },
      'document post',
    );
  }

  /**
   * A link post whose card carries OUR thumbnail.
   *
   * The Posts API does not scrape the URL (stated): `source` and `title`
   * are required and the card shows only what is sent here. The thumbnail is
   * an Images API asset, referenced by URN in `content.article.thumbnail`.
   * `description` is omitted when empty rather than sent blank.
   */
  async createArticlePostWithThumbnail(
    accessToken: string,
    authorUrn: string,
    commentary: string,
    article: {
      source: string;
      title: string;
      description?: string;
      thumbnailUrl: string;
    },
    visibility: LinkedInVisibility = 'PUBLIC',
    disableReshare: boolean = false,
  ): Promise<{ postId: string }> {
    this.assertWebUrl(article.thumbnailUrl, 'image');
    const { uploadUrl, urn } = await this.initializeRestUpload(
      'images',
      accessToken,
      authorUrn,
    );
    await this.uploadToRestAsset(
      article.thumbnailUrl,
      uploadUrl,
      accessToken,
      'image',
    );

    return this.createRestPost(
      accessToken,
      {
        ...this.restPostEnvelope(
          authorUrn,
          commentary,
          visibility,
          disableReshare,
        ),
        content: {
          article: {
            source: article.source,
            thumbnail: urn,
            title: article.title,
            ...(article.description
              ? { description: article.description }
              : {}),
          },
        },
      },
      'link post',
    );
  }

  // --------------------------------------------------------------------------
  // Text, image and video on the Posts API
  //
  // These replace the legacy `/v2/ugcPosts` paths for the formats the
  // composer publishes, so `isReshareDisabledByAuthor` ("Allow reposts")
  // reaches LinkedIn on every one of them. The request shapes are the Posts
  // API guide's own samples: a text post is the envelope alone, an image or
  // video post adds `content.media = { id, title? }` with an Images / Videos
  // API URN. The legacy methods above stay for any other caller.
  // --------------------------------------------------------------------------

  /** A text-only post (`POST /rest/posts`, no `content`). */
  async createRestTextPost(
    accessToken: string,
    authorUrn: string,
    commentary: string,
    visibility: LinkedInVisibility = 'PUBLIC',
    disableReshare: boolean = false,
  ): Promise<{ postId: string }> {
    return this.createRestPost(
      accessToken,
      this.restPostEnvelope(authorUrn, commentary, visibility, disableReshare),
      'post',
    );
  }

  /**
   * A single-image post: Images API `initializeUpload` -> PUT the file ->
   * Posts API with `content.media.id = urn:li:image:…`. `title` is sent only
   * when there is one (it is optional for media; required only for
   * documents). `altText` likewise - the Media schema's "The alternate text
   * for the media. None if empty. Optional."
   */
  async createRestImagePost(
    accessToken: string,
    authorUrn: string,
    commentary: string,
    imageUrl: string,
    title?: string,
    visibility: LinkedInVisibility = 'PUBLIC',
    disableReshare: boolean = false,
    options: { altText?: string } = {},
  ): Promise<{ postId: string }> {
    this.assertWebUrl(imageUrl, 'image');
    const urn = await this.uploadRestImage(accessToken, authorUrn, imageUrl);
    const altText = altTextOf(options.altText);

    return this.createRestPost(
      accessToken,
      {
        ...this.restPostEnvelope(
          authorUrn,
          commentary,
          visibility,
          disableReshare,
        ),
        content: {
          media: {
            id: urn,
            ...(title ? { title } : {}),
            ...(altText ? { altText } : {}),
          },
        },
      },
      'image post',
    );
  }

  /**
   * A post of 2–20 images: the MultiImage content of the Posts API.
   *
   * Each image is its own Images API upload (initializeUpload -> PUT), in
   * the order given - the order LinkedIn shows them in - and the post is
   * `content.multiImage.images = [{ id, altText? }, …]`, the MultiImage
   * guide's own sample. Every address is checked before anything is
   * registered, so a bad third image does not leave two orphan uploads.
   * Uploads run one after another rather than in parallel: 20 concurrent
   * downloads + PUTs would be the burst the rate limits punish.
   */
  async createRestMultiImagePost(
    accessToken: string,
    authorUrn: string,
    commentary: string,
    images: { url: string; altText?: string }[],
    visibility: LinkedInVisibility = 'PUBLIC',
    disableReshare: boolean = false,
  ): Promise<{ postId: string }> {
    if (
      images.length < LINKEDIN_MULTI_IMAGE_MIN ||
      images.length > LINKEDIN_MULTI_IMAGE_MAX
    ) {
      throw new BadRequestException(
        `A LinkedIn multi-image post takes ${LINKEDIN_MULTI_IMAGE_MIN} to ${LINKEDIN_MULTI_IMAGE_MAX} images (got ${images.length})`,
      );
    }
    for (const image of images) this.assertWebUrl(image.url, 'image');

    const entries: { id: string; altText?: string }[] = [];
    for (const image of images) {
      const id = await this.uploadRestImage(accessToken, authorUrn, image.url);
      const altText = altTextOf(image.altText);
      entries.push(altText ? { id, altText } : { id });
    }

    return this.createRestPost(
      accessToken,
      {
        ...this.restPostEnvelope(
          authorUrn,
          commentary,
          visibility,
          disableReshare,
        ),
        content: { multiImage: { images: entries } },
      },
      'multi-image post',
    );
  }

  /** Images API upload of one picture; resolves to its `urn:li:image:…`. */
  private async uploadRestImage(
    accessToken: string,
    authorUrn: string,
    imageUrl: string,
  ): Promise<string> {
    const { uploadUrl, urn } = await this.initializeRestUpload(
      'images',
      accessToken,
      authorUrn,
    );
    await this.uploadToRestAsset(imageUrl, uploadUrl, accessToken, 'image');
    return urn;
  }

  /**
   * A video post through the Videos API.
   *
   * 1. `POST /rest/videos?action=initializeUpload` with
   *    `{ owner, fileSizeBytes, uploadCaptions: false, uploadThumbnail }`
   *    -> `{ video, uploadToken, uploadInstructions: [{ firstByte, lastByte,
   *    uploadUrl }], thumbnailUploadUrl? }` (stated).
   * 2. PUT each byte range (inclusive `firstByte`..`lastByte`) to its url and
   *    keep the `etag` response header of each (stated: "save eTag").
   * 2b. With a thumbnail: PUT the image to `thumbnailUploadUrl` with
   *    `media-type-family: STILLIMAGE` and `Content-Type:
   *    application/octet-stream` (the guide's "Upload Thumbnail" sample,
   *    stated). Done before finalizing, the order the guide lists its steps
   *    in; that the order is required is INFERRED.
   * 3. `POST /rest/videos?action=finalizeUpload` with
   *    `{ video, uploadToken, uploadedPartIds }`, ids in instruction order
   *    (stated).
   * 4. Posts API with `content.media = { id: urn:li:video:…, title? }`.
   *
   * The part PUTs carry no Authorization header: the guide's own upload
   * sample sends none, and the legacy video upload refused one (INFERRED to
   * hold here). The video is not polled for AVAILABLE before posting: the
   * Posts API publishes a post whose media is still processing as
   * PUBLISH_REQUESTED (stated in the Post schema) - the legacy path did not
   * wait either.
   *
   * The thumbnail (`options.thumbnailUrl`, YouTube's designed picture) never
   * costs the post. It is downloaded FIRST, through the SSRF guard, and
   * `uploadThumbnail` is asked for only once the picture is in hand - so a
   * video is never registered as waiting for a thumbnail that cannot come.
   * A picture that cannot be downloaded, or an upload LinkedIn refuses, is
   * returned as `thumbnailWarning` and the video posts with the frame
   * LinkedIn picks. The guide says "a feed video can serve" when its
   * captions fail (stated) and calls the thumbnail optional for every video;
   * that a feed video likewise serves after a FAILED thumbnail upload is
   * INFERRED. Same scopes as any video post (`w_member_social` /
   * `w_organization_social`) - nothing to reconnect.
   */
  async createRestVideoPost(
    accessToken: string,
    authorUrn: string,
    commentary: string,
    videoUrl: string,
    title?: string,
    visibility: LinkedInVisibility = 'PUBLIC',
    disableReshare: boolean = false,
    options: { thumbnailUrl?: string; altText?: string } = {},
  ): Promise<{ postId: string; thumbnailWarning?: string }> {
    this.assertWebUrl(videoUrl, 'video');
    const bytes = await this.downloadVideo(videoUrl);

    let thumbnail: VideoThumbnail | undefined;
    let thumbnailWarning: string | undefined;
    if (options.thumbnailUrl) {
      try {
        thumbnail = await downloadVideoThumbnail(options.thumbnailUrl);
      } catch (err) {
        thumbnailWarning = `Posted without the thumbnail: ${err instanceof Error ? err.message : String(err)}`;
        this.logger.warn(`LinkedIn video: ${thumbnailWarning}`);
      }
    }

    const init = await fetch(
      `${LINKEDIN_REST_URL}/videos?action=initializeUpload`,
      {
        method: 'POST',
        headers: this.restHeaders(accessToken),
        body: JSON.stringify({
          initializeUploadRequest: {
            owner: authorUrn,
            fileSizeBytes: bytes.byteLength,
            uploadCaptions: false,
            uploadThumbnail: thumbnail !== undefined,
          },
        }),
      },
    );
    if (!init.ok) {
      const reason = await this.restFailure(init);
      this.logger.error(
        `Failed to initialize LinkedIn video upload: ${reason}`,
      );
      throw new BadRequestException(
        `Failed to start the LinkedIn video upload (${reason})`,
      );
    }
    const initData = (await init.json()) as {
      value?: {
        video?: string;
        uploadToken?: string;
        uploadInstructions?: {
          uploadUrl?: string;
          firstByte?: number;
          lastByte?: number;
        }[];
        thumbnailUploadUrl?: string;
      };
    };
    const video = initData.value?.video;
    const instructions = initData.value?.uploadInstructions ?? [];
    if (!video || instructions.length === 0) {
      throw new BadRequestException(
        'LinkedIn returned no upload target for the video',
      );
    }

    const uploadedPartIds: string[] = [];
    for (const [i, part] of instructions.entries()) {
      const first = part.firstByte;
      const last = part.lastByte;
      if (
        !part.uploadUrl ||
        typeof first !== 'number' ||
        typeof last !== 'number' ||
        first < 0 ||
        last < first ||
        last >= bytes.byteLength
      ) {
        throw new BadRequestException(
          `LinkedIn returned an unusable upload part (${i + 1} of ${instructions.length})`,
        );
      }
      const res = await fetch(part.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: bytes.slice(first, last + 1),
      });
      if (!res.ok) {
        const reason = await this.restFailure(res);
        this.logger.error(
          `Failed to upload LinkedIn video part ${i + 1}: ${reason}`,
        );
        throw new BadRequestException(
          `Failed to upload the video to LinkedIn (${reason})`,
        );
      }
      // The guide's ETag sample is unquoted; strip quotes in case a proxy
      // adds the standard ones.
      const etag = res.headers.get('etag')?.replace(/^"|"$/g, '');
      if (!etag) {
        throw new BadRequestException(
          `LinkedIn returned no ETag for video part ${i + 1}`,
        );
      }
      uploadedPartIds.push(etag);
    }

    if (thumbnail) {
      const warning = await this.uploadVideoThumbnail(
        initData.value?.thumbnailUploadUrl,
        thumbnail,
      );
      if (warning) {
        thumbnailWarning = warning;
        this.logger.warn(`LinkedIn video ${video}: ${warning}`);
      }
    }

    const finalize = await fetch(
      `${LINKEDIN_REST_URL}/videos?action=finalizeUpload`,
      {
        method: 'POST',
        headers: this.restHeaders(accessToken),
        body: JSON.stringify({
          finalizeUploadRequest: {
            video,
            uploadToken: initData.value?.uploadToken ?? '',
            uploadedPartIds,
          },
        }),
      },
    );
    if (!finalize.ok) {
      const reason = await this.restFailure(finalize);
      this.logger.error(`Failed to finalize LinkedIn video upload: ${reason}`);
      throw new BadRequestException(
        `Failed to finish the LinkedIn video upload (${reason})`,
      );
    }

    const videoAltText = altTextOf(options.altText);
    const posted = await this.createRestPost(
      accessToken,
      {
        ...this.restPostEnvelope(
          authorUrn,
          commentary,
          visibility,
          disableReshare,
        ),
        content: {
          media: {
            id: video,
            ...(title ? { title } : {}),
            ...(videoAltText ? { altText: videoAltText } : {}),
          },
        },
      },
      'video post',
    );
    return thumbnailWarning ? { ...posted, thumbnailWarning } : posted;
  }

  /**
   * PUTs a video's thumbnail to the `thumbnailUploadUrl` initializeUpload
   * returned. Resolves to a warning instead of throwing: the video is
   * uploaded by now, and a thumbnail is not worth losing it over.
   */
  private async uploadVideoThumbnail(
    uploadUrl: string | undefined,
    thumbnail: VideoThumbnail,
  ): Promise<string | undefined> {
    if (!uploadUrl) {
      return 'Posted without the thumbnail: LinkedIn returned no thumbnail upload address';
    }
    try {
      // The guide's sample sends no Authorization header on this upload,
      // as on the video parts.
      const res = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'media-type-family': 'STILLIMAGE',
          'Content-Type': 'application/octet-stream',
        },
        body: thumbnail.bytes,
      });
      if (!res.ok) {
        const reason = await this.restFailure(res);
        return `Posted without the thumbnail: LinkedIn refused it (${reason})`;
      }
      return undefined;
    } catch (err) {
      return `Posted without the thumbnail: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /** The whole video, refusing one over the Videos API's 500 MB. */
  private async downloadVideo(videoUrl: string): Promise<ArrayBuffer> {
    let source: Response;
    try {
      source = await fetchPublicMedia(videoUrl);
    } catch (error) {
      this.logger.error(`Network error downloading video: ${error}`);
      throw new BadRequestException(
        `Failed to download the video from ${videoUrl}: Network error`,
      );
    }
    if (!source.ok) {
      throw new BadRequestException(
        `Failed to download the video from ${videoUrl} (HTTP ${source.status})`,
      );
    }
    const tooLarge = () =>
      new BadRequestException(
        "The video is larger than LinkedIn's 500 MB limit",
      );
    const declared = Number(source.headers.get('content-length'));
    if (declared > MAX_VIDEO_BYTES) throw tooLarge();
    const bytes = await source.arrayBuffer();
    if (bytes.byteLength > MAX_VIDEO_BYTES) throw tooLarge();
    return bytes;
  }
}
