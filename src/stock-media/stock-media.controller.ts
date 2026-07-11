import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SearchStockDto } from './dto/search-stock.dto';
import { TrackDownloadDto } from './dto/track-download.dto';
import { StockMediaService } from './stock-media.service';
import type { StockSearchResponse } from './stock-media.types';

const DEFAULT_PER_PAGE = 24;

@Controller('media/stock')
@UseGuards(JwtAuthGuard)
export class StockMediaController {
  constructor(private readonly stockMedia: StockMediaService) {}

  @Get('search')
  search(@Query() dto: SearchStockDto): Promise<StockSearchResponse> {
    return this.stockMedia.search({
      provider: dto.provider,
      type: dto.type,
      q: dto.q,
      page: dto.page ?? 1,
      perPage: dto.perPage ?? DEFAULT_PER_PAGE,
    });
  }

  @Post('track')
  @HttpCode(204)
  track(@Body() dto: TrackDownloadDto): Promise<void> {
    return this.stockMedia.track(dto.downloadTriggerUrl);
  }
}
