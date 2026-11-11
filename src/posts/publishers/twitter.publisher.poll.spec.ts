/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access -- test doubles are loosely typed */
import { TwitterPublisher, xPollToSend } from './twitter.publisher';

/**
 * X1/X2: an X poll.
 *
 * X1 — the composer starts a poll with empty option rows. They were sent as
 * they were, and X refused the post ("1-25 characters").
 * X2 — a post whose format is Poll but which carries no options published as
 * plain text, with no word that the poll was lost.
 */
describe('TwitterPublisher — polls', () => {
  let createTweet: jest.Mock;
  let uploadMedia: jest.Mock;
  let publisher: TwitterPublisher;

  beforeEach(() => {
    createTweet = jest.fn().mockResolvedValue({ id: '1' });
    uploadMedia = jest.fn().mockResolvedValue('media-1');
    publisher = new TwitterPublisher({
      createTweet,
      uploadMedia,
      lookupUserIds: jest.fn(),
    } as any);
  });

  const options = (metadata: Record<string, any>, mediaItems: any[] = []) =>
    ({
      content: 'Which one?',
      mediaItems,
      accessToken: 'token',
      platformAccountId: 'acct',
      channelMetadata: {},
      channelId: 1,
      metadata,
    }) as any;

  const sentPoll = () => createTweet.mock.calls[0][2].poll;

  it('drops blank and whitespace-only options before sending', async () => {
    await publisher.publish(
      options({
        postType: 'poll',
        poll: { options: ['Hot', '', '  ', ' Iced '], durationMinutes: 1440 },
      }),
    );

    expect(sentPoll()).toEqual({
      options: ['Hot', 'Iced'],
      durationMinutes: 1440,
    });
  });

  it.each([
    ['no poll at all', undefined],
    ['no options', { options: [], durationMinutes: 60 }],
    ['only blank options', { options: ['', ' ', ''], durationMinutes: 60 }],
    ['one filled option', { options: ['Hot', ''], durationMinutes: 60 }],
  ])(
    'refuses a Poll with %s instead of posting the text alone',
    async (_label, poll) => {
      await expect(
        publisher.publish(options({ postType: 'poll', poll })),
      ).rejects.toThrow(/at least 2 filled-in options/);
      expect(createTweet).not.toHaveBeenCalled();
    },
  );

  it('refuses a poll with media, before anything is uploaded', async () => {
    await expect(
      publisher.publish(
        options(
          {
            postType: 'poll',
            poll: { options: ['Hot', 'Iced'], durationMinutes: 60 },
          },
          [{ type: 'image', url: 'https://cdn.test/a.jpg' }],
        ),
      ),
    ).rejects.toThrow(/poll and media in the same post/);
    expect(uploadMedia).not.toHaveBeenCalled();
    expect(createTweet).not.toHaveBeenCalled();
  });

  it('still refuses an option over 25 characters, naming it', async () => {
    const long = 'x'.repeat(26);
    await expect(
      publisher.publish(
        options({
          postType: 'poll',
          poll: { options: ['Hot', long], durationMinutes: 60 },
        }),
      ),
    ).rejects.toThrow(long);
  });

  it('ignores a leftover poll when the format is Post', async () => {
    await publisher.publish(
      options({
        postType: 'post',
        poll: { options: ['', ''], durationMinutes: 60 },
      }),
    );
    expect(sentPoll()).toBeUndefined();
  });

  it('does not let a leftover poll refuse a Post with media', () => {
    expect(
      xPollToSend(
        { postType: 'post', poll: { options: ['Hot', 'Iced'], durationMinutes: 60 } },
        2,
      ),
    ).toBeUndefined();
  });

  describe('a row with no format stored (legacy)', () => {
    it('sends its poll, blanks dropped', () => {
      expect(
        xPollToSend(
          { poll: { options: ['Hot', '', 'Iced'], durationMinutes: 60 } },
          0,
        ),
      ).toEqual({ options: ['Hot', 'Iced'], durationMinutes: 60 });
    });

    it('is a plain post when it has no poll', () => {
      expect(xPollToSend({}, 0)).toBeUndefined();
      expect(xPollToSend({}, 2)).toBeUndefined();
    });
  });
});
