import { Test } from '@nestjs/testing';
import { ThreadsPublisher } from './threads.publisher';
import { ThreadsService } from '../../channels/services/threads.service';

/**
 * Threads' More settings: `quotePostUrl` -> `quote_post_id` (one of the
 * account's own posts, looked up by link) and `allowlistedCountryCodes`
 * -> `allowlisted_country_codes`.
 */
describe('ThreadsPublisher — quote a post, countries', () => {
  let publisher: ThreadsPublisher;
  let service: Record<string, jest.Mock>;
  const LINK = 'https://www.threads.com/@me/post/DAbc123';
  let n = 0;

  beforeEach(async () => {
    n = 0;
    const post = () => Promise.resolve({ postId: `p${++n}` });
    service = {
      createTextThread: jest.fn(post),
      createImageThread: jest.fn(post),
      createVideoThread: jest.fn(post),
      createCarouselThread: jest.fn(post),
      findOwnPostByLink: jest.fn().mockResolvedValue('17890'),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        ThreadsPublisher,
        { provide: ThreadsService, useValue: service },
      ],
    }).compile();
    publisher = moduleRef.get(ThreadsPublisher);
  });

  const options = (metadata: Record<string, any>, mediaItems: any[] = []) => ({
    content: 'Look at this',
    mediaItems,
    accessToken: 'token',
    platformAccountId: 'acct',
    channelMetadata: {},
    channelId: 1,
    metadata,
  });

  const text = (i = 0) => service.createTextThread.mock.calls[i][4];

  describe('quote a post', () => {
    it('looks the link up among the account’s posts and sends the id', async () => {
      await publisher.publish(options({ quotePostUrl: LINK }));

      expect(service.findOwnPostByLink).toHaveBeenCalledWith(
        'token',
        'acct',
        LINK,
      );
      expect(text().quotePostId).toBe('17890');
    });

    it('rides an image post too', async () => {
      await publisher.publish(
        options({ quotePostUrl: LINK }, [
          { type: 'image', url: 'https://cdn/a.jpg' },
        ]),
      );

      expect(service.createImageThread.mock.calls[0][5].quotePostId).toBe(
        '17890',
      );
    });

    it('fails before creating anything when the link is not found', async () => {
      service.findOwnPostByLink.mockRejectedValue(new Error('not found'));

      await expect(
        publisher.publish(options({ quotePostUrl: LINK })),
      ).rejects.toThrow('not found');
      expect(service.createTextThread).not.toHaveBeenCalled();
    });

    it('is not sent with a poll', async () => {
      await publisher.publish(
        options({
          quotePostUrl: LINK,
          poll: { options: ['Yes', 'No'] },
        }),
      );

      expect(service.findOwnPostByLink).not.toHaveBeenCalled();
      expect(text().quotePostId).toBeUndefined();
    });

    it('goes on post 1 of a thread only', async () => {
      await publisher.publish(
        options({
          quotePostUrl: LINK,
          thread: [{ text: 'one' }, { text: 'two' }],
        }),
      );

      expect(text(0).quotePostId).toBe('17890');
      expect(text(1)?.quotePostId).toBeUndefined();
    });

    it('refuses a link that is not a Threads post in validate()', () => {
      expect(() =>
        publisher.validate(options({ quotePostUrl: 'https://x.com/a/1' })),
      ).toThrow('is not a link to a Threads post');
    });

    it('does nothing for a blank link', async () => {
      await publisher.publish(options({ quotePostUrl: ' ' }));

      expect(service.findOwnPostByLink).not.toHaveBeenCalled();
    });
  });

  describe('countries', () => {
    it('forwards the codes, upper-cased', async () => {
      await publisher.publish(
        options({ allowlistedCountryCodes: ['us', ' CA '] }),
      );

      expect(text().allowlistedCountryCodes).toEqual(['US', 'CA']);
    });

    it('sends nothing when none were chosen', async () => {
      await publisher.publish(options({ allowlistedCountryCodes: [] }));

      expect(text().allowlistedCountryCodes).toBeUndefined();
    });

    it('refuses a code that is not two letters, before posting', async () => {
      await expect(
        publisher.publish(options({ allowlistedCountryCodes: ['US', 'USA'] })),
      ).rejects.toThrow('"USA" is not a two-letter country code');
      expect(service.createTextThread).not.toHaveBeenCalled();
    });

    it('gates every post of a thread, not just the first', async () => {
      await publisher.publish(
        options({
          allowlistedCountryCodes: ['PK'],
          replyControl: 'accounts_you_follow',
          thread: [{ text: 'one' }, { text: 'two' }, { text: 'three' }],
        }),
      );

      expect(text(0).allowlistedCountryCodes).toEqual(['PK']);
      expect(text(1)).toEqual({ allowlistedCountryCodes: ['PK'] });
      expect(text(2)).toEqual({ allowlistedCountryCodes: ['PK'] });
      // The root-only settings stay on the root.
      expect(text(0).replyControl).toBe('accounts_you_follow');
    });

    it('leaves replies without settings when there is no gate', async () => {
      await publisher.publish(
        options({ thread: [{ text: 'one' }, { text: 'two' }] }),
      );

      expect(text(1)).toBeUndefined();
    });
  });
});
