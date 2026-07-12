import { Module } from '@nestjs/common';
import { UnsplashService } from '../channels/services/unsplash.service';
import { PexelsService } from '../pexels/pexels.service';
import { PixabayService } from './providers/pixabay.service';
import { GiphyService } from './providers/giphy.service';
import { CoverrService } from './providers/coverr.service';
import { FlickrService } from './providers/flickr.service';
import { StockMediaController } from './stock-media.controller';
import { StockMediaService } from './stock-media.service';

@Module({
  controllers: [StockMediaController],
  providers: [
    StockMediaService,
    UnsplashService,
    PexelsService,
    PixabayService,
    GiphyService,
    CoverrService,
    FlickrService,
  ],
  exports: [StockMediaService],
})
export class StockMediaModule {}
