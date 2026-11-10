import { PayloadResolverService } from './payload-resolver.service';
import type { Draft, ChannelTarget } from '../types/draft.types';

describe('PayloadResolverService', () => {
  let service: PayloadResolverService;

  const baseDraft: Draft = {
    id: 'd-1',
    workspaceId: 'ws-1',
    createdById: 'u-1',
    status: 'draft',
    base: {
      text: 'hello world',
      mediaItems: [],
      hashtags: ['ai', 'tech'],
      mentions: [],
    },
    perPlatform: {},
    channels: [],
    schedule: { mode: 'now' },
    createdAt: '2026-05-17T00:00:00Z',
    updatedAt: '2026-05-17T00:00:00Z',
  };

  const twitterChannel: ChannelTarget = {
    channelId: '53',
    platform: 'twitter',
    publishStatus: 'queued',
    retryCount: 0,
  };

  beforeEach(() => {
    service = new PayloadResolverService();
  });

  it('inherits base.text when no override', () => {
    const payload = service.resolve(baseDraft, twitterChannel);
    expect(payload.text).toBe('hello world');
    expect(payload.hashtags).toEqual(['ai', 'tech']);
  });

  it('uses platform override when present', () => {
    const draft: Draft = {
      ...baseDraft,
      perPlatform: {
        twitter: {
          inheritsFromBase: true,
          overrides: { text: 'twitter-specific text' },
          platformSpecific: {},
        },
      },
    };
    const payload = service.resolve(draft, twitterChannel);
    expect(payload.text).toBe('twitter-specific text');
    expect(payload.hashtags).toEqual(['ai', 'tech']);
  });

  it('inherits all fields when overrides empty', () => {
    const draft: Draft = {
      ...baseDraft,
      perPlatform: {
        twitter: {
          inheritsFromBase: true,
          overrides: {},
          platformSpecific: {},
        },
      },
    };
    const payload = service.resolve(draft, twitterChannel);
    expect(payload.text).toBe('hello world');
  });

  it('does not affect other platforms when one is overridden', () => {
    const draft: Draft = {
      ...baseDraft,
      perPlatform: {
        twitter: {
          inheritsFromBase: true,
          overrides: { text: 'tw only' },
          platformSpecific: {},
        },
      },
    };
    const igChannel: ChannelTarget = {
      channelId: '49',
      platform: 'instagram',
      publishStatus: 'queued',
      retryCount: 0,
    };
    const payload = service.resolve(draft, igChannel);
    expect(payload.text).toBe('hello world');
  });

  it('exposes platformSpecific via the channel platform key', () => {
    const draft: Draft = {
      ...baseDraft,
      perPlatform: {
        youtube: {
          inheritsFromBase: true,
          overrides: {},
          platformSpecific: {
            title: 'My Video',
            privacyStatus: 'public',
          } as any,
        },
      },
    };
    const ytChannel: ChannelTarget = {
      channelId: '54',
      platform: 'youtube',
      publishStatus: 'queued',
      retryCount: 0,
    };
    const payload = service.resolve(draft, ytChannel);
    expect(payload.platformSpecific).toEqual({
      title: 'My Video',
      privacyStatus: 'public',
    });
  });

  it('uses channel scheduleAt when set', () => {
    const channel: ChannelTarget = {
      ...twitterChannel,
      scheduleAt: '2026-05-18T09:00:00Z',
    };
    const payload = service.resolve(baseDraft, channel);
    expect(payload.scheduleAt).toBe('2026-05-18T09:00:00Z');
  });

  describe('YouTube’s designed thumbnail, shared', () => {
    const PICTURE = 'https://cdn.example/thumb.jpg';
    const channel = (platform: ChannelTarget['platform']): ChannelTarget => ({
      channelId: platform,
      platform,
      publishStatus: 'queued',
      retryCount: 0,
    });
    const draft = (channels: ChannelTarget[]): Draft => ({
      ...baseDraft,
      channels,
      perPlatform: {
        youtube: {
          inheritsFromBase: true,
          overrides: {},
          platformSpecific: { thumbnailUrl: PICTURE } as any,
        },
        facebook: {
          inheritsFromBase: true,
          overrides: {},
          platformSpecific: { postType: 'post' } as any,
        },
      },
    });

    it('reaches Facebook and LinkedIn as `sharedThumbnailUrl`', () => {
      const all = [channel('youtube'), channel('facebook'), channel('linkedin')];
      expect(
        service.resolve(draft(all), channel('facebook')).platformSpecific,
      ).toEqual({ postType: 'post', sharedThumbnailUrl: PICTURE });
      expect(
        service.resolve(draft(all), channel('linkedin')).platformSpecific,
      ).toEqual({ sharedThumbnailUrl: PICTURE });
    });

    it('leaves YouTube’s own fields as they are', () => {
      const all = [channel('youtube'), channel('facebook')];
      expect(
        service.resolve(draft(all), channel('youtube')).platformSpecific,
      ).toEqual({ thumbnailUrl: PICTURE });
    });

    it('is not sent when YouTube is not one of the post’s channels', () => {
      expect(
        service.resolve(draft([channel('facebook')]), channel('facebook'))
          .platformSpecific,
      ).toEqual({ postType: 'post' });
    });
  });
});
