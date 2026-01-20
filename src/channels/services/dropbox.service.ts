import { Injectable, Logger, BadRequestException } from '@nestjs/common';

export interface DropboxFile {
  '.tag': 'file';
  id: string;
  name: string;
  path_lower: string;
  path_display: string;
  size: number;
  is_downloadable: boolean;
  client_modified: string;
  server_modified: string;
  rev: string;
  content_hash?: string;
  media_info?: {
    '.tag': 'metadata';
    metadata: {
      '.tag': 'photo' | 'video';
      dimensions?: {
        width: number;
        height: number;
      };
      time_taken?: string;
      duration?: number;
    };
  };
}

export interface DropboxFolder {
  '.tag': 'folder';
  id: string;
  name: string;
  path_lower: string;
  path_display: string;
}

export type DropboxEntry = DropboxFile | DropboxFolder;

export interface DropboxListResponse {
  entries: DropboxEntry[];
  cursor: string;
  has_more: boolean;
}

export interface DropboxThumbnail {
  file_id: string;
  thumbnail: string; // base64 encoded
}

@Injectable()
export class DropboxService {
  private readonly logger = new Logger(DropboxService.name);
  private readonly apiBaseUrl = 'https://api.dropboxapi.com/2';
  private readonly contentUrl = 'https://content.dropboxapi.com/2';

  /**
   * List files and folders in a path
   */
  async listFolder(
    accessToken: string,
    options: {
      path?: string;
      limit?: number;
      cursor?: string;
      recursive?: boolean;
    } = {},
  ): Promise<DropboxListResponse> {
    const { path = '', limit = 20, cursor, recursive = false } = options;

    let url: string;
    let body: Record<string, any>;

    if (cursor) {
      // Continue from cursor
      url = `${this.apiBaseUrl}/files/list_folder/continue`;
      body = { cursor };
    } else {
      url = `${this.apiBaseUrl}/files/list_folder`;
      body = {
        path: path === '/' ? '' : path,
        recursive,
        limit,
        include_media_info: true,
        include_deleted: false,
        include_has_explicit_shared_members: false,
        include_mounted_folders: true,
        include_non_downloadable_files: false,
      };
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      this.logger.error(`Failed to list Dropbox folder: ${error}`);
      throw new BadRequestException('Failed to list Dropbox folder');
    }

    const data = await response.json();

    return {
      entries: data.entries || [],
      cursor: data.cursor,
      has_more: data.has_more,
    };
  }

  /**
   * List only images from Dropbox
   */
  async listImages(
    accessToken: string,
    options: {
      path?: string;
      limit?: number;
      cursor?: string;
    } = {},
  ): Promise<DropboxListResponse> {
    const result = await this.listFolder(accessToken, options);

    // Filter for image files
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.svg'];
    const images = result.entries.filter((entry) => {
      if (entry['.tag'] !== 'file') return false;
      const ext = entry.name.toLowerCase().split('.').pop();
      return ext && imageExtensions.includes(`.${ext}`);
    });

    return {
      entries: images,
      cursor: result.cursor,
      has_more: result.has_more,
    };
  }

  /**
   * List only videos from Dropbox
   */
  async listVideos(
    accessToken: string,
    options: {
      path?: string;
      limit?: number;
      cursor?: string;
    } = {},
  ): Promise<DropboxListResponse> {
    const result = await this.listFolder(accessToken, options);

    // Filter for video files
    const videoExtensions = ['.mp4', '.mov', '.avi', '.mkv', '.wmv', '.flv', '.webm', '.m4v'];
    const videos = result.entries.filter((entry) => {
      if (entry['.tag'] !== 'file') return false;
      const ext = entry.name.toLowerCase().split('.').pop();
      return ext && videoExtensions.includes(`.${ext}`);
    });

    return {
      entries: videos,
      cursor: result.cursor,
      has_more: result.has_more,
    };
  }

  /**
   * List images and videos (media files)
   */
  async listMedia(
    accessToken: string,
    options: {
      path?: string;
      limit?: number;
      cursor?: string;
    } = {},
  ): Promise<DropboxListResponse> {
    const result = await this.listFolder(accessToken, options);

    // Filter for media files
    const mediaExtensions = [
      '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.svg',
      '.mp4', '.mov', '.avi', '.mkv', '.wmv', '.flv', '.webm', '.m4v',
    ];
    const media = result.entries.filter((entry) => {
      if (entry['.tag'] !== 'file') return false;
      const ext = entry.name.toLowerCase().split('.').pop();
      return ext && mediaExtensions.includes(`.${ext}`);
    });

    return {
      entries: media,
      cursor: result.cursor,
      has_more: result.has_more,
    };
  }

  /**
   * List only folders
   */
  async listFolders(
    accessToken: string,
    options: {
      path?: string;
      limit?: number;
      cursor?: string;
    } = {},
  ): Promise<DropboxListResponse> {
    const result = await this.listFolder(accessToken, options);

    const folders = result.entries.filter((entry) => entry['.tag'] === 'folder');

    return {
      entries: folders,
      cursor: result.cursor,
      has_more: result.has_more,
    };
  }

  /**
   * Search for files by name
   */
  async searchFiles(
    accessToken: string,
    query: string,
    options: {
      path?: string;
      maxResults?: number;
      cursor?: string;
      fileExtensions?: string[];
    } = {},
  ): Promise<{
    matches: DropboxEntry[];
    cursor?: string;
    has_more: boolean;
  }> {
    const { path = '', maxResults = 20, cursor, fileExtensions } = options;

    let url: string;
    let body: Record<string, any>;

    if (cursor) {
      url = `${this.apiBaseUrl}/files/search/continue_v2`;
      body = { cursor };
    } else {
      url = `${this.apiBaseUrl}/files/search_v2`;
      body = {
        query,
        options: {
          path: path === '/' ? '' : path,
          max_results: maxResults,
          file_status: 'active',
          filename_only: false,
        },
        match_field_options: {
          include_highlights: false,
        },
      };

      if (fileExtensions && fileExtensions.length > 0) {
        body.options.file_extensions = fileExtensions;
      }
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      this.logger.error(`Failed to search Dropbox: ${error}`);
      throw new BadRequestException('Failed to search Dropbox');
    }

    const data = await response.json();

    return {
      matches: data.matches?.map((m: any) => m.metadata?.metadata) || [],
      cursor: data.cursor,
      has_more: data.has_more,
    };
  }

  /**
   * Get metadata for a file or folder
   */
  async getMetadata(accessToken: string, path: string): Promise<DropboxEntry> {
    const response = await fetch(`${this.apiBaseUrl}/files/get_metadata`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        path,
        include_media_info: true,
        include_deleted: false,
        include_has_explicit_shared_members: false,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      this.logger.error(`Failed to get Dropbox metadata: ${error}`);
      throw new BadRequestException('Failed to get Dropbox metadata');
    }

    return response.json();
  }

  /**
   * Get a temporary download link
   */
  async getTemporaryLink(accessToken: string, path: string): Promise<string> {
    const response = await fetch(`${this.apiBaseUrl}/files/get_temporary_link`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ path }),
    });

    if (!response.ok) {
      const error = await response.text();
      this.logger.error(`Failed to get Dropbox temporary link: ${error}`);
      throw new BadRequestException('Failed to get Dropbox temporary link');
    }

    const data = await response.json();
    return data.link;
  }

  /**
   * Download file content as buffer
   */
  async downloadFile(accessToken: string, path: string): Promise<Buffer> {
    const response = await fetch(`${this.contentUrl}/files/download`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Dropbox-API-Arg': JSON.stringify({ path }),
      },
    });

    if (!response.ok) {
      const error = await response.text();
      this.logger.error(`Failed to download Dropbox file: ${error}`);
      throw new BadRequestException('Failed to download Dropbox file');
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  /**
   * Get thumbnail for a file
   */
  async getThumbnail(
    accessToken: string,
    path: string,
    options: {
      format?: 'jpeg' | 'png';
      size?: 'w32h32' | 'w64h64' | 'w128h128' | 'w256h256' | 'w480h320' | 'w640h480' | 'w960h640' | 'w1024h768' | 'w2048h1536';
      mode?: 'strict' | 'bestfit' | 'fitone_bestfit';
    } = {},
  ): Promise<Buffer> {
    const { format = 'jpeg', size = 'w256h256', mode = 'strict' } = options;

    const response = await fetch(`${this.contentUrl}/files/get_thumbnail_v2`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Dropbox-API-Arg': JSON.stringify({
          resource: { '.tag': 'path', path },
          format: { '.tag': format },
          size: { '.tag': size },
          mode: { '.tag': mode },
        }),
      },
    });

    if (!response.ok) {
      const error = await response.text();
      this.logger.error(`Failed to get Dropbox thumbnail: ${error}`);
      throw new BadRequestException('Failed to get Dropbox thumbnail');
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  /**
   * Verify if the access token is valid
   */
  async verifyAccess(accessToken: string): Promise<boolean> {
    try {
      const response = await fetch(`${this.apiBaseUrl}/users/get_current_account`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Get user's Dropbox account info
   */
  async getUserInfo(accessToken: string): Promise<{
    account_id: string;
    name: {
      given_name: string;
      surname: string;
      familiar_name: string;
      display_name: string;
    };
    email: string;
    email_verified: boolean;
    profile_photo_url?: string;
    country?: string;
  }> {
    const response = await fetch(`${this.apiBaseUrl}/users/get_current_account`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      this.logger.error(`Failed to get Dropbox user info: ${error}`);
      throw new BadRequestException('Failed to get Dropbox user info');
    }

    return response.json();
  }

  /**
   * Get space usage info
   */
  async getSpaceUsage(accessToken: string): Promise<{
    used: number;
    allocation: {
      '.tag': 'individual' | 'team';
      allocated: number;
    };
  }> {
    const response = await fetch(`${this.apiBaseUrl}/users/get_space_usage`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      this.logger.error(`Failed to get Dropbox space usage: ${error}`);
      throw new BadRequestException('Failed to get Dropbox space usage');
    }

    return response.json();
  }
}
