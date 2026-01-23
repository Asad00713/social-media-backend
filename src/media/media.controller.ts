import {
  Controller,
  Post,
  Delete,
  Body,
  Get,
  Query,
  Param,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  Header,
} from '@nestjs/common';
import type { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CloudinaryService } from './cloudinary.service';
import { TikTokMediaProxyService } from './tiktok-media-proxy.service';
import { BunnyCDNService } from './bunnycdn.service';
import {
  UploadFromUrlDto,
  UploadFromBase64Dto,
  DeleteMediaDto,
  GetOptimizedUrlDto,
  GetSignedUploadParamsDto,
} from './dto/media.dto';

@Controller('media')
export class MediaController {
  constructor(
    private readonly cloudinaryService: CloudinaryService,
    private readonly tiktokProxyService: TikTokMediaProxyService,
    private readonly bunnyCDNService: BunnyCDNService,
  ) {}

  // ==========================================================================
  // TikTok Media Proxy (for PULL_FROM_URL - domain verification)
  // These endpoints allow serving videos from YOUR domain for TikTok direct posting
  // ==========================================================================

  /**
   * Cache a video for TikTok direct posting
   * Downloads video from external URL and serves it from your domain
   */
  @Post('tiktok-proxy/cache')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async cacheVideoForTikTok(@Body('videoUrl') videoUrl: string) {
    if (!videoUrl) {
      throw new BadRequestException('videoUrl is required');
    }

    const result = await this.tiktokProxyService.cacheVideo(videoUrl);

    return {
      message: 'Video cached for TikTok posting',
      mediaId: result.mediaId,
      localUrl: result.localUrl,
      expiresAt: result.expiresAt,
      note: 'Use localUrl with TikTok PULL_FROM_URL (useDirectUpload: false). URL valid for 2 hours.',
    };
  }

  /**
   * Get TikTok proxy cache status
   * NOTE: This must come BEFORE the :mediaId route
   */
  @Get('tiktok-proxy/status')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  getTikTokProxyStatus() {
    return {
      ...this.tiktokProxyService.getCacheStats(),
      message: 'TikTok media proxy is ready. Cache videos here to use PULL_FROM_URL.',
    };
  }

  /**
   * Serve cached video for TikTok to pull
   * This endpoint is PUBLIC (no auth) so TikTok can access it
   */
  @Get('tiktok-proxy/:mediaId')
  @Header('Content-Type', 'video/mp4')
  @Header('Accept-Ranges', 'bytes')
  async serveTikTokMedia(
    @Param('mediaId') mediaId: string,
    @Res() res: Response,
  ) {
    const stats = this.tiktokProxyService.getMediaStats(mediaId);
    const stream = this.tiktokProxyService.getMediaStream(mediaId);

    res.set({
      'Content-Length': stats.size,
      'Cache-Control': 'public, max-age=3600',
    });

    stream.pipe(res);
  }

  // ==========================================================================
  // BunnyCDN Storage (for TikTok videos with verified domain)
  // Upload videos here to use TikTok's PULL_FROM_URL method
  // ==========================================================================

  /**
   * Check BunnyCDN status
   */
  @Get('bunnycdn/status')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  getBunnyCDNStatus() {
    return {
      configured: this.bunnyCDNService.isReady(),
      cdnUrl: this.bunnyCDNService.getCdnUrl(),
      message: this.bunnyCDNService.isReady()
        ? 'BunnyCDN is configured and ready for TikTok video uploads'
        : 'BunnyCDN is not configured - check environment variables',
    };
  }

  /**
   * Upload video to BunnyCDN from a URL (e.g., Cloudinary URL)
   * Returns a URL from your verified domain for TikTok PULL_FROM_URL
   */
  @Post('bunnycdn/upload-from-url')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async uploadToBunnyCDNFromUrl(
    @Body('videoUrl') videoUrl: string,
    @Body('folder') folder?: string,
    @Body('filename') filename?: string,
  ) {
    if (!videoUrl) {
      throw new BadRequestException('videoUrl is required');
    }

    const result = await this.bunnyCDNService.uploadVideoFromUrl(videoUrl, {
      folder: folder || 'tiktok-videos',
      filename,
    });

    return {
      message: 'Video uploaded to BunnyCDN successfully',
      key: result.key,
      url: result.url,
      size: result.size,
      contentType: result.contentType,
      note: 'Use this URL with TikTok PULL_FROM_URL (useDirectUpload: false)',
    };
  }

  /**
   * Upload video file directly to BunnyCDN
   */
  @Post('bunnycdn/upload-file')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: {
        fileSize: 500 * 1024 * 1024, // 500MB max for videos
      },
    }),
  )
  async uploadFileToBunnyCDN(
    @UploadedFile() file: Express.Multer.File,
    @Body('folder') folder?: string,
    @Body('filename') filename?: string,
  ) {
    if (!file) {
      throw new BadRequestException('No file provided');
    }

    const result = await this.bunnyCDNService.uploadVideoFromBuffer(file.buffer, {
      folder: folder || 'tiktok-videos',
      filename,
      contentType: file.mimetype,
    });

    return {
      message: 'Video uploaded to BunnyCDN successfully',
      originalName: file.originalname,
      key: result.key,
      url: result.url,
      size: result.size,
      contentType: result.contentType,
      note: 'Use this URL with TikTok PULL_FROM_URL (useDirectUpload: false)',
    };
  }

  /**
   * Delete a file from BunnyCDN
   * Use query param for key since it may contain slashes
   */
  @Delete('bunnycdn/file')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async deleteFromBunnyCDN(@Query('key') key: string) {
    if (!key) {
      throw new BadRequestException('key query parameter is required');
    }
    const success = await this.bunnyCDNService.deleteFile(key);

    return {
      success,
      key,
      message: success ? 'File deleted from BunnyCDN' : 'Failed to delete file',
    };
  }

  /**
   * List files in BunnyCDN folder
   */
  @Get('bunnycdn/list')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async listBunnyCDNFiles(@Query('folder') folder?: string) {
    const files = await this.bunnyCDNService.listFiles(folder || '');

    return {
      folder: folder || '/',
      files,
      cdnUrl: this.bunnyCDNService.getCdnUrl(),
    };
  }

  // ==========================================================================
  // Cloudinary Media Operations (requires auth)
  // ==========================================================================

  /**
   * Check if Cloudinary is configured
   */
  @Get('status')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  getStatus() {
    return {
      configured: this.cloudinaryService.isReady(),
      message: this.cloudinaryService.isReady()
        ? 'Cloudinary is configured and ready'
        : 'Cloudinary is not configured - check environment variables',
    };
  }

  /**
   * Upload media from a URL
   */
  @Post('upload/url')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async uploadFromUrl(@Body() dto: UploadFromUrlDto) {
    const result = await this.cloudinaryService.uploadFromUrl(dto.url, {
      folder: dto.folder,
      resourceType: dto.resourceType,
      tags: dto.tags,
      publicId: dto.publicId,
    });

    return {
      message: 'Media uploaded successfully',
      ...result,
    };
  }

  /**
   * Upload media from base64 string
   */
  @Post('upload/base64')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async uploadFromBase64(@Body() dto: UploadFromBase64Dto) {
    const result = await this.cloudinaryService.uploadFromBase64(dto.data, {
      folder: dto.folder,
      resourceType: dto.resourceType,
      tags: dto.tags,
      publicId: dto.publicId,
    });

    return {
      message: 'Media uploaded successfully',
      ...result,
    };
  }

  /**
   * Upload media from file (multipart form data)
   */
  @Post('upload/file')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: {
        fileSize: 100 * 1024 * 1024, // 100MB max
      },
    }),
  )
  async uploadFile(
    @UploadedFile() file: Express.Multer.File,
    @Body('folder') folder?: string,
    @Body('resourceType') resourceType?: 'image' | 'video' | 'auto' | 'raw',
    @Body('tags') tags?: string,
  ) {
    if (!file) {
      throw new BadRequestException('No file provided');
    }

    const parsedTags = tags ? tags.split(',').map((t) => t.trim()) : [];

    const result = await this.cloudinaryService.uploadFromBuffer(file.buffer, {
      folder,
      resourceType: resourceType || 'auto',
      tags: parsedTags,
    });

    return {
      message: 'Media uploaded successfully',
      originalName: file.originalname,
      mimeType: file.mimetype,
      ...result,
    };
  }

  /**
   * Delete media by public ID
   */
  @Delete()
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async deleteMedia(@Body() dto: DeleteMediaDto) {
    const success = await this.cloudinaryService.delete(
      dto.publicId,
      dto.resourceType || 'image',
    );

    return {
      success,
      message: success ? 'Media deleted successfully' : 'Failed to delete media',
    };
  }

  /**
   * Get optimized image URL
   */
  @Get('optimize')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  getOptimizedUrl(@Query() query: GetOptimizedUrlDto) {
    const url = this.cloudinaryService.getOptimizedImageUrl(query.publicId, {
      width: query.width,
      height: query.height,
      crop: query.crop,
      quality: query.quality,
      format: query.format,
    });

    return {
      url,
      publicId: query.publicId,
    };
  }

  /**
   * Get video thumbnail URL
   */
  @Get('video-thumbnail')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  getVideoThumbnail(
    @Query('publicId') publicId: string,
    @Query('width') width?: number,
    @Query('height') height?: number,
    @Query('startOffset') startOffset?: string,
  ) {
    if (!publicId) {
      throw new BadRequestException('publicId is required');
    }

    const url = this.cloudinaryService.getVideoThumbnailUrl(publicId, {
      width: width ? Number(width) : undefined,
      height: height ? Number(height) : undefined,
      startOffset,
    });

    return {
      url,
      publicId,
    };
  }

  /**
   * Get signed upload parameters for direct client-side uploads
   * This allows the frontend to upload directly to Cloudinary
   */
  @Post('signed-upload-params')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  getSignedUploadParams(@Body() dto: GetSignedUploadParamsDto) {
    const params = this.cloudinaryService.generateSignedUploadParams({
      folder: dto.folder,
    });

    return {
      ...params,
      uploadUrl: `https://api.cloudinary.com/v1_1/${params.cloudName}/auto/upload`,
    };
  }
}
