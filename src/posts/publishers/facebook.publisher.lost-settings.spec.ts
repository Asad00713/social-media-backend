/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/require-await -- test doubles are loosely typed */

import { FacebookPublisher } from './facebook.publisher';
import { FacebookService } from '../../channels/services/facebook.service';
import { PublishOptions } from './base.publisher';

/**
 * F2: a Facebook Post published only its first photo. F1: a feed video
 * dropped backdate and minimum age (sent now) and location (the Page Videos
 * edge has no `place`: reported, not dropped). S5: alt text on photos.
 */
describe('FacebookPublisher - photos, alt text and video settings', () => {
  let publisher: FacebookPublisher;
  let service: Record<string, jest.Mock>;

  const options = (
    metadata: Record<string, unknown>,
    mediaItems: any[],
  ): PublishOptions =>
    ({
      content: 'a caption',
      mediaItems,
      accessToken: 'page-token',
      metadata,
      channelMetadata: {},
      platformAccountId: 'page-1',
      channelId: 1,
    }) as PublishOptions;

  const img = (n: number, altText?: string) => ({
    type: 'image',
    url: `https://cdn.example/${n}.jpg`,
    ...(altText !== undefined ? { altText } : {}),
  });
  const VIDEO = { type: 'video', url: 'https://cdn.example/v.mp4' };

  const SETTINGS = {
    backdatedTime: '2024-03-01T09:30:00Z',
    minAge: 18,
    place: '1234567',
  };
  const BACKDATE = Date.parse('2024-03-01T09:30:00Z') / 1000;

  beforeEach(() => {
    service = {
      postPhotoToPage: jest.fn().mockResolvedValue({ postId: 'photo-1' }),
      postPhotosToPage: jest.fn().mockResolvedValue({ postId: 'multi-1' }),
      postVideoToPage: jest.fn().mockResolvedValue({ postId: 'video-1' }),
      postComment: jest.fn(),
    };
    publisher = new FacebookPublisher(service as unknown as FacebookService);
  });

  it('publishes EVERY photo of a Post, each with its alt text', async () => {
    const result = await publisher.publish(
      options({ postType: 'post', ...SETTINGS }, [
        img(1, ' Beans '),
        img(2),
        img(3, 'Cup'),
      ]),
    );
    expect(service.postPhotoToPage).not.toHaveBeenCalled();
    const [page, token, photos, caption, opts] =
      service.postPhotosToPage.mock.calls[0];
    expect([page, token, caption]).toEqual([
      'page-1',
      'page-token',
      'a caption',
    ]);
    expect(photos).toEqual([
      { url: 'https://cdn.example/1.jpg', altText: 'Beans' },
      { url: 'https://cdn.example/2.jpg' },
      { url: 'https://cdn.example/3.jpg', altText: 'Cup' },
    ]);
    expect(opts).toEqual({
      backdatedTime: BACKDATE,
      targeting: { age_min: 18 },
      place: '1234567',
    });
    expect(result.platformPostId).toBe('multi-1');
    expect(result.metadata).toBeUndefined();
  });

  it('keeps the one-photo path for a single photo, with its alt text', async () => {
    await publisher.publish(options({ postType: 'post' }, [img(1, 'Beans')]));
    expect(service.postPhotosToPage).not.toHaveBeenCalled();
    expect(service.postPhotoToPage.mock.calls[0][4]).toEqual({
      altText: 'Beans',
    });
  });

  it('reports a video it could not put beside the photos', async () => {
    const result = await publisher.publish(
      options({ postType: 'post' }, [img(1), img(2), VIDEO]),
    );
    expect(service.postPhotosToPage.mock.calls[0][2]).toHaveLength(2);
    expect(result.metadata?.mediaWarning).toMatch(
      /published 2 photos, left out 1 other item/,
    );
  });

  it('sends a feed video its backdate and minimum age', async () => {
    await publisher.publish(
      options(
        { postType: 'post', backdatedTime: SETTINGS.backdatedTime, minAge: 18 },
        [VIDEO],
      ),
    );
    expect(service.postVideoToPage.mock.calls[0][4]).toEqual({
      backdatedTime: BACKDATE,
      targeting: { age_min: 18 },
    });
  });

  it('reports a location on a feed video instead of dropping it silently', async () => {
    const result = await publisher.publish(
      options({ postType: 'post', place: '1234567' }, [VIDEO]),
    );
    expect(service.postVideoToPage.mock.calls[0][4]).toEqual({});
    expect(result.metadata?.locationWarning).toMatch(
      /location on a feed video/,
    );
  });

  it('reports the items left out beside a feed video', async () => {
    const result = await publisher.publish(
      options({ postType: 'post' }, [VIDEO, img(1)]),
    );
    expect(result.metadata?.mediaWarning).toMatch(/left out 1 other item/);
  });
});
