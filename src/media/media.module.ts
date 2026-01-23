import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CloudinaryService } from './cloudinary.service';
import { TikTokMediaProxyService } from './tiktok-media-proxy.service';
import { BunnyCDNService } from './bunnycdn.service';
import { MediaController } from './media.controller';

@Module({
  imports: [ConfigModule],
  controllers: [MediaController],
  providers: [CloudinaryService, TikTokMediaProxyService, BunnyCDNService],
  exports: [CloudinaryService, TikTokMediaProxyService, BunnyCDNService],
})
export class MediaModule {}
