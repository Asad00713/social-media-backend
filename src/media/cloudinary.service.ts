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
}

export interface UploadOptions {
  folder?: string;
  resourceType?: 'image' | 'video' | 'auto' | 'raw';
  transformation?: Record<string, any>;
  tags?: string[];
  publicId?: string;
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
      folder = 'social-media',
      resourceType = 'auto',
      transformation,
      tags = [],
      publicId,
    } = options;

    try {
      this.logger.log(`Uploading from URL: ${url}`);

      const uploadOptions: Record<string, any> = {
        folder,
        resource_type: resourceType,
        tags,
        unique_filename: true,
        overwrite: false,
      };

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
      folder = 'social-media',
      resourceType = 'auto',
      transformation,
      tags = [],
      publicId,
    } = options;

    try {
      // Ensure base64 has proper data URI prefix
      let dataUri = base64Data;
      if (!base64Data.startsWith('data:')) {
        // Try to detect the type from the base64 header
        dataUri = `data:application/octet-stream;base64,${base64Data}`;
      }

      this.logger.log('Uploading from base64 data');

      const uploadOptions: Record<string, any> = {
        folder,
        resource_type: resourceType,
        tags,
        unique_filename: true,
        overwrite: false,
      };

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
      folder = 'social-media',
      resourceType = 'auto',
      transformation,
      tags = [],
      publicId,
    } = options;

    return new Promise((resolve, reject) => {
      const uploadOptions: Record<string, any> = {
        folder,
        resource_type: resourceType,
        tags,
        unique_filename: true,
        overwrite: false,
      };

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
   * The stored size of a file, from the admin API. `null` when Cloudinary is
   * not configured, the file is not there, or the call fails for any reason:
   * the caller decides what an unknown size means.
   */
  async getResourceBytes(
    publicId: string,
    resourceType: 'image' | 'video' | 'raw',
  ): Promise<number | null> {
    if (!this.isConfigured) return null;
    try {
      const res = (await cloudinary.api.resource(publicId, {
        resource_type: resourceType,
      })) as { bytes?: unknown };
      return typeof res.bytes === 'number' && Number.isFinite(res.bytes)
        ? res.bytes
        : null;
    } catch (error) {
      this.logger.warn(
        `Could not read the size of ${publicId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  /**
   * Generate a signed upload URL for direct client-side uploads
   */
  generateSignedUploadParams(options: UploadOptions = {}): {
    signature: string;
    timestamp: number;
    cloudName: string;
    apiKey: string;
    folder: string;
  } {
    if (!this.isConfigured) {
      throw new BadRequestException('Cloudinary is not configured');
    }

    const timestamp = Math.round(new Date().getTime() / 1000);
    const folder = options.folder || 'social-media';

    const paramsToSign = {
      timestamp,
      folder,
    };

    const signature = cloudinary.utils.api_sign_request(
      paramsToSign,
      this.configService.get<string>('CLOUDINARY_API_SECRET')!,
    );

    return {
      signature,
      timestamp,
      cloudName: this.configService.get<string>('CLOUDINARY_CLOUD_NAME')!,
      apiKey: this.configService.get<string>('CLOUDINARY_API_KEY')!,
      folder,
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
