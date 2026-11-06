import { Test } from '@nestjs/testing';
import { ThreadsPublisher } from './threads.publisher';
import { ThreadsService } from '../../channels/services/threads.service';

/**
 * The five post settings Threads takes on the container-create call:
 * `reply_control`, `topic_tag`, `is_spoiler_media`,
 * `enable_reply_approvals` and `poll_attachment`.
 *
 * What these guard is the translation, since the composer's vocabulary and
 * Threads' are not the same, and every mistake here is silent in the same
 * direction: the post publishes, without the setting the author chose.
 */
describe('ThreadsPublisher — post settings', () => {
  let publisher: ThreadsPublisher;
  let createTextThread: jest.Mock;
  let createImageThread: jest.Mock;
  let createCarouselThread: jest.Mock;

  beforeEach(async () => {
    createTextThread = jest.fn().mockResolvedValue({ postId: '1' });
    createImageThread = jest.fn().mockResolvedValue({ postId: '1' });
    createCarouselThread = jest.fn().mockResolvedValue({ postId: '1' });

    const moduleRef = await Test.createTestingModule({
      providers: [
        ThreadsPublisher,
        {
          provide: ThreadsService,
          useValue: {
            createTextThread,
            createImageThread,
            createCarouselThread,
            createVideoThread: jest.fn().mockResolvedValue({ postId: '1' }),
          },
        },
      ],
    }).compile();

    publisher = moduleRef.get(ThreadsPublisher);
  });

  const options = (metadata: Record<string, any>, mediaItems: any[] = []) => ({
    content: 'Iced Spanish latte is back',
    mediaItems,
    accessToken: 'token',
    platformAccountId: 'acct',
    channelMetadata: {},
    channelId: 1,
    metadata,
  });

  /** The settings object passed to a text container create. */
  const textSettings = () => createTextThread.mock.calls[0][4];

  it('forwards a reply control the API accepts', async () => {
    await publisher.publish(options({ replyControl: 'accounts_you_follow' }));

    expect(textSettings().replyControl).toBe('accounts_you_follow');
  });

  // Same rule as the X publisher: a value the API does not know fails the
  // container create, and losing a restriction beats losing the post.
  it.each([
    ['a value from another platform', 'mentionedUsers'],
    ['an invented spelling', 'followed'],
    ['an empty string', ''],
  ])('drops %s rather than failing the post', async (_label, value) => {
    await publisher.publish(options({ replyControl: value }));

    expect(textSettings().replyControl).toBeUndefined();
  });

  it('forwards a topic tag, trimmed', async () => {
    await publisher.publish(options({ topicTag: '  photography  ' }));

    expect(textSettings().topicTag).toBe('photography');
  });

  // Meta's reference: periods and ampersands are not allowed in a topic
  // tag. Sending one fails the create, so it is dropped.
  it.each([
    ['a period', 'coffee.shop'],
    ['an ampersand', 'tea&coffee'],
  ])('drops a topic tag containing %s', async (_label, tag) => {
    await publisher.publish(options({ topicTag: tag }));

    expect(textSettings().topicTag).toBeUndefined();
  });

  it('forwards the two booleans only when true', async () => {
    await publisher.publish(
      options({ spoilerMedia: true, reviewReplies: true }),
    );

    expect(textSettings().isSpoilerMedia).toBe(true);
    expect(textSettings().enableReplyApprovals).toBe(true);
  });

  it.each([
    ['untouched', {}],
    ['switched off', { spoilerMedia: false, reviewReplies: false }],
    ['a non-boolean', { spoilerMedia: 'yes', reviewReplies: 1 }],
  ])('sends no boolean when %s', async (_label, metadata) => {
    await publisher.publish(options(metadata));

    expect('isSpoilerMedia' in textSettings()).toBe(false);
    expect('enableReplyApprovals' in textSettings()).toBe(false);
  });

  it('maps poll options onto option_a..option_d', async () => {
    await publisher.publish(
      options({ poll: { options: ['one', 'two', 'three', 'four'] } }),
    );

    expect(textSettings().poll).toEqual({
      optionA: 'one',
      optionB: 'two',
      optionC: 'three',
      optionD: 'four',
    });
  });

  // Threads requires at least two options; one fails the create.
  it.each([
    ['one option', { options: ['only'] }],
    ['a blank second option', { options: ['one', '   '] }],
    ['no options', { options: [] }],
    ['a non-array', { options: 'one,two' }],
  ])('drops a poll with %s', async (_label, poll) => {
    await publisher.publish(options({ poll }));

    expect(textSettings().poll).toBeUndefined();
  });

  it('caps each poll option at the API limit', async () => {
    await publisher.publish(
      options({ poll: { options: ['x'.repeat(40), 'y'.repeat(40)] } }),
    );

    expect(textSettings().poll.optionA).toHaveLength(25);
    expect(textSettings().poll.optionB).toHaveLength(25);
  });

  // "Polls can only be attached to text-only posts" — Meta's own words. A
  // media container has no parameter for one, so it must not be offered to
  // one: the settings type for those three containers has no `poll` field,
  // and this pins the call site that enforces it.
  it('sends no poll on a post with media', async () => {
    await publisher.publish(
      options({ poll: { options: ['one', 'two'] } }, [
        { type: 'image', url: 'https://example.test/a.jpg' },
      ]),
    );

    const settings = createImageThread.mock.calls[0][5];
    expect(settings.poll).toBeUndefined();
  });

  it('sends the settings on a carousel, which blurs every slide', async () => {
    await publisher.publish(
      options({ spoilerMedia: true, topicTag: 'coffee' }, [
        { type: 'image', url: 'https://example.test/a.jpg' },
        { type: 'image', url: 'https://example.test/b.jpg' },
      ]),
    );

    const settings = createCarouselThread.mock.calls[0][5];
    expect(settings.isSpoilerMedia).toBe(true);
    expect(settings.topicTag).toBe('coffee');
  });

  // The root starts the conversation, so it owns the reply rules and the
  // topic. Repeating them on a reply would set that reply's own rules.
  it('sets the settings on the thread root only', async () => {
    createTextThread
      .mockResolvedValueOnce({ postId: 'root' })
      .mockResolvedValueOnce({ postId: 'second' });

    await publisher.publish(
      options({
        replyControl: 'followers_only',
        topicTag: 'coffee',
        thread: [{ text: 'one' }, { text: 'two' }],
      }),
    );

    expect(createTextThread.mock.calls[0][4].replyControl).toBe(
      'followers_only',
    );
    expect(createTextThread.mock.calls[1][4]).toBeUndefined();
    expect(createTextThread.mock.calls[1][3]).toBe('root');
  });
});
