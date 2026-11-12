/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/require-await -- test doubles are loosely typed */

import { Test } from '@nestjs/testing';
import { ThreadsPublisher, threadsPollToSend } from './threads.publisher';
import { ThreadsService } from '../../channels/services/threads.service';

/**
 * T1: a Threads poll in the Poll format used to be dropped (fewer than two
 * options, or media beside it) and the post went out as plain text,
 * "Published". S5: each media item's alt text was never sent.
 */
describe('ThreadsPublisher — poll format and alt text', () => {
  let publisher: ThreadsPublisher;
  let svc: Record<string, jest.Mock>;

  beforeEach(async () => {
    svc = {
      createTextThread: jest.fn().mockResolvedValue({ postId: 't1' }),
      createImageThread: jest.fn().mockResolvedValue({ postId: 'i1' }),
      createVideoThread: jest.fn().mockResolvedValue({ postId: 'v1' }),
      createCarouselThread: jest.fn().mockResolvedValue({ postId: 'c1' }),
      findOwnPostByLink: jest.fn(),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [ThreadsPublisher, { provide: ThreadsService, useValue: svc }],
    }).compile();
    publisher = moduleRef.get(ThreadsPublisher);
  });

  const options = (metadata: Record<string, any>, mediaItems: any[] = []) => ({
    content: 'Which roast?',
    mediaItems,
    accessToken: 'token',
    platformAccountId: 'acct',
    channelMetadata: {},
    channelId: 1,
    metadata,
  });

  const IMAGE = { type: 'image', url: 'https://cdn.test/a.jpg' };
  const nothingSent = () =>
    Object.values(svc).every((fn) => fn.mock.calls.length === 0);

  describe('poll format', () => {
    it('sends a valid poll', async () => {
      await publisher.publish(
        options({ postType: 'poll', poll: { options: ['Dark', 'Light'] } }),
      );
      expect(svc.createTextThread.mock.calls[0][4].poll).toEqual({
        optionA: 'Dark',
        optionB: 'Light',
        optionC: undefined,
        optionD: undefined,
      });
    });

    it.each([
      ['one option', { options: ['Dark'] }],
      ['blank options', { options: [' ', ''] }],
      ['no poll at all', undefined],
    ])('fails with %s instead of posting plain text', async (_l, poll) => {
      await expect(
        publisher.publish(options({ postType: 'poll', poll })),
      ).rejects.toThrow(/at least 2 filled-in options/);
      expect(nothingSent()).toBe(true);
    });

    it('fails when media rides the poll instead of dropping the poll', async () => {
      await expect(
        publisher.publish(
          options({ postType: 'poll', poll: { options: ['Dark', 'Light'] } }, [
            IMAGE,
          ]),
        ),
      ).rejects.toThrow(/text-only post/);
      expect(nothingSent()).toBe(true);
    });

    it('fails on a fifth option and an over-long one instead of trimming', async () => {
      await expect(
        publisher.publish(
          options({
            postType: 'poll',
            poll: { options: ['a', 'b', 'c', 'd', 'e'] },
          }),
        ),
      ).rejects.toThrow(/at most 4 options/);
      await expect(
        publisher.publish(
          options({
            postType: 'poll',
            poll: { options: ['a', 'x'.repeat(26)] },
          }),
        ),
      ).rejects.toThrow(/25-character limit/);
    });

    it('leaves a row with no format on the old lenient reading', () => {
      expect(threadsPollToSend({ poll: { options: ['only'] } }, 0)).toBe(
        undefined,
      );
      expect(
        threadsPollToSend({ poll: { options: ['a', 'b'] } }, 1),
      ).toBeUndefined();
    });

    it('never sends a poll left over after a switch to Post', async () => {
      await publisher.publish(
        options({ postType: 'post', poll: { options: ['only'] } }),
      );
      expect(svc.createTextThread.mock.calls[0][4].poll).toBeUndefined();
    });
  });

  describe('alt text', () => {
    it("sends a single image's alt text on its container", async () => {
      await publisher.publish(
        options({}, [{ ...IMAGE, altText: '  A flat white  ' }]),
      );
      expect(svc.createImageThread.mock.calls[0][5]).toMatchObject({
        altText: 'A flat white',
      });
    });

    it("sends a video's alt text", async () => {
      await publisher.publish(
        options({}, [
          { type: 'video', url: 'https://cdn.test/v.mp4', altText: 'Pouring' },
        ]),
      );
      expect(svc.createVideoThread.mock.calls[0][5]).toMatchObject({
        altText: 'Pouring',
      });
    });

    it('sends each carousel item its own alt text', async () => {
      await publisher.publish(
        options({}, [
          { ...IMAGE, altText: 'One' },
          { type: 'image', url: 'https://cdn.test/b.jpg' },
        ]),
      );
      const items = svc.createCarouselThread.mock.calls[0][2];
      expect(items[0]).toEqual({
        type: 'IMAGE',
        url: IMAGE.url,
        altText: 'One',
      });
      expect('altText' in items[1]).toBe(false);
    });

    it("sends alt text on a thread post's media", async () => {
      await publisher.publish(
        options({
          postType: 'thread',
          thread: [
            { text: 'one', mediaItems: [{ ...IMAGE, altText: 'Beans' }] },
            { text: 'two' },
          ],
        }),
      );
      expect(svc.createImageThread.mock.calls[0][5]).toMatchObject({
        altText: 'Beans',
      });
    });

    it('refuses alt text over 1,000 characters before anything is sent', async () => {
      await expect(
        publisher.publish(
          options({}, [{ ...IMAGE, altText: 'x'.repeat(1001) }]),
        ),
      ).rejects.toThrow(/1000-character limit/);
      expect(nothingSent()).toBe(true);
    });
  });
});
