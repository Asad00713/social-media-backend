import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  v2 as cloudinary,
  UploadApiResponse,
  UploadApiErrorResponse,
} from 'cloudinary';

export interface UploadResult {
  publicId: string;
  url: string;
  secureUrl: string;
  format: string;
  resourceType: 'image' | 'video' | 'raw';
  bytes: number;
  width?: number;
  height?: number;
  duration?: number;
  thumbnailUrl?: string;
  /** Pages of a PDF (Cloudinary reports a GIF's frame count here too). */
  pages?: number;
  /**
   * True when Cloudinary returned an asset that was already stored under this
   * public id (`overwrite: false`) instead of storing ours. Never ours to
   * claim or delete.
   */
  existing?: boolean;
}

/**
 * What a store says about a file's size. `missing`: it is not there (not
 * uploaded yet, or never was). `error`: the store could not be asked; try
 * again later. An unknown size is never a number a caller could swap for a
 * client's claim.
 */
export type StoredSize =
  | { kind: 'size'; bytes: number }
  | { kind: 'missing' }
  | { kind: 'error' };

export interface UploadOptions {
  folder?: string;
  resourceType?: 'image' | 'video' | 'auto' | 'raw';
  transformation?: Record<string, any>;
  tags?: string[];
  publicId?: string;
}

const DEFAULT_FOLDER = 'social-media';

/**
 * The folder an upload goes to. An explicit public id is the whole location,
 * so it gets no default folder in front of it.
 */
function targetFolder(options: UploadOptions): string | undefined {
  if (options.folder) return options.folder;
  return options.publicId ? undefined : DEFAULT_FOLDER;
}

/** Cloudinary's HTTP status on a rejected admin API call, if it gave one. */
function httpCodeOf(error: unknown): number | undefined {
  const e = error as {
    http_code?: unknown;
    error?: { http_code?: unknown };
  } | null;
  const code = e?.error?.http_code ?? e?.http_code;
  return typeof code === 'number' ? code : undefined;
}

@Injectable()
export class CloudinaryService {
  private readonly logger = new Logger(CloudinaryService.name);
  private readonly isConfigured: boolean;
  private readonly cloudName: string;

  constructor(private readonly configService: ConfigService) {
    const cloudName = this.configService.get<string>('CLOUDINARY_CLOUD_NAME');
    this.cloudName = cloudName ?? '';
    const apiKey = this.configService.get<string>('CLOUDINARY_API_KEY');
    const apiSecret = this.configService.get<string>('CLOUDINARY_API_SECRET');

    if (cloudName && apiKey && apiSecret) {
      cloudinary.config({
        cloud_name: cloudName,
        api_key: apiKey,
        api_secret: apiSecret,
        secure: true,
      });
      this.isConfigured = true;
      this.logger.log('Cloudinary configured successfully');
    } else {
      this.isConfigured = false;
      this.logger.warn(
        'Cloudinary not configured - missing environment variables',
      );
    }
  }

  /**
   * Check if Cloudinary is properly configured
   */
  isReady(): boolean {
    return this.isConfigured;
  }

  /**
   * True when the URL points into this account's Cloudinary delivery path
   * (`https://res.cloudinary.com/<cloud name>/...`). The trailing slash stops
   * `res.cloudinary.com.evil.io` and a cloud name that merely starts the same.
   */
  isOwnUrl(url: string): boolean {
    if (!this.cloudName || !url) return false;
    return url.startsWith(`https://res.cloudinary.com/${this.cloudName}/`);
  }

  /**
   * Upload a file from a URL
   */
  async uploadFromUrl(
    url: string,
    options: UploadOptions = {},
  ): Promise<UploadResult> {
    if (!this.isConfigured) {
      throw new BadRequestException('Cloudinary is not configured');
    }

    const {
      resourceType = 'auto',
      transformation,
      tags = [],
      publicId,
    } = options;
    const folder = targetFolder(options);

    try {
      this.logger.log(`Uploading from URL: ${url}`);

      const uploadOptions: Record<string, any> = {
        resource_type: resourceType,
        tags,
        unique_filename: true,
        overwrite: false,
      };

      if (folder) {
        uploadOptions.folder = folder;
      }

      if (publicId) {
        uploadOptions.public_id = publicId;
      }

      if (transformation) {
        uploadOptions.transformation = transformation;
      }

      const result = await cloudinary.uploader.upload(url, uploadOptions);

      this.logger.log(`Upload successful: ${result.public_id}`);

      return this.mapUploadResult(result);
    } catch (error) {
      this.logger.error(`Upload failed: ${error}`);
      throw new BadRequestException(`Failed to upload media: ${error.message}`);
    }
  }

  /**
   * Upload a file from base64 string
   */
  async uploadFromBase64(
    base64Data: string,
    options: UploadOptions = {},
  ): Promise<UploadResult> {
    if (!this.isConfigured) {
      throw new BadRequestException('Cloudinary is not configured');
    }

    const {
      resourceType = 'auto',
      transformation,
      tags = [],
      publicId,
    } = options;
    const folder = targetFolder(options);

    try {
      // Ensure base64 has proper data URI prefix
      let dataUri = base64Data;
      if (!base64Data.startsWith('data:')) {
        // Try to detect the type from the base64 header
        dataUri = `data:application/octet-stream;base64,${base64Data}`;
      }

      this.logger.log('Uploading from base64 data');

      const uploadOptions: Record<string, any> = {
        resource_type: resourceType,
        tags,
        unique_filename: true,
        overwrite: false,
      };

      if (folder) {
        uploadOptions.folder = folder;
      }

      if (publicId) {
        uploadOptions.public_id = publicId;
      }

      if (transformation) {
        uploadOptions.transformation = transformation;
      }

      const result = await cloudinary.uploader.upload(dataUri, uploadOptions);

      this.logger.log(`Upload successful: ${result.public_id}`);

      return this.mapUploadResult(result);
    } catch (error) {
      this.logger.error(`Base64 upload failed: ${error}`);
      throw new BadRequestException(`Failed to upload media: ${error.message}`);
    }
  }

  /**
   * Upload a file from buffer
   */
  async uploadFromBuffer(
    buffer: Buffer,
    options: UploadOptions = {},
  ): Promise<UploadResult> {
    if (!this.isConfigured) {
      throw new BadRequestException('Cloudinary is not configured');
    }

    const {
      resourceType = 'auto',
      transformation,
      tags = [],
      publicId,
    } = options;
    const folder = targetFolder(options);

    return new Promise((resolve, reject) => {
      const uploadOptions: Record<string, any> = {
        resource_type: resourceType,
        tags,
        unique_filename: true,
        overwrite: false,
      };

      if (folder) {
        uploadOptions.folder = folder;
      }

      if (publicId) {
        uploadOptions.public_id = publicId;
      }

      if (transformation) {
        uploadOptions.transformation = transformation;
      }

      const uploadStream = cloudinary.uploader.upload_stream(
        uploadOptions,
        (
          error: UploadApiErrorResponse | undefined,
          result: UploadApiResponse | undefined,
        ) => {
          if (error) {
            this.logger.error(`Buffer upload failed: ${error.message}`);
            reject(
              new BadRequestException(
                `Failed to upload media: ${error.message}`,
              ),
            );
          } else if (result) {
            this.logger.log(`Upload successful: ${result.public_id}`);
            resolve(this.mapUploadResult(result));
          } else {
            reject(new BadRequestException('Upload failed with no result'));
          }
        },
      );

      uploadStream.end(buffer);
    });
  }

  /**
   * Delete a file by public ID
   */
  async delete(
    publicId: string,
    resourceType: 'image' | 'video' | 'raw' = 'image',
  ): Promise<boolean> {
    if (!this.isConfigured) {
      throw new BadRequestException('Cloudinary is not configured');
    }

    try {
      this.logger.log(`Deleting: ${publicId}`);

      const result = await cloudinary.uploader.destroy(publicId, {
        resource_type: resourceType,
      });

      return result.result === 'ok';
    } catch (error) {
      this.logger.error(`Delete failed: ${error}`);
      throw new BadRequestException(`Failed to delete media: ${error.message}`);
    }
  }

  /**
   * The stored size of a file, from the admin API: `missing` on a 404,
   * `error` when Cloudinary is not configured, fails, or reports no size.
   */
  async getResourceBytes(
    publicId: string,
    resourceType: 'image' | 'video' | 'raw',
  ): Promise<StoredSize> {
    if (!this.isConfigured) return { kind: 'error' };
    try {
      const res = (await cloudinary.api.resource(publicId, {
        resource_type: resourceType,
      })) as { bytes?: unknown };
      return typeof res.bytes === 'number' && Number.isFinite(res.bytes)
        ? { kind: 'size', bytes: res.bytes }
        : { kind: 'error' };
    } catch (error) {
      if (httpCodeOf(error) === 404) return { kind: 'missing' };
      const apiMessage = (error as { error?: { message?: unknown } } | null)
        ?.error?.message;
      const detail =
        typeof apiMessage === 'string'
          ? apiMessage
          : error instanceof Error
            ? error.message
            : 'unknown error';
      this.logger.warn(`Could not read the size of ${publicId}: ${detail}`);
      return { kind: 'error' };
    }
  }

  /**
   * Signed parameters for a direct browser upload of exactly one asset: the
   * signature covers an explicit `public_id` and `overwrite: false`, which
   * the client sends unchanged. The location is the same in either Cloudinary
   * folder mode, and an id that is taken yields Cloudinary's existing asset
   * rather than a replacement.
   */
  generateSignedUploadParams(publicId: string): {
    signature: string;
    timestamp: number;
    cloudName: string;
    apiKey: string;
    publicId: string;
    overwrite: false;
  } {
    if (!this.isConfigured) {
      throw new BadRequestException('Cloudinary is not configured');
    }

    const timestamp = Math.round(new Date().getTime() / 1000);
    const signature = cloudinary.utils.api_sign_request(
      { timestamp, public_id: publicId, overwrite: false },
      this.configService.get<string>('CLOUDINARY_API_SECRET')!,
    );

    return {
      signature,
      timestamp,
      cloudName: this.configService.get<string>('CLOUDINARY_CLOUD_NAME')!,
      apiKey: this.configService.get<string>('CLOUDINARY_API_KEY')!,
      publicId,
      overwrite: false,
    };
  }

  /**
   * Get optimized URL for an image
   */
  getOptimizedImageUrl(
    publicId: string,
    options: {
      width?: number;
      height?: number;
      crop?: string;
      quality?: string | number;
      format?: string;
    } = {},
  ): string {
    const {
      width,
      height,
      crop = 'fill',
      quality = 'auto',
      format = 'auto',
    } = options;

    const transformations: string[] = [];

    if (width) transformations.push(`w_${width}`);
    if (height) transformations.push(`h_${height}`);
    if (crop) transformations.push(`c_${crop}`);
    transformations.push(`q_${quality}`);
    transformations.push(`f_${format}`);

    return cloudinary.url(publicId, {
      transformation: transformations.join(','),
      secure: true,
    });
  }

  /**
   * Get video thumbnail URL
   */
  getVideoThumbnailUrl(
    publicId: string,
    options: {
      width?: number;
      height?: number;
      startOffset?: string;
    } = {},
  ): string {
    const { width = 640, height = 360, startOffset = '0' } = options;

    return cloudinary.url(publicId, {
      resource_type: 'video',
      transformation: [
        { width, height, crop: 'fill' },
        { start_offset: startOffset },
      ],
      format: 'jpg',
      secure: true,
    });
  }

  /**
   * Map Cloudinary response to our UploadResult interface
   */
  private mapUploadResult(result: UploadApiResponse): UploadResult {
    const uploadResult: UploadResult = {
      publicId: result.public_id,
      url: result.url,
      secureUrl: result.secure_url,
      format: result.format,
      resourceType: result.resource_type as 'image' | 'video' | 'raw',
      bytes: result.bytes,
      existing: result.existing === true,
    };

    if (result.width) uploadResult.width = result.width;
    if (result.height) uploadResult.height = result.height;
    if (result.duration) uploadResult.duration = result.duration;
    const pages: unknown = result.pages;
    if (typeof pages === 'number') uploadResult.pages = pages;

    // Generate thumbnail for videos
    if (result.resource_type === 'video') {
      uploadResult.thumbnailUrl = this.getVideoThumbnailUrl(result.public_id);
    }

    return uploadResult;
  }
}
