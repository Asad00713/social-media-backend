import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

export interface BunnyCDNUploadResult {
  key: string;
  url: string;
  size: number;
  contentType: string;
}

/**
 * BunnyCDN Storage Service
 *
 * Use this for TikTok video hosting with your verified custom domain.
 * Videos uploaded here can be used with TikTok's PULL_FROM_URL method.
 *
 * Required environment variables:
 * - BUNNYCDN_STORAGE_ZONE: Your storage zone name (e.g., tiktok-verification)
 * - BUNNYCDN_ACCESS_KEY: Storage zone password/API key
 * - BUNNYCDN_STORAGE_HOSTNAME: Storage API hostname (e.g., sg.storage.bunnycdn.com)
 * - BUNNYCDN_CDN_URL: Your CDN pull zone URL (e.g., https://cdn.yourdomain.com)
 */
@Injectable()
export class BunnyCDNService {
  private readonly logger = new Logger(BunnyCDNService.name);
  private readonly storageZone: string;
  private readonly accessKey: string;
  private readonly storageHostname: string;
  private readonly cdnUrl: string;
  private readonly isConfigured: boolean;

  constructor(private readonly configService: ConfigService) {
    this.storageZone = this.configService.get<string>('BUNNYCDN_STORAGE_ZONE', '');
    this.accessKey = this.configService.get<string>('BUNNYCDN_ACCESS_KEY', '');
    this.storageHostname = this.configService.get<string>(
      'BUNNYCDN_STORAGE_HOSTNAME',
      'sg.storage.bunnycdn.com',
    );
    this.cdnUrl = this.configService.get<string>('BUNNYCDN_CDN_URL', '');

    if (this.storageZone && this.accessKey && this.cdnUrl) {
      this.isConfigured = true;
      this.logger.log(`BunnyCDN configured: ${this.storageZone} @ ${this.storageHostname}`);
    } else {
      this.isConfigured = false;
      this.logger.warn('BunnyCDN not configured - missing environment variables');
    }
  }

  /**
   * Check if BunnyCDN is properly configured
   */
  isReady(): boolean {
    return this.isConfigured;
  }

  /**
   * Get the base storage API URL
   */
  private getStorageApiUrl(): string {
    return `https://${this.storageHostname}/${this.storageZone}`;
  }

  /**
   * Upload a video from a URL (e.g., from Cloudinary)
   * Downloads the video and uploads it to BunnyCDN
   */
  async uploadVideoFromUrl(
    sourceUrl: string,
    options: {
      folder?: string;
      filename?: string;
    } = {},
  ): Promise<BunnyCDNUploadResult> {
    if (!this.isConfigured) {
      throw new BadRequestException('BunnyCDN is not configured');
    }

    const { folder = 'tiktok-videos', filename } = options;

    // Download the video
    this.logger.log(`Downloading video from: ${sourceUrl}`);
    const response = await fetch(sourceUrl);

    if (!response.ok) {
      throw new BadRequestException(`Failed to download video: ${response.status}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') || 'video/mp4';

    // Generate unique filename
    const uniqueId = crypto.randomBytes(8).toString('hex');
    const extension = this.getExtensionFromContentType(contentType);
    const finalFilename = filename || `${uniqueId}.${extension}`;
    const key = `${folder}/${finalFilename}`;

    // Upload to BunnyCDN
    await this.uploadBuffer(key, buffer, contentType);

    const url = `${this.cdnUrl}/${key}`;

    this.logger.log(`Video uploaded to BunnyCDN: ${url}`);

    return {
      key,
      url,
      size: buffer.length,
      contentType,
    };
  }

  /**
   * Upload a buffer directly to BunnyCDN
   */
  async uploadBuffer(
    key: string,
    buffer: Buffer,
    contentType: string = 'video/mp4',
  ): Promise<void> {
    if (!this.isConfigured) {
      throw new BadRequestException('BunnyCDN is not configured');
    }

    const uploadUrl = `${this.getStorageApiUrl()}/${key}`;

    this.logger.log(`Uploading to BunnyCDN: ${key} (${buffer.length} bytes)`);

    const response = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        AccessKey: this.accessKey,
        'Content-Type': contentType,
        'Content-Length': buffer.length.toString(),
      },
      body: new Uint8Array(buffer),
    });

    if (!response.ok) {
      const errorText = await response.text();
      this.logger.error(`BunnyCDN upload failed: ${response.status} - ${errorText}`);
      throw new BadRequestException(`Failed to upload to BunnyCDN: ${response.status}`);
    }

    this.logger.log(`Upload successful: ${key}`);
  }

  /**
   * Upload video from buffer with options
   */
  async uploadVideoFromBuffer(
    buffer: Buffer,
    options: {
      folder?: string;
      filename?: string;
      contentType?: string;
    } = {},
  ): Promise<BunnyCDNUploadResult> {
    if (!this.isConfigured) {
      throw new BadRequestException('BunnyCDN is not configured');
    }

    const {
      folder = 'tiktok-videos',
      filename,
      contentType = 'video/mp4',
    } = options;

    // Generate unique filename
    const uniqueId = crypto.randomBytes(8).toString('hex');
    const extension = this.getExtensionFromContentType(contentType);
    const finalFilename = filename || `${uniqueId}.${extension}`;
    const key = `${folder}/${finalFilename}`;

    await this.uploadBuffer(key, buffer, contentType);

    const url = `${this.cdnUrl}/${key}`;

    return {
      key,
      url,
      size: buffer.length,
      contentType,
    };
  }

  /**
   * Delete a file from BunnyCDN
   */
  async deleteFile(key: string): Promise<boolean> {
    if (!this.isConfigured) {
      throw new BadRequestException('BunnyCDN is not configured');
    }

    const deleteUrl = `${this.getStorageApiUrl()}/${key}`;

    try {
      const response = await fetch(deleteUrl, {
        method: 'DELETE',
        headers: {
          AccessKey: this.accessKey,
        },
      });

      if (response.ok) {
        this.logger.log(`Deleted from BunnyCDN: ${key}`);
        return true;
      }

      this.logger.warn(`Delete failed with status: ${response.status}`);
      return false;
    } catch (error) {
      this.logger.error(`Failed to delete from BunnyCDN: ${error}`);
      return false;
    }
  }

  /**
   * List files in a folder
   */
  async listFiles(folder: string = ''): Promise<
    Array<{
      name: string;
      path: string;
      isDirectory: boolean;
      length: number;
      lastChanged: string;
    }>
  > {
    if (!this.isConfigured) {
      throw new BadRequestException('BunnyCDN is not configured');
    }

    const listUrl = `${this.getStorageApiUrl()}/${folder}/`;

    const response = await fetch(listUrl, {
      method: 'GET',
      headers: {
        AccessKey: this.accessKey,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw new BadRequestException(`Failed to list files: ${response.status}`);
    }

    const files = await response.json();

    return files.map((file: any) => ({
      name: file.ObjectName,
      path: file.Path,
      isDirectory: file.IsDirectory,
      length: file.Length,
      lastChanged: file.LastChanged,
    }));
  }

  /**
   * Check if a file exists
   */
  async fileExists(key: string): Promise<boolean> {
    if (!this.isConfigured) {
      return false;
    }

    const checkUrl = `${this.getStorageApiUrl()}/${key}`;

    try {
      const response = await fetch(checkUrl, {
        method: 'HEAD',
        headers: {
          AccessKey: this.accessKey,
        },
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Get public URL for a key
   */
  getFileUrl(key: string): string {
    return `${this.cdnUrl}/${key}`;
  }

  /**
   * Get CDN URL base
   */
  getCdnUrl(): string {
    return this.cdnUrl;
  }

  /**
   * Get extension from content type
   */
  private getExtensionFromContentType(contentType: string): string {
    const mapping: Record<string, string> = {
      'video/mp4': 'mp4',
      'video/webm': 'webm',
      'video/quicktime': 'mov',
      'video/x-msvideo': 'avi',
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/gif': 'gif',
      'image/webp': 'webp',
    };
    return mapping[contentType] || 'mp4';
  }
}
