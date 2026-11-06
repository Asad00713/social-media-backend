import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { fetchPublicMedia } from '../../common/net/public-fetch';

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

/** A section inside a board (`BoardSection` in Pinterest's OpenAPI spec). */
export interface PinterestBoardSection {
  id: string;
  name: string;
}

/** Pinterest's own cap on a pin's alt text. */
const PIN_ALT_TEXT_MAX_CHARS = 500;

/**
 * The key frame second to send, or 0 (the first frame).
 *
 * Only a finite, non-negative number is a second. Anything else — a
 * string from an old draft, a negative from a bad client — falls back to
 * the first frame rather than reaching Pinterest as a value it rejects.
 */
function coverKeyFrame(sec: unknown): number {
  return typeof sec === 'number' && Number.isFinite(sec) && sec >= 0 ? sec : 0;
}

/** Pinterest's own cap on a board section's name (`maxLength: 180`). */
const SECTION_NAME_MAX_CHARS = 180;

/**
 * `page_size` is capped at 250 by the API. A board with more sections than
 * `SECTIONS_MAX_PAGES` of that is not a board a picker can usefully show, and
 * the bound keeps a misbehaving `bookmark` from looping forever.
 */
const SECTIONS_PAGE_SIZE = 250;
const SECTIONS_MAX_PAGES = 10;

@Injectable()
export class PinterestService {
  private readonly logger = new Logger(PinterestService.name);
  // Use sandbox API for trial/development, production API for approved apps
  // Set PINTEREST_USE_SANDBOX=true in .env to use sandbox
  private readonly apiUrl =
    process.env.PINTEREST_USE_SANDBOX === 'true'
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
   * Board listing used by the composer's board picker. Returns the full set
   * of fields Pinterest's `GET /v5/boards` provides — the picker uses
   * `pinCount` (for the row badge + delete blast-radius), `privacy` (for the
   * 🌐/🔒 icon), and `image_thumbnail_url` (if we add board thumbnails later).
   */
  async listBoards(
    accessToken: string,
  ): Promise<Array<PinterestBoard & { image_thumbnail_url: string | null }>> {
    const response = await fetch(`${this.apiUrl}/boards`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      this.logger.error('Failed to list Pinterest boards:', error);
      throw new BadRequestException(
        error.message || 'Failed to list Pinterest boards',
      );
    }

    const data = await response.json();
    return (data.items || []).map((board: any) => ({
      id: board.id,
      name: board.name,
      description: board.description || null,
      privacy: board.privacy || 'PUBLIC',
      pinCount: typeof board.pin_count === 'number' ? board.pin_count : 0,
      followerCount:
        typeof board.follower_count === 'number' ? board.follower_count : 0,
      collaboratorCount:
        typeof board.collaborator_count === 'number'
          ? board.collaborator_count
          : 0,
      image_thumbnail_url:
        board.media?.image_cover_url ||
        board.media?.pin_thumbnail_urls?.[0] ||
        null,
    }));
  }

  /**
   * The sections of one board, for the composer's board picker.
   *
   * Pinterest API: `GET /v5/boards/{board_id}/sections` (scope
   * `boards:read`), a `bookmark`-paginated list of `{ id, name }`. The
   * default page is 25, so this asks for the maximum and follows the
   * bookmark — a picker that silently showed the first 25 would make the
   * 26th section unreachable with no hint that it exists.
   *
   * `boardId` is encoded before it joins the path: it arrives from a URL
   * segment, and an id containing `/` or `..` must not be able to address a
   * different endpoint with this account's token.
   */
  async listBoardSections(
    accessToken: string,
    boardId: string,
  ): Promise<PinterestBoardSection[]> {
    const sections: PinterestBoardSection[] = [];
    let bookmark: string | null = null;

    for (let page = 0; page < SECTIONS_MAX_PAGES; page++) {
      const query = new URLSearchParams({
        page_size: String(SECTIONS_PAGE_SIZE),
      });
      if (bookmark) query.set('bookmark', bookmark);

      const response = await fetch(
        `${this.apiUrl}/boards/${encodeURIComponent(boardId)}/sections?${query.toString()}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        },
      );

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        this.logger.error('Failed to list Pinterest board sections:', error);
        throw new BadRequestException(
          error.message || 'Failed to list board sections',
        );
      }

      const data = await response.json();
      for (const item of data.items || []) {
        if (typeof item?.id === 'string' && typeof item?.name === 'string') {
          sections.push({ id: item.id, name: item.name });
        }
      }

      bookmark = typeof data.bookmark === 'string' ? data.bookmark : null;
      if (!bookmark) break;
    }

    return sections;
  }

  /**
   * Create a section inside a board.
   *
   * Pinterest API: `POST /v5/boards/{board_id}/sections` (scopes
   * `boards:read` + `boards:write`), body `{ name }` with a name of 1 to 180
   * characters; answers 201 with the new `{ id, name }`.
   */
  async createBoardSection(
    accessToken: string,
    boardId: string,
    name: string,
  ): Promise<PinterestBoardSection> {
    const response = await fetch(
      `${this.apiUrl}/boards/${encodeURIComponent(boardId)}/sections`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: name.slice(0, SECTION_NAME_MAX_CHARS) }),
      },
    );

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      this.logger.error('Failed to create Pinterest board section:', error);
      throw new BadRequestException(
        error.message || 'Failed to create board section',
      );
    }

    const section = await response.json();
    this.logger.log(`Pinterest board section created: ${section.id}`);
    return { id: section.id, name: section.name };
  }

  /**
   * Create a new Pinterest board
   */
  async createBoard(
    accessToken: string,
    name: string,
    description?: string,
    privacy: 'PUBLIC' | 'SECRET' = 'PUBLIC',
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
      throw new BadRequestException(error.message || 'Failed to create board');
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
   * Update an existing Pinterest board's metadata.
   * Pinterest API: PATCH /v5/boards/{board_id}
   */
  async updateBoard(
    accessToken: string,
    boardId: string,
    patch: {
      name?: string;
      description?: string;
      privacy?: 'PUBLIC' | 'SECRET';
    },
  ): Promise<PinterestBoard> {
    const body: Record<string, unknown> = {};
    if (typeof patch.name === 'string') body.name = patch.name;
    if (typeof patch.description === 'string')
      body.description = patch.description;
    if (patch.privacy) body.privacy = patch.privacy;

    if (Object.keys(body).length === 0) {
      throw new BadRequestException('No board fields supplied to update');
    }

    const response = await fetch(`${this.apiUrl}/boards/${boardId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      this.logger.error('Failed to update Pinterest board:', error);
      throw new BadRequestException(error.message || 'Failed to update board');
    }

    const board = await response.json();
    this.logger.log(`Pinterest board updated: ${board.id}`);

    return {
      id: board.id,
      name: board.name,
      description: board.description || null,
      privacy: board.privacy || 'PUBLIC',
      pinCount: typeof board.pin_count === 'number' ? board.pin_count : 0,
      followerCount:
        typeof board.follower_count === 'number' ? board.follower_count : 0,
      collaboratorCount:
        typeof board.collaborator_count === 'number'
          ? board.collaborator_count
          : 0,
    };
  }

  /**
   * Delete a Pinterest board. Also removes every pin inside it.
   * Pinterest API: DELETE /v5/boards/{board_id} → 204 on success.
   */
  async deleteBoard(accessToken: string, boardId: string): Promise<void> {
    const response = await fetch(`${this.apiUrl}/boards/${boardId}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok && response.status !== 204) {
      const error = await response.json().catch(() => ({}));
      this.logger.error('Failed to delete Pinterest board:', error);
      throw new BadRequestException(error.message || 'Failed to delete board');
    }

    this.logger.log(`Pinterest board deleted: ${boardId}`);
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
      /**
       * The second of the video to use as the cover when no image is
       * given — `cover_image_key_frame_time`, which Pinterest takes in
       * SECONDS. The composer stores the chosen frame as `coverFrameSec`.
       */
      coverKeyFrameSec?: number;
      /** `alt_text` on PinCreate — capped at 500 characters by the API. */
      altText?: string;
      /**
       * `ai_disclosures`, an OBJECT wrapping a list of UPPERCASE values
       * (`AI_MODIFIED`, `SYNTHETIC_PERFORMER`) — not the lowercase
       * `ai_modified` of the catalogs API, which is a different enum on a
       * different resource.
       */
      aiModified?: boolean;
      /** `board_section_id` — a section within the chosen board. */
      boardSectionId?: string;
      /**
       * Extra image urls, turning the pin into a carousel.
       *
       * `media_source` is a discriminated union: `image_url` takes ONE
       * url, `multiple_image_urls` takes an `items` array of 2 to 5. So a
       * carousel is a different source_type, not an extra field.
       */
      extraImageUrls?: string[];
    },
  ): Promise<{ pinId: string; pinUrl?: string }> {
    const isVideo = options?.mediaType === 'video';

    // 2 to 5 per the spec's minItems/maxItems. The first url is the one
    // passed as `mediaUrl`, so the extras fill the remaining four slots.
    const extras = (options?.extraImageUrls ?? []).filter(Boolean).slice(0, 4);
    const isCarousel = !isVideo && extras.length > 0;

    const body: Record<string, any> = {
      board_id: boardId,
      title,
      description,
      // A video's media_source is built in createVideoPin, once the
      // upload has a media_id; this branch is never sent. It used to
      // invent a cover by swapping `.mp4` for `.jpg` on the video URL —
      // a file that need not exist.
      media_source: isVideo
        ? { source_type: 'video_id' }
        : isCarousel
          ? {
              source_type: 'multiple_image_urls',
              items: [mediaUrl, ...extras].map((url) => ({ url })),
            }
          : {
              source_type: 'image_url',
              url: mediaUrl,
            },
    };

    if (options?.link) {
      body.link = options.link;
    }

    if (options?.altText) {
      body.alt_text = options.altText.slice(0, PIN_ALT_TEXT_MAX_CHARS);
    }

    if (options?.boardSectionId) {
      body.board_section_id = options.boardSectionId;
    }

    // Only ever sent as a declaration, never as a denial: the field is a
    // list of disclosures the creator HAS made, so "not AI" is an absent
    // field rather than an empty list.
    if (options?.aiModified) {
      body.ai_disclosures = { values: ['AI_MODIFIED'] };
    }

    // For videos, we need to use the video upload flow
    if (isVideo) {
      return this.createVideoPin(
        accessToken,
        boardId,
        title,
        description,
        mediaUrl,
        options,
      );
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
      throw new BadRequestException(error.message || 'Failed to create pin');
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
    options?: {
      link?: string;
      videoCoverImageUrl?: string;
      coverKeyFrameSec?: number;
    },
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

    const registerData = (await registerResponse.json()) as {
      media_id: string;
      upload_url: string;
      // AWS S3 form fields (key, policy, signature, etc.) that MUST be sent
      // alongside the file as multipart/form-data — the S3 upload is
      // rejected without them.
      upload_parameters?: Record<string, string>;
    };
    const mediaId = registerData.media_id;
    const uploadUrl = registerData.upload_url;
    const uploadParameters = registerData.upload_parameters ?? {};

    this.logger.log(`Pinterest video upload registered: media_id=${mediaId}`);

    // Step 2: Download video and upload to Pinterest's S3 bucket.
    // Pinterest requires a multipart/form-data POST containing every
    // upload_parameter as a field, with the video file LAST under `file`.
    const videoResponse = await fetchPublicMedia(videoUrl);
    if (!videoResponse.ok) {
      throw new BadRequestException(
        `Failed to download video from ${videoUrl}`,
      );
    }

    const videoBuffer = await videoResponse.arrayBuffer();

    const uploadForm = new FormData();
    for (const [key, value] of Object.entries(uploadParameters)) {
      uploadForm.append(key, value);
    }
    // File field must come after the parameters for the S3 policy to match.
    uploadForm.append('file', new Blob([videoBuffer], { type: 'video/mp4' }));

    // No explicit Content-Type header — fetch derives the multipart boundary
    // from the FormData; setting it manually would break the boundary.
    const uploadResponse = await fetch(uploadUrl, {
      method: 'POST',
      body: uploadForm,
    });

    if (!uploadResponse.ok) {
      const error = await uploadResponse.text();
      this.logger.error('Failed to upload video to Pinterest:', error);
      throw new BadRequestException('Failed to upload video to Pinterest');
    }

    this.logger.log(`Pinterest video uploaded successfully`);

    // Step 3: Wait for video processing and create pin
    await this.waitForMediaProcessing(accessToken, mediaId);

    // Step 4: Create pin with video.
    // Pinterest wants a cover for a video pin — its guide says a valid
    // image url must be provided to avoid a 400, so "send nothing and let
    // Pinterest pick" is not an option. Either an explicit cover_image_url,
    // or cover_image_key_frame_time: the SECOND of the video to grab (the
    // v5 spec's own description; past the end, the last frame is used).
    // The uploaded frame wins; without one, the second the composer
    // stored, and without that the first frame.
    const mediaSource: Record<string, any> = {
      source_type: 'video_id',
      media_id: mediaId,
    };
    if (options?.videoCoverImageUrl) {
      mediaSource.cover_image_url = options.videoCoverImageUrl;
    } else {
      mediaSource.cover_image_key_frame_time = coverKeyFrame(
        options?.coverKeyFrameSec,
      );
    }

    const pinBody: Record<string, any> = {
      board_id: boardId,
      title,
      description,
      media_source: mediaSource,
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
