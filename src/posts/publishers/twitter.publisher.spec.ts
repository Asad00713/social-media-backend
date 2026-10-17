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
