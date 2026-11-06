import { FacebookPublisher, reelCaptions } from './facebook.publisher';
import { FacebookService } from '../../channels/services/facebook.service';
import { PublishOptions } from './base.publisher';

/**
 * The composer writes `captionsSrt` and `captionsLocale` into Facebook's
 * `platformSpecific`, which reaches this publisher as `metadata` VERBATIM.
 * These pin the names and that the text reaches the service; the service
 * spec pins the request.
 */
describe('FacebookPublisher - Reel captions', () => {
  let publisher: FacebookPublisher;
  let service: jest.Mocked<Pick<FacebookService, 'postReelToPage'>>;

  const SRT = '1\n00:00:00,500 --> 00:00:02,000\nMorning!\n';

  const options = (metadata: Record<string, unknown>): PublishOptions =>
    ({
      content: 'a caption',
      mediaItems: [{ type: 'video', url: 'https://cdn.example/v.mp4' } as any],
      accessToken: 'page-token',
      metadata,
      channelMetadata: {},
      platformAccountId: 'page-1',
      channelId: 1,
    }) as PublishOptions;

  beforeEach(() => {
    service = {
      postReelToPage: jest.fn().mockResolvedValue({ postId: 'reel-1' }),
    } as any;
    publisher = new FacebookPublisher(service as unknown as FacebookService);
  });

  const sentOptions = () => service.postReelToPage.mock.calls[0][4];

  it('hands the draft’s SubRip text and locale to the Reel', async () => {
    await publisher.publish(
      options({ postType: 'reel', captionsSrt: SRT, captionsLocale: 'ur_PK' }),
    );
    expect(sentOptions()).toEqual({ captions: { srt: SRT, locale: 'ur_PK' } });
  });

  it('sends no captions key when the draft has none', async () => {
    await publisher.publish(options({ postType: 'reel' }));
    expect(sentOptions()).toEqual({});
  });

  it('reads only its own key names', async () => {
    await publisher.publish(
      options({ postType: 'reel', captions: SRT, srt: SRT }),
    );
    expect(sentOptions()).toEqual({});
  });

  it('puts a refusal on the result as a warning, not a failure', async () => {
    service.postReelToPage.mockResolvedValue({
      postId: 'reel-1',
      captionsWarning: 'Facebook rejected the captions: nope',
    } as any);
    const result = await publisher.publish(
      options({ postType: 'reel', captionsSrt: SRT }),
    );
    expect(result.platformPostId).toBe('reel-1');
    expect(result.metadata?.captionsWarning).toBe(
      'Facebook rejected the captions: nope',
    );
  });

  it('adds no warning key when the captions were set', async () => {
    const result = await publisher.publish(
      options({ postType: 'reel', captionsSrt: SRT }),
    );
    expect(result.metadata?.captionsWarning).toBeUndefined();
    expect(result.metadata && 'captionsWarning' in result.metadata).toBeFalsy();
  });

  it('does not send captions on a Story or a Post', async () => {
    const story = {
      postVideoStoryToPage: jest.fn().mockResolvedValue({ postId: 's-1' }),
      postToPage: jest.fn().mockResolvedValue({ postId: 'p-1' }),
      postReelToPage: service.postReelToPage,
    };
    const p = new FacebookPublisher(story as unknown as FacebookService);
    await p.publish(options({ postType: 'story', captionsSrt: SRT }));
    expect(service.postReelToPage).not.toHaveBeenCalled();
  });
});

describe('reelCaptions', () => {
  it('is undefined for missing, empty or non-string text', () => {
    expect(reelCaptions(undefined)).toBeUndefined();
    expect(reelCaptions({})).toBeUndefined();
    expect(reelCaptions({ captionsSrt: '   ' })).toBeUndefined();
    expect(reelCaptions({ captionsSrt: 42 })).toBeUndefined();
  });

  it('keeps a Facebook-shaped locale', () => {
    expect(reelCaptions({ captionsSrt: 'x', captionsLocale: 'fr_FR' })).toEqual(
      {
        srt: 'x',
        locale: 'fr_FR',
      },
    );
  });

  it('falls back to en_US for a missing or malformed locale', () => {
    expect(reelCaptions({ captionsSrt: 'x' })?.locale).toBe('en_US');
    expect(
      reelCaptions({ captionsSrt: 'x', captionsLocale: 'eng' })?.locale,
    ).toBe('en_US');
    expect(
      reelCaptions({ captionsSrt: 'x', captionsLocale: 'en_US.srt' })?.locale,
    ).toBe('en_US');
  });
});
