import { Injectable, BadRequestException } from '@nestjs/common';
import { SupportedPlatform } from '../../drizzle/schema/channels.schema';
import { BaseCommunityProvider } from './base-community.provider';
import { TwitterCommunityProvider } from './twitter-community.provider';
import { ThreadsCommunityProvider } from './threads-community.provider';

@Injectable()
export class CommunityProviderFactory {
  private readonly providers: Map<SupportedPlatform, BaseCommunityProvider>;

  constructor(
    private readonly twitterCommunityProvider: TwitterCommunityProvider,
    private readonly threadsCommunityProvider: ThreadsCommunityProvider,
  ) {
    this.providers = new Map<SupportedPlatform, BaseCommunityProvider>();
    this.providers.set('twitter', this.twitterCommunityProvider);
    this.providers.set('threads', this.threadsCommunityProvider);
  }

  getProvider(platform: SupportedPlatform): BaseCommunityProvider {
    const provider = this.providers.get(platform);
    if (!provider) {
      throw new BadRequestException(
        `Community features are not yet supported for ${platform}`,
      );
    }
    return provider;
  }

  getSupportedPlatforms(): SupportedPlatform[] {
    return Array.from(this.providers.keys());
  }
}
