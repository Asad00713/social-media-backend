/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/require-await -- test doubles are loosely typed */

import { Test } from '@nestjs/testing';
import { MastodonPublisher, mastodonPollToSend } from './mastodon.publisher';
import { MastodonService } from '../../channels/services/mastodon.service';

/**
 * M2: a Mastodon poll in the Poll format used to be dropped (fewer than two
 * options, or media beside it) and the post went out as plain text.
 * M1: the composer's First comment for Mastodon was never posted.
 */
describe('MastodonPublisher — poll format and first comment', () => {
  let publisher: MastodonPublisher;
  let createStatus: jest.Mock;
  let uploadMedia: jest.Mock;

  beforeEach(async () => {
    createStatus = jest
      .fn()
      .mockResolvedValueOnce({ id: 'status-1', url: 'https://m.test/1' })
      .mockResolvedValue({ id: 'reply-1', url: 'https://m.test/2' });
    uploadMedia = jest.fn().mockResolvedValue({ id: 'media-1' });
    const moduleRef = await Test.createTestingModule({
      providers: [
        MastodonPublisher,
        { provide: MastodonService, useValue: { createStatus, uploadMedia } },
      ],
    }).compile();
    publisher = moduleRef.get(MastodonPublisher);
  });

  const options = (metadata: Record<string, any>, mediaItems: any[] = []) => ({
    content: 'Which roast?',
    mediaItems,
    accessToken: 'token',
    platformAccountId: 'acct',
    channelMetadata: { instanceUrl: 'https://mastodon.test' },
    channelId: 1,
    metadata,
  });
  const IMAGE = { type: 'image', url: 'https://cdn.test/a.jpg' };
  const POLL = { options: ['Dark', 'Light'], expiresInSeconds: 3600 };

  describe('poll format', () => {
    it('sends a valid poll', async () => {
      await publisher.publish(options({ postType: 'poll', poll: POLL }));
      expect(createStatus.mock.calls[0][3].poll).toEqual({
        ...POLL,
        multiple: false,
      });
    });

    it.each([
      ['one option', { options: ['Dark'], expiresInSeconds: 60 }],
      ['blank options', { options: ['  ', ''], expiresInSeconds: 60 }],
      ['no poll at all', undefined],
    ])('fails with %s instead of posting plain text', async (_l, poll) => {
      await expect(
        publisher.publish(options({ postType: 'poll', poll })),
      ).rejects.toThrow(/at least 2 filled-in options/);
      expect(createStatus).not.toHaveBeenCalled();
    });

    it('fails when media rides the poll, before anything is uploaded', async () => {
      await expect(
        publisher.publish(options({ postType: 'poll', poll: POLL }, [IMAGE])),
      ).rejects.toThrow(/poll and media/);
      expect(uploadMedia).not.toHaveBeenCalled();
      expect(createStatus).not.toHaveBeenCalled();
    });

    it('fails on a fifth option instead of the service dropping it', async () => {
      await expect(
        publisher.publish(
          options({
            postType: 'poll',
            poll: { options: ['a', 'b', 'c', 'd', 'e'], expiresInSeconds: 60 },
          }),
        ),
      ).rejects.toThrow(/at most 4 options/);
    });

    it('fails on a missing duration', async () => {
      await expect(
        publisher.publish(
          options({ postType: 'poll', poll: { options: ['a', 'b'] } }),
        ),
      ).rejects.toThrow(/no duration/);
    });

    it('leaves a row with no format on the old reading (dropped)', () => {
      expect(
        mastodonPollToSend(
          { poll: { options: ['only'], expiresInSeconds: 60 } },
          0,
        ),
      ).toBeUndefined();
    });
  });

  describe('first comment', () => {
    it('posts it as a reply to the new status, matching its audience', async () => {
      const result = await publisher.publish(
        options({
          firstComment: '  Menu in bio  ',
          visibility: 'unlisted',
          language: 'en',
          contentWarning: 'coffee',
        }),
      );
      expect(createStatus).toHaveBeenCalledTimes(2);
      const [, , text, opts] = createStatus.mock.calls[1];
      expect(text).toBe('Menu in bio');
      expect(opts).toMatchObject({
        inReplyToId: 'status-1',
        visibility: 'unlisted',
        language: 'en',
        spoilerText: 'coffee',
        sensitive: true,
      });
      expect(result.platformPostId).toBe('status-1');
      expect(result.metadata).toEqual({ firstCommentId: 'reply-1' });
    });

    it('keeps the post published and reports a failed reply as a warning', async () => {
      createStatus.mockReset();
      createStatus
        .mockResolvedValueOnce({ id: 'status-1', url: 'https://m.test/1' })
        .mockRejectedValueOnce(new Error('Validation failed: Text too long'));
      const result = await publisher.publish(
        options({ firstComment: 'Menu in bio' }),
      );
      expect(result.platformPostId).toBe('status-1');
      expect(result.metadata).toEqual({
        firstCommentWarning: 'Validation failed: Text too long',
      });
    });

    it('posts nothing extra without a first comment', async () => {
      await publisher.publish(options({ firstComment: '   ' }));
      expect(createStatus).toHaveBeenCalledTimes(1);
    });

    it('is not sent on a thread (the composer has no First comment there)', async () => {
      await publisher.publish(
        options({
          postType: 'thread',
          firstComment: 'left over',
          thread: [{ text: 'one' }, { text: 'two' }],
        }),
      );
      expect(createStatus).toHaveBeenCalledTimes(2);
      expect(createStatus.mock.calls.map((c) => c[2])).toEqual(['one', 'two']);
    });
  });
});
