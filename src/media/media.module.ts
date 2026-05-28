import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CloudinaryService } from './cloudinary.service';
import { TikTokMediaProxyService } from './tiktok-media-proxy.service';
import { BunnyCDNService } from './bunnycdn.service';
import { CloudflareR2Service } from './cloudflare-r2.service';
import { MediaController } from './media.controller';

@Module({
  imports: [ConfigModule],
  controllers: [MediaController],
  providers: [
    CloudinaryService,
    TikTokMediaProxyService,
    BunnyCDNService,
    CloudflareR2Service,
  ],
  exports: [
    CloudinaryService,
    TikTokMediaProxyService,
    BunnyCDNService,
    CloudflareR2Service,
  ],
})
export class MediaModule {}
