import { Injectable } from '@nestjs/common';
import { SupportedPlatform } from '../../drizzle/schema/channels.schema';
import { BasePublisher } from './base.publisher';
import { TwitterPublisher } from './twitter.publisher';
import { FacebookPublisher } from './facebook.publisher';
import { InstagramPublisher } from './instagram.publisher';
import { ThreadsPublisher } from './threads.publisher';
import { LinkedInPublisher } from './linkedin.publisher';
import { PinterestPublisher } from './pinterest.publisher';
import { TikTokPublisher } from './tiktok.publisher';
import { YouTubePublisher } from './youtube.publisher';
import { BlueskyPublisher } from './bluesky.publisher';
import { MastodonPublisher } from './mastodon.publisher';
import { RedditPublisher } from './reddit.publisher';
import { SlackPublisher } from './slack.publisher';
import { DiscordPublisher } from './discord.publisher';

@Injectable()
export class PublisherFactory {
  private readonly publishers: Map<SupportedPlatform, BasePublisher>;

  constructor(
    private readonly twitterPublisher: TwitterPublisher,
    private readonly facebookPublisher: FacebookPublisher,
    private readonly instagramPublisher: InstagramPublisher,
    private readonly threadsPublisher: ThreadsPublisher,
    private readonly linkedinPublisher: LinkedInPublisher,
    private readonly pinterestPublisher: PinterestPublisher,
    private readonly tiktokPublisher: TikTokPublisher,
    private readonly youtubePublisher: YouTubePublisher,
    private readonly blueskyPublisher: BlueskyPublisher,
    private readonly mastodonPublisher: MastodonPublisher,
    private readonly redditPublisher: RedditPublisher,
    private readonly slackPublisher: SlackPublisher,
    private readonly discordPublisher: DiscordPublisher,
  ) {
    this.publishers = new Map<SupportedPlatform, BasePublisher>();
    this.publishers.set('twitter', this.twitterPublisher);
    this.publishers.set('facebook', this.facebookPublisher);
    this.publishers.set('instagram', this.instagramPublisher);
    this.publishers.set('threads', this.threadsPublisher);
    this.publishers.set('linkedin', this.linkedinPublisher);
    this.publishers.set('pinterest', this.pinterestPublisher);
    this.publishers.set('tiktok', this.tiktokPublisher);
    this.publishers.set('youtube', this.youtubePublisher);
    this.publishers.set('bluesky', this.blueskyPublisher);
    this.publishers.set('mastodon', this.mastodonPublisher);
    this.publishers.set('reddit', this.redditPublisher);
    this.publishers.set('slack', this.slackPublisher);
    this.publishers.set('discord', this.discordPublisher);
  }

  getPublisher(platform: SupportedPlatform): BasePublisher {
    const publisher = this.publishers.get(platform);
    if (!publisher) {
      throw new Error(`No publisher found for platform: ${platform}`);
    }
    return publisher;
  }

  getSupportedPlatforms(): SupportedPlatform[] {
    return Array.from(this.publishers.keys());
  }
}
