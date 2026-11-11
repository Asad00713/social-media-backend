import { LinkedInPublisher, normalizeVisibility } from './linkedin.publisher';
import { LinkedInService } from '../../channels/services/linkedin.service';
import { PublishOptions } from './base.publisher';

/**
 * Text, image and video now publish through the versioned Posts API, so the
 * author's "Allow reposts" choice reaches every format. This proves each
 * format reaches the right service method with the author URN, audience and
 * reshare choice; the service spec pins the requests themselves.
 */
describe('LinkedInPublisher - text, image and video on the Posts API', () => {
  let service: Record<string, jest.Mock>;
  let publisher: LinkedInPublisher;

  const options = (
    metadata: Record<string, unknown>,
    over: Partial<PublishOptions> = {},
  ): PublishOptions =>
    ({
      content: 'Hello',
      mediaItems: [],
      accessToken: 'tok',
      metadata,
      channelMetadata: {},
      platformAccountId: 'me',
      channelId: 1,
      ...over,
    }) as PublishOptions;

  const image = { type: 'image', url: 'https://cdn.test/a.jpg' } as any;
  const video = { type: 'video', url: 'https://cdn.test/v.mp4' } as any;

  beforeEach(() => {
    service = {
      createRestTextPost: jest
        .fn()
        .mockResolvedValue({ postId: 'urn:li:share:t' }),
      createRestImagePost: jest
        .fn()
        .mockResolvedValue({ postId: 'urn:li:share:i' }),
      createRestVideoPost: jest
        .fn()
        .mockResolvedValue({ postId: 'urn:li:share:v' }),
      createRestMultiImagePost: jest
        .fn()
        .mockResolvedValue({ postId: 'urn:li:share:m' }),
      createPost: jest.fn(),
      createPostWithImage: jest.fn(),
      createPostWithVideo: jest.fn(),
      createOrganizationPost: jest.fn(),
      createOrganizationPostWithImage: jest.fn(),
      createOrganizationPostWithVideo: jest.fn(),
      postComment: jest.fn().mockResolvedValue({ commentUrn: 'c' }),
    };
    publisher = new LinkedInPublisher(service as unknown as LinkedInService);
  });

  const legacyUntouched = () => {
    for (const name of [
      'createPost',
      'createPostWithImage',
      'createPostWithVideo',
      'createOrganizationPost',
      'createOrganizationPostWithImage',
      'createOrganizationPostWithVideo',
    ]) {
      expect(service[name]).not.toHaveBeenCalled();
    }
  };

  it('sends an image post with its title, audience and reshare choice', async () => {
    const result = await publisher.publish(
      options(
        {
          visibility: 'connections',
          reshareDisabled: true,
          imageTitle: ' Latte ',
        },
        { mediaItems: [image] },
      ),
    );
    expect(service.createRestImagePost).toHaveBeenCalledWith(
      'tok',
      'urn:li:person:me',
      'Hello',
      'https://cdn.test/a.jpg',
      'Latte',
      'CONNECTIONS',
      true,
      {},
    );
    expect(result.platformPostId).toBe('urn:li:share:i');
    legacyUntouched();
  });

  it('sends a video post the same way', async () => {
    await publisher.publish(
      options(
        { reshareDisabled: true, videoTitle: 'Behind the bar' },
        { mediaItems: [video] },
      ),
    );
    expect(service.createRestVideoPost).toHaveBeenCalledWith(
      'tok',
      'urn:li:person:me',
      'Hello',
      'https://cdn.test/v.mp4',
      'Behind the bar',
      'PUBLIC',
      true,
      {},
    );
    legacyUntouched();
  });

  it('sends no title when none was given', async () => {
    await publisher.publish(options({}, { mediaItems: [image] }));
    expect(service.createRestImagePost.mock.calls[0][4]).toBeUndefined();
  });

  it('posts as the page when the channel is one, on every format', async () => {
    const org = { channelMetadata: { isOrganization: true } };
    await publisher.publish(options({}, org));
    await publisher.publish(options({}, { ...org, mediaItems: [image] }));
    await publisher.publish(options({}, { ...org, mediaItems: [video] }));
    expect(service.createRestTextPost.mock.calls[0][1]).toBe(
      'urn:li:organization:me',
    );
    expect(service.createRestImagePost.mock.calls[0][1]).toBe(
      'urn:li:organization:me',
    );
    expect(service.createRestVideoPost.mock.calls[0][1]).toBe(
      'urn:li:organization:me',
    );
    legacyUntouched();
  });

  it('merges an article headline into the text post, which carries the reshare choice', async () => {
    await publisher.publish(
      options({
        postType: 'article',
        articleHeadline: 'Big news',
        reshareDisabled: true,
      }),
    );
    expect(service.createRestTextPost).toHaveBeenCalledWith(
      'tok',
      'urn:li:person:me',
      'Big news\n\nHello',
      'PUBLIC',
      true,
    );
  });

  it('allows reshares unless the author turned them off', async () => {
    await publisher.publish(options({}, { mediaItems: [video] }));
    expect(service.createRestVideoPost.mock.calls[0][6]).toBe(false);
  });

  describe('several photos (L5)', () => {
    const img = (n: number, altText?: string) =>
      ({
        type: 'image',
        url: `https://cdn.test/${n}.jpg`,
        ...(altText ? { altText } : {}),
      }) as any;

    it('2 images -> one multi-image post carrying both, not just the first', async () => {
      const result = await publisher.publish(
        options(
          { visibility: 'public', reshareDisabled: true },
          { mediaItems: [img(1, 'One'), img(2)] },
        ),
      );
      expect(service.createRestMultiImagePost).toHaveBeenCalledWith(
        'tok',
        'urn:li:person:me',
        'Hello',
        [
          { url: 'https://cdn.test/1.jpg', altText: 'One' },
          { url: 'https://cdn.test/2.jpg', altText: undefined },
        ],
        'PUBLIC',
        true,
      );
      expect(service.createRestImagePost).not.toHaveBeenCalled();
      expect(result.platformPostId).toBe('urn:li:share:m');
      expect(result.metadata?.mediaWarning).toBeUndefined();
      legacyUntouched();
    });

    it('3 images -> 3 entries, in order', async () => {
      await publisher.publish(
        options({}, { mediaItems: [img(1), img(2), img(3)] }),
      );
      const images = service.createRestMultiImagePost.mock.calls[0][3];
      expect(images.map((i: { url: string }) => i.url)).toEqual([
        'https://cdn.test/1.jpg',
        'https://cdn.test/2.jpg',
        'https://cdn.test/3.jpg',
      ]);
    });

    it('sends the first 20 of 22 images and says 2 were left out', async () => {
      const items = Array.from({ length: 22 }, (_, i) => img(i + 1));
      const result = await publisher.publish(
        options({}, { mediaItems: items }),
      );
      expect(service.createRestMultiImagePost.mock.calls[0][3]).toHaveLength(
        20,
      );
      expect(result.metadata?.mediaWarning).toMatch(/left out 2 other items/);
    });

    it('images then a video: publishes the images, says the video was left out', async () => {
      const result = await publisher.publish(
        options({}, { mediaItems: [img(1), img(2), video] }),
      );
      expect(service.createRestMultiImagePost.mock.calls[0][3]).toHaveLength(2);
      expect(service.createRestVideoPost).not.toHaveBeenCalled();
      expect(result.metadata?.mediaWarning).toMatch(/left out 1 other item$/);
    });

    it('a video first keeps the old behaviour - the video alone - and says so', async () => {
      const result = await publisher.publish(
        options({}, { mediaItems: [video, img(1)] }),
      );
      expect(service.createRestVideoPost).toHaveBeenCalledTimes(1);
      expect(service.createRestMultiImagePost).not.toHaveBeenCalled();
      expect(service.createRestImagePost).not.toHaveBeenCalled();
      expect(result.metadata?.mediaWarning).toMatch(
        /one video on its own: published the video, left out 1 other item/,
      );
    });
  });

  describe('alt text (L6)', () => {
    it('reaches a single image post', async () => {
      await publisher.publish(
        options({}, { mediaItems: [{ ...image, altText: 'A latte' }] }),
      );
      expect(service.createRestImagePost.mock.calls[0][7]).toEqual({
        altText: 'A latte',
      });
    });

    it('reaches a video post, beside the thumbnail option', async () => {
      await publisher.publish(
        options({}, { mediaItems: [{ ...video, altText: 'Pouring' }] }),
      );
      expect(service.createRestVideoPost.mock.calls[0][7]).toEqual({
        altText: 'Pouring',
      });
    });
  });

  describe('audience (L3)', () => {
    it.each([
      ['LOGGED_IN', 'LOGGED_IN'],
      ['logged_in', 'LOGGED_IN'],
      ['logged-in', 'LOGGED_IN'],
      ['members', 'LOGGED_IN'],
      ['members_only', 'LOGGED_IN'],
      ['signed-in', 'LOGGED_IN'],
      ['connections', 'CONNECTIONS'],
      ['CONNECTIONS', 'CONNECTIONS'],
      ['public', 'PUBLIC'],
      ['PUBLIC', 'PUBLIC'],
      ['anything else', 'PUBLIC'],
      [undefined, 'PUBLIC'],
      [42, 'PUBLIC'],
    ])('%p -> %s', (value, expected) => {
      expect(normalizeVisibility(value)).toBe(expected);
    });

    it('a signed-in-members post reaches the service as LOGGED_IN', async () => {
      await publisher.publish(options({ visibility: 'logged_in' }));
      expect(service.createRestTextPost.mock.calls[0][3]).toBe('LOGGED_IN');
    });
  });
});
