import {
  Controller,
  Post,
  Delete,
  Body,
  Get,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CloudinaryService } from './cloudinary.service';
import {
  UploadFromUrlDto,
  UploadFromBase64Dto,
  DeleteMediaDto,
  GetOptimizedUrlDto,
  GetSignedUploadParamsDto,
} from './dto/media.dto';

@Controller('media')
@UseGuards(JwtAuthGuard)
export class MediaController {
  constructor(private readonly cloudinaryService: CloudinaryService) {}

  /**
   * Check if Cloudinary is configured
   */
  @Get('status')
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
