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

  beforeEach(async () => {
    createTextPost = jest.fn().mockResolvedValue({
      uri: 'at://did:plc:me/app.bsky.feed.post/abc',
      cid: 'cid-1',
    });
    setPostReplyControl = jest.fn().mockResolvedValue(undefined);

    const moduleRef = await Test.createTestingModule({
      providers: [
        BlueskyPublisher,
        {
          provide: BlueskyService,
          useValue: {
            createTextPost,
            setPostReplyControl,
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
