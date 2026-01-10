import { Injectable, Logger, BadRequestException } from '@nestjs/common';

export interface PinterestUser {
  id: string;
  username: string;
  businessName: string | null;
  profileImage: string | null;
  websiteUrl: string | null;
  accountType: string;
  followerCount: number;
  followingCount: number;
  monthlyViews: number;
}

export interface PinterestBoard {
  id: string;
  name: string;
  description: string | null;
  privacy: string;
  pinCount: number;
  followerCount: number;
  collaboratorCount: number;
}

@Injectable()
export class PinterestService {
  private readonly logger = new Logger(PinterestService.name);
  // Use sandbox API for trial/development, production API for approved apps
  // Set PINTEREST_USE_SANDBOX=true in .env to use sandbox
  private readonly apiUrl = process.env.PINTEREST_USE_SANDBOX === 'true'
    ? 'https://api-sandbox.pinterest.com/v5'
    : 'https://api.pinterest.com/v5';

  /**
   * Get current Pinterest user info
   */
  async getCurrentUser(accessToken: string): Promise<PinterestUser> {
    const response = await fetch(`${this.apiUrl}/user_account`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const error = await response.json();
      this.logger.error('Failed to fetch Pinterest user:', error);
      throw new BadRequestException(
        error.message || 'Failed to fetch Pinterest user info',
      );
    }

    const data = await response.json();

    return {
      id: data.id || data.username,
      username: data.username,
      businessName: data.business_name || null,
      profileImage: data.profile_image || null,
      websiteUrl: data.website_url || null,
      accountType: data.account_type || 'PERSONAL',
      followerCount: data.follower_count || 0,
      followingCount: data.following_count || 0,
      monthlyViews: data.monthly_views || 0,
    };
  }

  /**
   * Get user's Pinterest boards
   */
  async getUserBoards(accessToken: string): Promise<PinterestBoard[]> {
    const response = await fetch(`${this.apiUrl}/boards`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const error = await response.json();
      this.logger.error('Failed to fetch Pinterest boards:', error);
      throw new BadRequestException(
        error.message || 'Failed to fetch Pinterest boards',
      );
    }

    const data = await response.json();
    const boards: PinterestBoard[] = [];

    for (const board of data.items || []) {
      boards.push({
        id: board.id,
        name: board.name,
        description: board.description || null,
        privacy: board.privacy || 'PUBLIC',
        pinCount: board.pin_count || 0,
        followerCount: board.follower_count || 0,
        collaboratorCount: board.collaborator_count || 0,
      });
    }

    return boards;
  }

  /**
   * Create a new Pinterest board
   */
  async createBoard(
    accessToken: string,
    name: string,
    description?: string,
    privacy: 'PUBLIC' | 'SECRET' | 'PROTECTED' = 'PUBLIC',
  ): Promise<PinterestBoard> {
    const response = await fetch(`${this.apiUrl}/boards`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name,
        description: description || '',
        privacy,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      this.logger.error('Failed to create Pinterest board:', error);
      throw new BadRequestException(
        error.message || 'Failed to create board',
      );
    }

    const board = await response.json();
    this.logger.log(`Pinterest board created: ${board.id}`);

    return {
      id: board.id,
      name: board.name,
      description: board.description || null,
      privacy: board.privacy || 'PUBLIC',
      pinCount: 0,
      followerCount: 0,
      collaboratorCount: 0,
    };
  }

  /**
   * Create a pin on Pinterest (image or video)
   */
  async createPin(
    accessToken: string,
    boardId: string,
    title: string,
    description: string,
    mediaUrl: string,
    options?: {
      link?: string;
      mediaType?: 'image' | 'video';
      videoCoverImageUrl?: string;
    },
  ): Promise<{ pinId: string; pinUrl?: string }> {
    const isVideo = options?.mediaType === 'video';

    const body: Record<string, any> = {
      board_id: boardId,
      title,
      description,
      media_source: isVideo
        ? {
            source_type: 'video_id',
            cover_image_url: options?.videoCoverImageUrl || mediaUrl.replace('.mp4', '.jpg'),
            media_id: '', // Will be set after video upload
          }
        : {
            source_type: 'image_url',
            url: mediaUrl,
          },
    };

    if (options?.link) {
      body.link = options.link;
    }

    // For videos, we need to use the video upload flow
    if (isVideo) {
      return this.createVideoPin(accessToken, boardId, title, description, mediaUrl, options);
    }

    const response = await fetch(`${this.apiUrl}/pins`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.json();
      this.logger.error('Failed to create Pinterest pin:', error);
      throw new BadRequestException(
        error.message || 'Failed to create pin',
      );
    }

    const data = await response.json();
    this.logger.log(`Pinterest pin created: ${data.id}`);

    return {
      pinId: data.id,
      pinUrl: `https://www.pinterest.com/pin/${data.id}/`,
    };
  }

  /**
   * Create a video pin on Pinterest
   * Pinterest video upload flow:
   * 1. Register media upload
   * 2. Upload video to the provided URL
   * 3. Create pin with media_id
   */
  private async createVideoPin(
    accessToken: string,
    boardId: string,
    title: string,
    description: string,
    videoUrl: string,
    options?: { link?: string; videoCoverImageUrl?: string },
  ): Promise<{ pinId: string; pinUrl?: string }> {
    // Step 1: Register media upload
    const registerResponse = await fetch(`${this.apiUrl}/media`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        media_type: 'video',
      }),
    });

    if (!registerResponse.ok) {
      const error = await registerResponse.json();
      this.logger.error('Failed to register Pinterest media upload:', error);
      throw new BadRequestException(
        error.message || 'Failed to register video upload',
      );
    }

    const registerData = await registerResponse.json();
    const mediaId = registerData.media_id;
    const uploadUrl = registerData.upload_url;

    this.logger.log(`Pinterest video upload registered: media_id=${mediaId}`);

    // Step 2: Download video and upload to Pinterest
    const videoResponse = await fetch(videoUrl);
    if (!videoResponse.ok) {
      throw new BadRequestException(`Failed to download video from ${videoUrl}`);
    }

    const videoBuffer = await videoResponse.arrayBuffer();

    const uploadResponse = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'video/mp4',
      },
      body: videoBuffer,
    });

    if (!uploadResponse.ok) {
      const error = await uploadResponse.text();
      this.logger.error('Failed to upload video to Pinterest:', error);
      throw new BadRequestException('Failed to upload video to Pinterest');
    }

    this.logger.log(`Pinterest video uploaded successfully`);

    // Step 3: Wait for video processing and create pin
    await this.waitForMediaProcessing(accessToken, mediaId);

    // Step 4: Create pin with video
    const pinBody: Record<string, any> = {
      board_id: boardId,
      title,
      description,
      media_source: {
        source_type: 'video_id',
        media_id: mediaId,
      },
    };

    if (options?.link) {
      pinBody.link = options.link;
    }

    const pinResponse = await fetch(`${this.apiUrl}/pins`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(pinBody),
    });

    if (!pinResponse.ok) {
      const error = await pinResponse.json();
      this.logger.error('Failed to create Pinterest video pin:', error);
      throw new BadRequestException(
        error.message || 'Failed to create video pin',
      );
    }

    const pinData = await pinResponse.json();
    this.logger.log(`Pinterest video pin created: ${pinData.id}`);

    return {
      pinId: pinData.id,
      pinUrl: `https://www.pinterest.com/pin/${pinData.id}/`,
    };
  }

  /**
   * Wait for Pinterest media to finish processing
   */
  private async waitForMediaProcessing(
    accessToken: string,
    mediaId: string,
    maxAttempts = 30,
  ): Promise<void> {
    for (let i = 0; i < maxAttempts; i++) {
      const response = await fetch(`${this.apiUrl}/media/${mediaId}`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      if (!response.ok) {
        throw new BadRequestException('Failed to check media status');
      }

      const data = await response.json();
      const status = data.status;

      this.logger.log(`Pinterest media status: ${status}`);

      if (status === 'succeeded') {
        return;
      }

      if (status === 'failed') {
        throw new BadRequestException('Pinterest video processing failed');
      }

      // Wait 2 seconds before next check
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    throw new BadRequestException('Pinterest video processing timed out');
  }

  /**
   * Verify access token is valid
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
