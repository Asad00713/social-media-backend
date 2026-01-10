import { Module } from '@nestjs/common';
import { SocialMediaController } from './social-media.controller';
import { FacebookService } from './services/facebook.service';

@Module({
  controllers: [SocialMediaController],
  providers: [FacebookService],
  exports: [FacebookService],
})
export class SocialMediaModule { }