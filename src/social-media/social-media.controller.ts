import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SuperAdminGuard } from '../auth/guards/super-admin.guard';
import { FacebookService } from './services/facebook.service';

@Controller('social-media')
export class SocialMediaController {
  constructor(private readonly facebookService: FacebookService) {}

  @Post('facebook')
  @UseGuards(JwtAuthGuard, SuperAdminGuard)
  async postToFacebook(@Body() body: { message: string; imageUrl?: string }) {
    return await this.facebookService.postToPage(body.message, body.imageUrl);
  }
}
