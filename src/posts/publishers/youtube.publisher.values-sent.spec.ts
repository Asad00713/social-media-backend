import {
  YOUTUBE_DEFAULT_PRIVACY,
  YouTubePublisher,
  youtubeDescription,
  youtubePrivacyStatus,
} from './youtube.publisher';
import { YouTubeService } from '../../channels/services/youtube.service';
import { YoutubeAuditGateService } from '../../channels/services/youtube-audit-gate.service';
import { PublishOptions } from './base.publisher';

/**
 * What the composer shows is what YouTube receives.
 *
 * The YouTube card has no caption - it draws a title and a Description -
 * and its Visibility row reads Public until someone changes it. The
 * publisher used to send the shared caption as the description (ignoring
 * the typed one) and to default the visibility to Private.
 */
describe('YouTubePublisher - values sent match the composer', () => {
  let upload: jest.Mock;
  let publisher: YouTubePublisher;

  const options = (
    metadata: Record<string, unknown>,
    content = 'The shared caption, written for Instagram',
  ): PublishOptions =>
    ({
      content,
      mediaItems: [{ type: 'video', url: 'https://x/v.mp4' }],
      accessToken: 'tok',
      platformAccountId: 'acc',
      channelMetadata: {},
      channelId: 9,
      metadata: { title: 'A title', madeForKids: false, ...metadata },
    }) as unknown as PublishOptions;

  const sent = (call = 0) => upload.mock.calls[call][2];

  beforeEach(() => {
    upload = jest
      .fn()
      .mockResolvedValue({ videoId: 'v1', videoUrl: 'https://youtu.be/v1' });
    publisher = new YouTubePublisher(
      { uploadVideoFromUrl: upload } as unknown as YouTubeService,
      {
        reserveUpload: jest.fn().mockResolvedValue(undefined),
      } as unknown as YoutubeAuditGateService,
    );
  });

  describe('description (Y1)', () => {
    it('sends the description typed on the YouTube card, not the shared caption', async () => {
      await publisher.publish(options({ description: 'Typed for YouTube' }));
      expect(sent().description).toBe('Typed for YouTube');
    });

    it('sends no description when the card has none - never the hidden caption', async () => {
      await publisher.publish(options({}));
      expect(sent().description).toBe('');
      await publisher.publish(options({ description: '' }));
      expect(sent(1).description).toBe('');
    });

    it('measures the 5000 limit on the description, not the caption', () => {
      const long = 'x'.repeat(6000);
      // A long shared caption is not this channel's text: no error.
      expect(() =>
        publisher.validate(options({ description: 'short' }, long)),
      ).not.toThrow();
      expect(() =>
        publisher.validate(options({ description: long }, 'short')),
      ).toThrow(/5000/);
    });

    it('a Short gets #Shorts on its own description, not on the caption', async () => {
      await publisher.publish(options({ description: 'Mine', isShort: true }));
      expect(sent().description).toMatch(/^Mine[\s\S]*#Shorts/);
      expect(sent().description).not.toContain('shared caption');
    });

    it('youtubeDescription ignores anything that is not a string', () => {
      expect(youtubeDescription(undefined)).toBe('');
      expect(youtubeDescription({ description: 42 })).toBe('');
      expect(youtubeDescription({ description: ' a ' })).toBe(' a ');
    });
  });

  describe('visibility (Y2)', () => {
    it('defaults to Public, the value the Visibility row shows untouched', async () => {
      expect(YOUTUBE_DEFAULT_PRIVACY).toBe('public');
      await publisher.publish(options({}));
      expect(sent().privacyStatus).toBe('public');
    });

    it.each(['public', 'unlisted', 'private'])(
      'sends a chosen %s as is',
      async (v) => {
        await publisher.publish(options({ privacyStatus: v }));
        expect(sent().privacyStatus).toBe(v);
      },
    );

    it('an unknown value falls back to the shared default', () => {
      expect(youtubePrivacyStatus('PUBLIC')).toBe('public');
      expect(youtubePrivacyStatus(undefined)).toBe('public');
      expect(youtubePrivacyStatus('private')).toBe('private');
    });
  });
});
