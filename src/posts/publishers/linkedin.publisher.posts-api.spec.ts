import { LinkedInPublisher } from './linkedin.publisher';
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
});
