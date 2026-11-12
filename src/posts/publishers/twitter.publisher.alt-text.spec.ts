/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/require-await -- test doubles are loosely typed */

import { Test } from '@nestjs/testing';
import { TwitterPublisher } from './twitter.publisher';
import { TwitterService } from '../../channels/services/twitter.service';

jest.mock('../../common/net/public-fetch', () => ({
  ...jest.requireActual<typeof import('../../common/net/public-fetch')>(
    '../../common/net/public-fetch',
  ),
  fetchPublicMedia: (url: string) => global.fetch(url),
}));

/**
 * S5: each media item's alt text goes to X (`POST /2/media/metadata`)
 * after the upload and before the post. It is a soft step: a description
 * X refuses never costs the post, it comes back as `altTextWarning`.
 */
describe('TwitterPublisher — alt text', () => {
  let publisher: TwitterPublisher;
  let service: Record<string, jest.Mock>;
  const realFetch = global.fetch;
  const order: string[] = [];

  beforeEach(async () => {
    order.length = 0;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
    }) as unknown as typeof fetch;
    let n = 0;
    service = {
      uploadMedia: jest.fn(async () => {
        n += 1;
        order.push(`upload m${n}`);
        return `m${n}`;
      }),
      setMediaAltText: jest.fn(async (_t: string, id: string) => {
        order.push(`alt ${id}`);
      }),
      createTweet: jest.fn(async () => {
        order.push('tweet');
        return { id: 't1', text: '' };
      }),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        TwitterPublisher,
        { provide: TwitterService, useValue: service },
      ],
    }).compile();
    publisher = moduleRef.get(TwitterPublisher);
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  const options = (mediaItems: any[], metadata: Record<string, any> = {}) => ({
    content: 'New roast',
    mediaItems,
    accessToken: 'token',
    platformAccountId: 'acct',
    channelMetadata: { oauthToken: 'ot', oauthTokenSecret: 'os' },
    channelId: 1,
    metadata,
  });
  const img = (altText?: string) => ({
    type: 'image',
    url: 'https://cdn.test/a.jpg',
    ...(altText !== undefined ? { altText } : {}),
  });

  it("sets each item's alt text on its own media id, before the post", async () => {
    await publisher.publish(options([img(' Beans '), img(), img('Cup')]));

    expect(service.setMediaAltText.mock.calls).toEqual([
      ['token', 'm1', 'Beans', { oauthToken: 'ot', oauthTokenSecret: 'os' }],
      ['token', 'm3', 'Cup', { oauthToken: 'ot', oauthTokenSecret: 'os' }],
    ]);
    expect(order).toEqual([
      'upload m1',
      'alt m1',
      'upload m2',
      'upload m3',
      'alt m3',
      'tweet',
    ]);
  });

  it('publishes anyway and reports a refused description', async () => {
    service.setMediaAltText.mockRejectedValue(
      new Error('X refused the alt text (HTTP 403)'),
    );
    const result = await publisher.publish(options([img('Beans'), img('Cup')]));

    expect(service.createTweet).toHaveBeenCalled();
    expect(result.platformPostId).toBe('t1');
    expect(result.metadata).toEqual({
      altTextWarning:
        'X refused the alt text (HTTP 403) (and 1 more media item)',
    });
  });

  it('sends nothing and warns nothing without alt text', async () => {
    const result = await publisher.publish(options([img(), img('  ')]));
    expect(service.setMediaAltText).not.toHaveBeenCalled();
    expect(result.metadata).toBeUndefined();
  });

  it("sets alt text on a thread post's media, keeping the thread ids", async () => {
    service.setMediaAltText.mockRejectedValue(new Error('nope'));
    const result = await publisher.publish(
      options([], {
        postType: 'thread',
        thread: [{ text: 'one', mediaItems: [img('Beans')] }, { text: 'two' }],
      }),
    );
    expect(service.setMediaAltText).toHaveBeenCalledWith(
      'token',
      'm1',
      'Beans',
      expect.anything(),
    );
    expect(result.metadata).toEqual({
      threadIds: ['t1', 't1'],
      altTextWarning: 'nope',
    });
  });
});
