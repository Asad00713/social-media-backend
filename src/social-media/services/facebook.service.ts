import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

@Injectable()
export class FacebookService {
    private readonly pageId: string;
    private readonly accessToken: string;

    constructor(private configService: ConfigService) {
        this.pageId = this.configService.get<string>('FB_PAGE_ID')!;
        this.accessToken = this.configService.get<string>('FB_ACCESS_TOKEN')!;
    }

    async postToPage(message: string, imageUrl?: string) {
        try {
            let url: string;
            let data: any;

            if (imageUrl) {
                url = `https://graph.facebook.com/v18.0/${this.pageId}/photos`;
                data = {
                    message: message,
                    url: imageUrl,
                    access_token: this.accessToken,
                };
            } else {
                url = `https://graph.facebook.com/v18.0/${this.pageId}/feed`;
                data = {
                    message: message,
                    access_token: this.accessToken,
                };
            }

            const response = await axios.post(url, data);

            return {
                success: true,
                postId: response.data.id,
                message: 'Post published successfully to Facebook',
            };
        } catch (error) {
            console.error('Facebook API Error:', error.response?.data || error.message);
            throw new Error(`Failed to post to Facebook: ${error.response?.data?.error?.message || error.message}`);
        }
    }
}