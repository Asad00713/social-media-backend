/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/require-await -- test doubles are loosely typed */

import { Test } from '@nestjs/testing';
import { InstagramPublisher } from './instagram.publisher';
import { InstagramService } from '../../channels/services/instagram.service';

/**
 * S5: Instagram's `alt_text` - "Alternative text, up to 1000 character, for
 * an image. Only supported on a single image or image media in a carousel.
 * Reels and stories are not supported." (IG User Media reference).
 */
describe('InstagramPublisher — alt text', () => {
  let publisher: InstagramPublisher;
  let svc: Record<string, jest.Mock>;

  beforeEach(async () => {
    svc = {
      createImagePostWithUserToken: jest
        .fn()
        .mockResolvedValue({ postId: '1' }),
      createCarouselPostWithUserToken: jest
        .fn()
        .mockResolvedValue({ postId: '1' }),
      createStoryWithUserToken: jest.fn().mockResolvedValue({ postId: '1' }),
      createVideoPostWithUserToken: jest
        .fn()
        .mockResolvedValue({ postId: '1' }),
      postCommentWithUserToken: jest.fn(),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        InstagramPublisher,
        { provide: InstagramService, useValue: svc },
      ],
    }).compile();
    publisher = moduleRef.get(InstagramPublisher);
  });

  const options = (mediaItems: any[], metadata: Record<string, any> = {}) => ({
    content: 'New roast',
    mediaItems,
    accessToken: 'token',
    platformAccountId: 'acct',
    channelMetadata: {},
    channelId: 1,
    metadata,
  });
  const img = (url: string, altText?: string) => ({
    type: 'image',
    url,
    ...(altText !== undefined ? { altText } : {}),
  });

  it('sends a single feed image its alt text', async () => {
    await publisher.publish(
      options([img('https://cdn.test/a.jpg', ' Beans ')]),
    );
    expect(svc.createImagePostWithUserToken.mock.calls[0][4]).toMatchObject({
      altText: 'Beans',
    });
  });

  it('sends no altText key for an image without one', async () => {
    await publisher.publish(options([img('https://cdn.test/a.jpg')]));
    const settings = svc.createImagePostWithUserToken.mock.calls[0][4];
    expect(settings?.altText).toBeUndefined();
  });

  it.each(['feed', 'carousel'])(
    'sends each %s carousel IMAGE its own alt text, never a video',
    async (postType) => {
      await publisher.publish(
        options(
          [
            img('https://cdn.test/a.jpg', 'Beans'),
            { type: 'video', url: 'https://cdn.test/v.mp4', altText: 'Pour' },
            img('https://cdn.test/b.jpg'),
          ],
          { postType },
        ),
      );
      const [, , items, , parent] =
        svc.createCarouselPostWithUserToken.mock.calls[0];
      expect(items[0].altText).toBe('Beans');
      expect('altText' in items[1]).toBe(false);
      expect('altText' in items[2]).toBe(false);
      // Never on the parent container.
      expect(parent?.altText).toBeUndefined();
    },
  );

  it('refuses alt text over 1,000 characters before anything is sent', async () => {
    await expect(
      publisher.publish(
        options([img('https://cdn.test/a.jpg', 'x'.repeat(1001))]),
      ),
    ).rejects.toThrow(/1000-character limit/);
    expect(svc.createImagePostWithUserToken).not.toHaveBeenCalled();
  });
});
