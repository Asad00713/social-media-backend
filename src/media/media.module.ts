import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { WorkspaceRoleModule } from '../workspace-members/workspace-role.module';
import { CloudinaryService } from './cloudinary.service';
import { TikTokMediaProxyService } from './tiktok-media-proxy.service';
import { BunnyCDNService } from './bunnycdn.service';
import { CloudflareR2Service } from './cloudflare-r2.service';
import { MediaController } from './media.controller';
import { TikTokMediaProxyController } from './tiktok-media-proxy.controller';

@Module({
  imports: [ConfigModule, JwtModule.register({}), WorkspaceRoleModule],
  controllers: [MediaController, TikTokMediaProxyController],
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
