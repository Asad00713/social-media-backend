import { Injectable, Logger, BadRequestException } from '@nestjs/common';

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
    visibility: 'PUBLIC' | 'CONNECTIONS' = 'PUBLIC',
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
    visibility: 'PUBLIC' | 'CONNECTIONS' = 'PUBLIC',
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
    visibility: 'PUBLIC' | 'CONNECTIONS' = 'PUBLIC',
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
    visibility: 'PUBLIC' | 'CONNECTIONS' = 'PUBLIC',
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
      videoResponse = await fetch(videoUrl);
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
      imageResponse = await fetch(imageUrl);
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
   * Create a LinkedIn poll post via the Posts API (`/v2/posts`).
   *
   * Uses the newer versioned Posts API since /ugcPosts deprecated poll support.
   *
   * @param accessToken — Member access token
   * @param actorUrn — Full URN of the author (e.g. "urn:li:person:{id}" or "urn:li:organization:{id}")
   * @param question — The poll question (max 140 chars)
   * @param options — 2–4 poll option strings
   * @param durationDays — 1 | 3 | 7 | 14 (LinkedIn-supported durations)
   * @param commentary — Optional commentary that appears as the post body above the poll card
   * @param visibility — PUBLIC | CONNECTIONS (CONNECTIONS only valid for person authors)
   */
  async createPollPost(
    accessToken: string,
    actorUrn: string,
    question: string,
    options: string[],
    durationDays: number = 7,
    commentary: string = '',
    visibility: 'PUBLIC' | 'CONNECTIONS' = 'PUBLIC',
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

    const body = {
      author: actorUrn,
      commentary: commentary || '',
      visibility,
      lifecycleState: 'PUBLISHED',
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
      distribution: {
        feedDistribution: 'MAIN_FEED',
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      isReshareDisabledByAuthor: false,
    };

    const response = await fetch(`${this.apiBaseUrl}/posts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Restli-Protocol-Version': '2.0.0',
        'LinkedIn-Version': '202404',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorData = await response.text();
      this.logger.error(`Failed to create LinkedIn poll: ${errorData}`);
      throw new BadRequestException('Failed to create LinkedIn poll post');
    }

    // The /v2/posts endpoint returns the new post URN in the x-restli-id header.
    const postId = response.headers.get('x-restli-id') ?? '';
    if (!postId) {
      // Some response shapes return it in the body
      const data = (await response.json().catch(() => ({}))) as { id?: string };
      if (!data.id)
        throw new BadRequestException('LinkedIn returned no poll post ID');
      return { postId: data.id };
    }
    return { postId };
  }
}
