import { PublisherFactory } from './publisher.factory';
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
import { SupportedPlatform } from '../../drizzle/schema/channels.schema';

/**
 * Builds a stand-in publisher instance for a given platform without going
 * through Nest DI — the factory only reads `.platform` off each injected
 * publisher, so a minimal object satisfies its constructor contract.
 */
function stubPublisher(platform: SupportedPlatform): any {
  return { platform };
}

describe('PublisherFactory', () => {
  function buildFactory(): PublisherFactory {
    return new PublisherFactory(
      stubPublisher('twitter') as TwitterPublisher,
      stubPublisher('facebook') as FacebookPublisher,
      stubPublisher('instagram') as InstagramPublisher,
      stubPublisher('threads') as ThreadsPublisher,
      stubPublisher('linkedin') as LinkedInPublisher,
      stubPublisher('pinterest') as PinterestPublisher,
      stubPublisher('tiktok') as TikTokPublisher,
      stubPublisher('youtube') as YouTubePublisher,
      stubPublisher('bluesky') as BlueskyPublisher,
      stubPublisher('mastodon') as MastodonPublisher,
      stubPublisher('reddit') as RedditPublisher,
      stubPublisher('slack') as SlackPublisher,
      stubPublisher('discord') as DiscordPublisher,
    );
  }

  it('resolves the slack publisher without throwing', () => {
    const factory = buildFactory();
    const publisher = factory.getPublisher('slack');
    expect(publisher).toBeDefined();
    expect(publisher.platform).toBe('slack');
  });

  it('resolves the discord publisher without throwing', () => {
    const factory = buildFactory();
    const publisher = factory.getPublisher('discord');
    expect(publisher).toBeDefined();
    expect(publisher.platform).toBe('discord');
  });

  it('still resolves a pre-existing platform (reddit) alongside the new ones', () => {
    const factory = buildFactory();
    const publisher = factory.getPublisher('reddit');
    expect(publisher.platform).toBe('reddit');
  });

  it('includes slack and discord in getSupportedPlatforms', () => {
    const factory = buildFactory();
    const platforms = factory.getSupportedPlatforms();
    expect(platforms).toContain('slack');
    expect(platforms).toContain('discord');
  });
});
