import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CloudinaryService } from './cloudinary.service';
import { MediaController } from './media.controller';

@Module({
  imports: [ConfigModule],
  controllers: [MediaController],
  providers: [CloudinaryService],
  exports: [CloudinaryService],
})
export class MediaModule {}
