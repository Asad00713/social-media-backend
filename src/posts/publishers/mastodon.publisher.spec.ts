import { MastodonPublisher } from './mastodon.publisher';
import { MastodonService } from '../../channels/services/mastodon.service';
import { PublishOptions } from './base.publisher';

/**
 * The composer saves a photo's focal point on the media item
 * (`DraftMediaItem.focalPoint`, fractions from the top left). Mastodon takes it
 * as `focus` on the media upload, so the publisher has to read it off each item
 * and hand it to `uploadMedia` — beside, and not instead of, the alt text.
 */
describe('MastodonPublisher focal point', () => {
  let publisher: MastodonPublisher;
  let service: jest.Mocked<
    Pick<MastodonService, 'uploadMedia' | 'createStatus'>
  >;

  const options = (
    mediaItems: Array<Record<string, unknown>>,
    metadata: Record<string, unknown> = {},
  ): PublishOptions =>
    ({
      content: 'hello',
      mediaItems,
      accessToken: 'tok',
      metadata,
      channelMetadata: { instanceUrl: 'mastodon.example' },
      platformAccountId: 'acc-1',
      channelId: 1,
    }) as unknown as PublishOptions;

  const photo = (extra: Record<string, unknown> = {}) => ({
    type: 'image',
    url: 'https://cdn.example/a.jpg',
    altText: 'a sunset',
    ...extra,
  });

  beforeEach(() => {
    let n = 0;
    service = {
      uploadMedia: jest
        .fn()
        .mockImplementation(() => Promise.resolve({ id: `m${++n}` })),
      createStatus: jest
        .fn()
        .mockResolvedValue({ id: 's1', url: 'https://m/s1' }),
    } as unknown as typeof service;
    publisher = new MastodonPublisher(service as unknown as MastodonService);
  });

  it("hands the focal point to the upload as Mastodon's focus, with the alt text", async () => {
    await publisher.publish(
      options([photo({ focalPoint: { x: 0.2, y: 0.8 } })]),
    );

    expect(service.uploadMedia).toHaveBeenCalledTimes(1);
    // (instanceUrl, token, url, description, contentTypeOverride, focus)
    expect(service.uploadMedia).toHaveBeenCalledWith(
      'mastodon.example',
      'tok',
      'https://cdn.example/a.jpg',
      'a sunset',
      undefined,
      '-0.6,-0.6',
    );
  });

  it('sends no focus for a photo with no focal point', async () => {
    await publisher.publish(options([photo()]));

    const args = service.uploadMedia.mock.calls[0];
    expect(args[5]).toBeUndefined();
    // The alt text still travels.
    expect(args[3]).toBe('a sunset');
  });

  it('sends no focus for a focal point that is not inside the picture', async () => {
    await publisher.publish(options([photo({ focalPoint: { x: 4, y: 0.5 } })]));

    expect(service.uploadMedia.mock.calls[0][5]).toBeUndefined();
  });

  it('pairs each photo with its OWN focal point', async () => {
    // A carousel of three: the middle photo has none. A point must not slide
    // onto its neighbour.
    await publisher.publish(
      options([
        photo({ url: 'https://cdn.example/1.jpg', focalPoint: { x: 0, y: 0 } }),
        photo({ url: 'https://cdn.example/2.jpg' }),
        photo({ url: 'https://cdn.example/3.jpg', focalPoint: { x: 1, y: 1 } }),
      ]),
    );

    const byUrl = Object.fromEntries(
      service.uploadMedia.mock.calls.map((c) => [c[2], c[5]]),
    );
    expect(byUrl).toEqual({
      'https://cdn.example/1.jpg': '-1,1',
      'https://cdn.example/2.jpg': undefined,
      'https://cdn.example/3.jpg': '1,-1',
    });
  });

  it('attaches the uploaded media to the status', async () => {
    await publisher.publish(
      options([photo({ focalPoint: { x: 0.5, y: 0.5 } })]),
    );

    expect(service.createStatus).toHaveBeenCalledWith(
      'mastodon.example',
      'tok',
      'hello',
      expect.objectContaining({ mediaIds: ['m1'] }),
    );
  });

  describe('in a thread', () => {
    const thread = (items: Array<Record<string, unknown>>) =>
      options([], {
        thread: [{ text: 'one', mediaItems: items }, { text: 'two' }],
      });

    it("hands each post's focal point to its upload too", async () => {
      await publisher.publish(
        thread([
          {
            url: 'https://cdn.example/t.jpg',
            altText: 'alt',
            focalPoint: { x: 0.75, y: 0.25 },
          },
        ]),
      );

      expect(service.uploadMedia).toHaveBeenCalledWith(
        'mastodon.example',
        'tok',
        'https://cdn.example/t.jpg',
        'alt',
        undefined,
        '0.5,0.5',
      );
    });

    it('sends no focus for a thread photo without one', async () => {
      await publisher.publish(
        thread([{ url: 'https://cdn.example/t.jpg', altText: 'alt' }]),
      );

      expect(service.uploadMedia.mock.calls[0][5]).toBeUndefined();
    });
  });
});
