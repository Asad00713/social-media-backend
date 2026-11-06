import { Test } from '@nestjs/testing';
import { BlueskyPublisher } from './bluesky.publisher';
import { BlueskyService } from '../../channels/services/bluesky.service';

/**
 * Language and reply control reaching the service.
 *
 * The case worth writing down is the threadgate's timing: it is a SECOND
 * record, written after the post exists, so a failure there happens when
 * the post is already live.
 */
describe('BlueskyPublisher — post settings', () => {
  let publisher: BlueskyPublisher;
  let createTextPost: jest.Mock;
  let setPostReplyControl: jest.Mock;
  let setPostQuoteControl: jest.Mock;

  beforeEach(async () => {
    createTextPost = jest.fn().mockResolvedValue({
      uri: 'at://did:plc:me/app.bsky.feed.post/abc',
      cid: 'cid-1',
    });
    setPostReplyControl = jest.fn().mockResolvedValue(undefined);
    setPostQuoteControl = jest.fn().mockResolvedValue(undefined);

    const moduleRef = await Test.createTestingModule({
      providers: [
        BlueskyPublisher,
        {
          provide: BlueskyService,
          useValue: {
            createTextPost,
            setPostReplyControl,
            setPostQuoteControl,
            createImagePost: jest.fn(),
            createVideoPost: jest.fn(),
          },
        },
      ],
    }).compile();

    publisher = moduleRef.get(BlueskyPublisher);
  });

  const options = (metadata: Record<string, any>) => ({
    content: 'Iced Spanish latte is back',
    mediaItems: [],
    accessToken: 'jwt',
    platformAccountId: 'did:plc:me',
    channelMetadata: { did: 'did:plc:me', handle: 'me.bsky.social' },
    channelId: 1,
    metadata,
  });

  it('sends the chosen language', async () => {
    await publisher.publish(options({ language: 'ur' }));

    expect(createTextPost.mock.calls[0][4].langs).toEqual(['ur']);
  });

  it('writes a threadgate for a restriction', async () => {
    await publisher.publish(
      options({ replyControl: 'custom', replyRules: { following: true } }),
    );

    expect(setPostReplyControl).toHaveBeenCalledWith(
      'jwt',
      'did:plc:me',
      'at://did:plc:me/app.bsky.feed.post/abc',
      ['app.bsky.feed.threadgate#followingRule'],
    );
  });

  // Writing an empty `allow` here would mean NOBODY may reply, so an
  // unrestricted post must write no record at all.
  it.each([
    ['everybody is chosen', { replyControl: 'everybody' }],
    ['nothing was chosen', {}],
  ])('writes no threadgate when %s', async (_label, metadata) => {
    await publisher.publish(options(metadata));

    expect(setPostReplyControl).not.toHaveBeenCalled();
  });

  // The post is already live when the threadgate is written. Failing the
  // publish would report a failure for something that succeeded, and
  // invite a retry that posts a second time.
  it('still reports success when the threadgate fails', async () => {
    setPostReplyControl.mockRejectedValue(new Error('upstream 502'));

    const result = await publisher.publish(
      options({ replyControl: 'nobody' }),
    );

    expect(result.platformPostId).toBe(
      'at://did:plc:me/app.bsky.feed.post/abc',
    );
  });

  describe('quote posts', () => {
    const DISABLE = [{ $type: 'app.bsky.feed.postgate#disableRule' }];

    it('writes a postgate when quoting is turned off', async () => {
      await publisher.publish(options({ allowQuotes: false }));

      expect(setPostQuoteControl).toHaveBeenCalledTimes(1);
      expect(setPostQuoteControl).toHaveBeenCalledWith(
        'jwt',
        'did:plc:me',
        'at://did:plc:me/app.bsky.feed.post/abc',
        DISABLE,
      );
    });

    // Allowing quotes is the ABSENCE of a record. A string 'false' or any
    // other junk must not be read as the author switching quotes off.
    it.each([
      ['quotes are allowed', { allowQuotes: true }],
      ['nothing was chosen', {}],
      ['the value is not a boolean', { allowQuotes: 'false' }],
    ])('writes no postgate when %s', async (_label, metadata) => {
      await publisher.publish(options(metadata));

      expect(setPostQuoteControl).not.toHaveBeenCalled();
    });

    it('is independent of the reply control', async () => {
      await publisher.publish(
        options({ allowQuotes: false, replyControl: 'nobody' }),
      );

      expect(setPostQuoteControl).toHaveBeenCalledTimes(1);
      expect(setPostReplyControl).toHaveBeenCalledTimes(1);
    });

    // Same reasoning as the threadgate: the post is already live.
    it('still reports success when the postgate fails', async () => {
      setPostQuoteControl.mockRejectedValue(new Error('upstream 502'));

      const result = await publisher.publish(options({ allowQuotes: false }));

      expect(result.platformPostId).toBe(
        'at://did:plc:me/app.bsky.feed.post/abc',
      );
    });

    it('does not let a failed threadgate skip the postgate', async () => {
      setPostReplyControl.mockRejectedValue(new Error('upstream 502'));

      await publisher.publish(
        options({ allowQuotes: false, replyControl: 'nobody' }),
      );

      expect(setPostQuoteControl).toHaveBeenCalledTimes(1);
    });
  });

  describe('content warning', () => {
    it('sends the chosen label as a self-label setting', async () => {
      await publisher.publish(options({ contentWarning: 'graphic-media' }));

      expect(createTextPost.mock.calls[0][4].labels).toEqual(['graphic-media']);
    });

    // The Mastodon-style free text must not turn into a label: the lexicon
    // would accept any string, and Bluesky would then show a made-up one.
    it.each([
      ['free text', 'spoilers for the finale'],
      ['a moderation directive', '!hide'],
      ['an empty string', ''],
      ['a non-string', 7],
    ])('sends no label for %s', async (_label, contentWarning) => {
      await publisher.publish(options({ contentWarning }));

      expect(createTextPost.mock.calls[0][4].labels).toBeUndefined();
    });
  });

  describe('in a thread', () => {
    beforeEach(() => {
      createTextPost
        .mockResolvedValueOnce({
          uri: 'at://did:plc:me/app.bsky.feed.post/root',
          cid: 'cid-root',
        })
        .mockResolvedValueOnce({
          uri: 'at://did:plc:me/app.bsky.feed.post/second',
          cid: 'cid-2',
        });
    });

    const threadOptions = () =>
      options({
        language: 'ur',
        replyControl: 'nobody',
        thread: [{ text: 'one' }, { text: 'two' }],
      });

    // Each post is its own record, and each is in that language.
    it('sets the language on every post', async () => {
      await publisher.publish(threadOptions());

      expect(createTextPost.mock.calls[0][4].langs).toEqual(['ur']);
      expect(createTextPost.mock.calls[1][4].langs).toEqual(['ur']);
    });

    // A postgate governs one POST (who may embed it), so each post of the
    // thread gets its own — unlike the threadgate below.
    it('writes a postgate on every post when quoting is off', async () => {
      await publisher.publish(
        options({
          allowQuotes: false,
          thread: [{ text: 'one' }, { text: 'two' }],
        }),
      );

      expect(setPostQuoteControl).toHaveBeenCalledTimes(2);
      expect(setPostQuoteControl.mock.calls.map((c) => c[2])).toEqual([
        'at://did:plc:me/app.bsky.feed.post/root',
        'at://did:plc:me/app.bsky.feed.post/second',
      ]);
    });

    it('writes no postgate on a thread that allows quotes', async () => {
      await publisher.publish(threadOptions());

      expect(setPostQuoteControl).not.toHaveBeenCalled();
    });

    // The design drops the content-warning row in a thread, so a label left
    // over from before the author switched format must not publish unseen.
    it('does not label any post of a thread', async () => {
      await publisher.publish(
        options({
          contentWarning: 'porn',
          language: 'ur',
          thread: [{ text: 'one' }, { text: 'two' }],
        }),
      );

      expect(createTextPost.mock.calls[0][4].labels).toBeUndefined();
      expect(createTextPost.mock.calls[1][4].labels).toBeUndefined();
      // ...while the rest of the settings still ride along.
      expect(createTextPost.mock.calls[1][4].langs).toEqual(['ur']);
    });

    // But a threadgate governs the CONVERSATION, so only the post that
    // starts it carries one.
    it('gates the root only', async () => {
      await publisher.publish(threadOptions());

      expect(setPostReplyControl).toHaveBeenCalledTimes(1);
      expect(setPostReplyControl.mock.calls[0][2]).toBe(
        'at://did:plc:me/app.bsky.feed.post/root',
      );
    });
  });
});
