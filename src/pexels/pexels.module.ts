import { Module } from '@nestjs/common';
import { PexelsController } from './pexels.controller';
import { PexelsService } from './pexels.service';

@Module({
  controllers: [PexelsController],
  providers: [PexelsService],
  exports: [PexelsService],
})
export class PexelsModule {}
