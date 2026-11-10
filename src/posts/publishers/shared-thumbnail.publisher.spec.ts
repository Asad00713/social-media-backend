/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- test doubles are loosely typed */

import { FacebookPublisher } from './facebook.publisher';
import { LinkedInPublisher } from './linkedin.publisher';
import { FacebookService } from '../../channels/services/facebook.service';
import { LinkedInService } from '../../channels/services/linkedin.service';
import { PublishOptions } from './base.publisher';

/**
 * YouTube's designed thumbnail reaches these two publishers as
 * `sharedThumbnailUrl` (see `posts/lib/shared-thumbnail.ts`). These pin that
 * each reads it under exactly that key, sends it only on the format that can
 * carry a video thumbnail, and turns a picture that could not be sent into a
 * warning on a post that still went out.
 */
const PICTURE = 'https://cdn.example/thumb.jpg';
const VIDEO = { type: 'video', url: 'https://cdn.example/v.mp4' } as any;
const IMAGE = { type: 'image', url: 'https://cdn.example/a.jpg' } as any;

const options = (
  metadata: Record<string, unknown>,
  over: Partial<PublishOptions> = {},
): PublishOptions =>
  ({
    content: 'a caption',
    mediaItems: [VIDEO],
    accessToken: 'tok',
    metadata,
    channelMetadata: {},
    platformAccountId: 'acc-1',
    channelId: 1,
    ...over,
  }) as PublishOptions;

describe('FacebookPublisher - the shared thumbnail', () => {
  let service: Record<string, jest.Mock>;
  let publisher: FacebookPublisher;

  beforeEach(() => {
    service = {
      postVideoToPage: jest.fn().mockResolvedValue({ postId: 'vid-1' }),
      postReelToPage: jest.fn().mockResolvedValue({ postId: 'reel-1' }),
      postToPage: jest.fn().mockResolvedValue({ postId: 'post-1' }),
      postPhotoToPage: jest.fn().mockResolvedValue({ postId: 'photo-1' }),
      postVideoStoryToPage: jest.fn().mockResolvedValue({ postId: 'story-1' }),
      postComment: jest.fn(),
    };
    publisher = new FacebookPublisher(service as unknown as FacebookService);
  });

  it('publishes a feed video through /videos with the picture', async () => {
    await publisher.publish(
      options({ postType: 'post', sharedThumbnailUrl: PICTURE }),
    );
    expect(service.postVideoToPage).toHaveBeenCalledWith(
      'acc-1',
      'tok',
      'https://cdn.example/v.mp4',
      'a caption',
      { thumbnailUrl: PICTURE },
    );
    expect(service.postToPage).not.toHaveBeenCalled();
  });

  it('publishes a feed video with no thumbnail when there is none', async () => {
    await publisher.publish(options({ postType: 'post' }));
    expect(service.postVideoToPage.mock.calls[0][4]).toEqual({});
  });

  it('never takes a Reel’s cover frame as the feed video’s thumbnail', async () => {
    // `thumbnailUrl` is a Reel's cover; a feed video reads only the shared key.
    await publisher.publish(
      options({ postType: 'post', thumbnailUrl: 'https://cdn.example/f.jpg' }),
    );
    expect(service.postVideoToPage.mock.calls[0][4]).toEqual({});
  });

  it('keeps a Reel on its own cover, never the shared design', async () => {
    await publisher.publish(
      options({ postType: 'reel', sharedThumbnailUrl: PICTURE }),
    );
    expect(service.postVideoToPage).not.toHaveBeenCalled();
    expect(service.postReelToPage.mock.calls[0][4]).toEqual({});
  });

  it('sends nothing on a photo post or a Story', async () => {
    await publisher.publish(
      options(
        { postType: 'post', sharedThumbnailUrl: PICTURE },
        { mediaItems: [IMAGE] },
      ),
    );
    await publisher.publish(
      options({ postType: 'story', sharedThumbnailUrl: PICTURE }),
    );
    expect(service.postVideoToPage).not.toHaveBeenCalled();
    expect(service.postPhotoToPage).toHaveBeenCalledTimes(1);
    expect(service.postVideoStoryToPage).toHaveBeenCalledTimes(1);
  });

  it('reports a thumbnail that could not be sent as a warning, not a failure', async () => {
    service.postVideoToPage.mockResolvedValue({
      postId: 'vid-1',
      thumbnailWarning: 'Posted without the thumbnail: HTTP 404',
    });
    const result = await publisher.publish(
      options({ postType: 'post', sharedThumbnailUrl: PICTURE }),
    );
    expect(result.platformPostId).toBe('vid-1');
    expect(result.metadata?.coverWarning).toBe(
      'Posted without the thumbnail: HTTP 404',
    );
  });
});

describe('LinkedInPublisher - the shared thumbnail', () => {
  let service: Record<string, jest.Mock>;
  let publisher: LinkedInPublisher;

  beforeEach(() => {
    service = {
      createRestVideoPost: jest
        .fn()
        .mockResolvedValue({ postId: 'urn:li:share:v' }),
      createRestImagePost: jest
        .fn()
        .mockResolvedValue({ postId: 'urn:li:share:i' }),
      postComment: jest.fn(),
    };
    publisher = new LinkedInPublisher(service as unknown as LinkedInService);
  });

  it('hands the picture to the video upload', async () => {
    await publisher.publish(options({ sharedThumbnailUrl: PICTURE }));
    expect(service.createRestVideoPost.mock.calls[0][7]).toEqual({
      thumbnailUrl: PICTURE,
    });
  });

  it('asks for no thumbnail when there is none', async () => {
    await publisher.publish(options({}));
    expect(service.createRestVideoPost.mock.calls[0][7]).toEqual({});
  });

  it('sends nothing on an image post', async () => {
    await publisher.publish(
      options({ sharedThumbnailUrl: PICTURE }, { mediaItems: [IMAGE] }),
    );
    expect(service.createRestImagePost).toHaveBeenCalledTimes(1);
    expect(service.createRestImagePost.mock.calls[0]).not.toContainEqual({
      thumbnailUrl: PICTURE,
    });
  });

  it('reports a thumbnail that could not be sent as a warning, not a failure', async () => {
    service.createRestVideoPost.mockResolvedValue({
      postId: 'urn:li:share:v',
      thumbnailWarning: 'Posted without the thumbnail: LinkedIn refused it',
    });
    const result = await publisher.publish(
      options({ sharedThumbnailUrl: PICTURE }),
    );
    expect(result.platformPostId).toBe('urn:li:share:v');
    expect(result.metadata?.thumbnailWarning).toBe(
      'Posted without the thumbnail: LinkedIn refused it',
    );
  });

  it('carries no warning when the thumbnail went out', async () => {
    const result = await publisher.publish(
      options({ sharedThumbnailUrl: PICTURE }),
    );
    expect(result.metadata?.thumbnailWarning).toBeUndefined();
  });
});
