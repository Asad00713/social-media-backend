import { Module } from '@nestjs/common';
import { UnsplashService } from '../channels/services/unsplash.service';
import { PexelsService } from '../pexels/pexels.service';
import { StockMediaService } from './stock-media.service';

@Module({
  providers: [StockMediaService, UnsplashService, PexelsService],
  exports: [StockMediaService],
})
export class StockMediaModule {}
