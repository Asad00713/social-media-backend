import { Controller, Post, Body } from '@nestjs/common';
import { FacebookService } from './services/facebook.service';

@Controller('social-media')
export class SocialMediaController {
    constructor(private readonly facebookService: FacebookService) { }

    @Post('facebook')
    async postToFacebook(@Body() body: { message: string; imageUrl?: string }) {
        return await this.facebookService.postToPage(body.message, body.imageUrl);
    }
}