import {
  Controller,
  Get,
  Query,
  Param,
  ParseIntPipe,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { PexelsService } from './pexels.service';
import {
  SearchPhotosDto,
  SearchVideosDto,
  GetCuratedPhotosDto,
  GetPopularVideosDto,
} from './dto/pexels.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@Controller('pexels')
@UseGuards(JwtAuthGuard)
export class PexelsController {
  constructor(private readonly pexelsService: PexelsService) {}

  // ==========================================================================
  // Photo Endpoints
  // ==========================================================================

  /**
   * Search for photos
   * GET /pexels/photos/search?query=nature&orientation=landscape&page=1&perPage=15
   */
  @Get('photos/search')
  @HttpCode(HttpStatus.OK)
  async searchPhotos(@Query() dto: SearchPhotosDto) {
    return this.pexelsService.searchPhotos({
      query: dto.query,
      orientation: dto.orientation,
      size: dto.size,
      color: dto.color,
      locale: dto.locale,
      page: dto.page,
      perPage: dto.perPage,
    });
  }

  /**
   * Get curated/featured photos
   * GET /pexels/photos/curated?page=1&perPage=15
   */
  @Get('photos/curated')
  @HttpCode(HttpStatus.OK)
  async getCuratedPhotos(@Query() dto: GetCuratedPhotosDto) {
    return this.pexelsService.getCuratedPhotos(dto.page, dto.perPage);
  }

  /**
   * Get a specific photo by ID
   * GET /pexels/photos/:id
   */
  @Get('photos/:id')
  @HttpCode(HttpStatus.OK)
  async getPhoto(@Param('id', ParseIntPipe) id: number) {
    return this.pexelsService.getPhoto(id);
  }

  // ==========================================================================
  // Video Endpoints
  // ==========================================================================

  /**
   * Search for videos
   * GET /pexels/videos/search?query=ocean&orientation=landscape&page=1&perPage=15
   */
  @Get('videos/search')
  @HttpCode(HttpStatus.OK)
  async searchVideos(@Query() dto: SearchVideosDto) {
    return this.pexelsService.searchVideos({
      query: dto.query,
      orientation: dto.orientation,
      size: dto.size,
      locale: dto.locale,
      page: dto.page,
      perPage: dto.perPage,
    });
  }

  /**
   * Get popular videos
   * GET /pexels/videos/popular?page=1&perPage=15&minDuration=5&maxDuration=60
   */
  @Get('videos/popular')
  @HttpCode(HttpStatus.OK)
  async getPopularVideos(@Query() dto: GetPopularVideosDto) {
    return this.pexelsService.getPopularVideos(
      dto.page,
      dto.perPage,
      dto.minWidth,
      dto.minHeight,
      dto.minDuration,
      dto.maxDuration,
    );
  }

  /**
   * Get a specific video by ID
   * GET /pexels/videos/:id
   */
  @Get('videos/:id')
  @HttpCode(HttpStatus.OK)
  async getVideo(@Param('id', ParseIntPipe) id: number) {
    return this.pexelsService.getVideo(id);
  }
}
