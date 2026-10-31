import { Test } from '@nestjs/testing';
import { TwitterPublisher } from './twitter.publisher';
import { TwitterService } from '../../channels/services/twitter.service';

/**
 * These cover `reply_settings` and nothing else, because that is what this
 * change added and what it can get wrong in a way nobody would notice: a
 * rejected value fails the whole post, and a silently dropped one publishes
 * a post the author believed was restricted.
 */
describe('TwitterPublisher — reply settings', () => {
  let publisher: TwitterPublisher;
  let createTweet: jest.Mock;

  beforeEach(async () => {
    createTweet = jest.fn().mockResolvedValue({ id: '1', text: 'hi' });

    const moduleRef = await Test.createTestingModule({
      providers: [
        TwitterPublisher,
        { provide: TwitterService, useValue: { createTweet, uploadMedia: jest.fn() } },
      ],
    }).compile();

    publisher = moduleRef.get(TwitterPublisher);
  });

  const options = (metadata: Record<string, any>) => ({
    content: 'Iced Spanish latte is back',
    mediaItems: [],
    accessToken: 'token',
    platformAccountId: 'acct',
    channelMetadata: {},
    channelId: 1,
    metadata,
  });

  it('forwards a restriction X accepts', async () => {
    await publisher.publish(options({ replyControl: 'mentionedUsers' }));

    expect(createTweet).toHaveBeenCalledWith(
      'token',
      'Iced Spanish latte is back',
      expect.objectContaining({ replySettings: 'mentionedUsers' }),
    );
  });

  // The one that matters. `everyone` is a value X RETURNS, not one it
  // accepts — sending it fails the request, so "anyone may reply" has to
  // reach the API as an absent field.
  it('sends nothing for `everyone`, which X would reject', async () => {
    await publisher.publish(options({ replyControl: 'everyone' }));

    const [, , opts] = createTweet.mock.calls[0];
    expect(opts.replySettings).toBeUndefined();
  });

  it('drops a value X does not know rather than failing the post', async () => {
    await publisher.publish(options({ replyControl: 'mentioned_only' }));

    const [, , opts] = createTweet.mock.calls[0];
    expect(opts.replySettings).toBeUndefined();
  });

  it('omits it entirely when nothing was chosen', async () => {
    await publisher.publish(options({}));

    const [, , opts] = createTweet.mock.calls[0];
    expect(opts.replySettings).toBeUndefined();
  });

  // X applies a conversation's reply rules from the post that STARTS it.
  // Sending the setting on a reply would restrict replies to that reply.
  it('sets it on the thread root only', async () => {
    createTweet
      .mockResolvedValueOnce({ id: 'root', text: 'one' })
      .mockResolvedValueOnce({ id: 'second', text: 'two' });

    await publisher.publish(
      options({
        replyControl: 'verified',
        thread: [{ text: 'one' }, { text: 'two' }],
      }),
    );

    expect(createTweet.mock.calls[0][2].replySettings).toBe('verified');
    expect(createTweet.mock.calls[1][2].replySettings).toBeUndefined();
    expect(createTweet.mock.calls[1][2].replyToTweetId).toBe('root');
  });
});

/**
 * The two disclosure booleans. Both are claims about the post that a reader
 * sees, so the failure that matters is sending one nobody asked for — and,
 * on a thread, failing to send one that was.
 */
describe('TwitterPublisher — disclosures', () => {
  let publisher: TwitterPublisher;
  let createTweet: jest.Mock;

  beforeEach(async () => {
    createTweet = jest.fn().mockResolvedValue({ id: '1', text: 'hi' });

    const moduleRef = await Test.createTestingModule({
      providers: [
        TwitterPublisher,
        {
          provide: TwitterService,
          useValue: { createTweet, uploadMedia: jest.fn() },
        },
      ],
    }).compile();

    publisher = moduleRef.get(TwitterPublisher);
  });

  const options = (metadata: Record<string, any>) => ({
    content: 'Iced Spanish latte is back',
    mediaItems: [],
    accessToken: 'token',
    platformAccountId: 'acct',
    channelMetadata: {},
    channelId: 1,
    metadata,
  });

  it('forwards each disclosure that was set', async () => {
    await publisher.publish(
      options({ madeWithAi: true, paidPartnership: true }),
    );

    const [, , opts] = createTweet.mock.calls[0];
    expect(opts.madeWithAi).toBe(true);
    expect(opts.paidPartnership).toBe(true);
  });

  it('forwards one without inventing the other', async () => {
    await publisher.publish(options({ madeWithAi: true }));

    const [, , opts] = createTweet.mock.calls[0];
    expect(opts.madeWithAi).toBe(true);
    expect('paidPartnership' in opts).toBe(false);
  });

  // A disclosure is a claim about the post. `false` and absent mean the same
  // thing to X, so an untouched toggle must not put a key in the body at
  // all — the schema is `additionalProperties: false` and the field is one
  // we would rather never send than send wrongly.
  it.each([
    ['untouched', {}],
    ['switched off', { madeWithAi: false, paidPartnership: false }],
    ['a non-boolean', { madeWithAi: 'yes', paidPartnership: 1 }],
  ])('sends no disclosure when %s', async (_label, metadata) => {
    await publisher.publish(options(metadata));

    const [, , opts] = createTweet.mock.calls[0];
    expect('madeWithAi' in opts).toBe(false);
    expect('paidPartnership' in opts).toBe(false);
  });

  // The contrast with `reply_settings`, which the root alone carries.
  // `made_with_ai` describes the media on the post carrying it, and the
  // composer offers ONE toggle for the thread — so every post needs it, or
  // posts 2..N publish undisclosed.
  it('repeats the disclosure on every post in a thread', async () => {
    createTweet
      .mockResolvedValueOnce({ id: 'root', text: 'one' })
      .mockResolvedValueOnce({ id: 'second', text: 'two' })
      .mockResolvedValueOnce({ id: 'third', text: 'three' });

    await publisher.publish(
      options({
        madeWithAi: true,
        thread: [{ text: 'one' }, { text: 'two' }, { text: 'three' }],
      }),
    );

    expect(createTweet).toHaveBeenCalledTimes(3);
    for (const call of createTweet.mock.calls) {
      expect(call[2].madeWithAi).toBe(true);
    }
  });
});
