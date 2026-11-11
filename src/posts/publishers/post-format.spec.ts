/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- test doubles are loosely typed */
import { BlueskyPublisher } from './bluesky.publisher';
import { MastodonPublisher } from './mastodon.publisher';
import { ThreadsPublisher } from './threads.publisher';
import { TwitterPublisher } from './twitter.publisher';
import { isPollAllowed, postTypeOf, threadToPublish } from './post-format';

/**
 * D3: switching format in the composer leaves the other formats' fields in
 * the draft. What publishes must follow the format the person picked
 * (`platformSpecific.postType`), never whatever happens to be stored.
 */

const THREAD = [{ text: 'first' }, { text: 'second' }, { text: 'third' }];
const CAPTION = 'Iced Spanish latte is back';

describe('post-format helpers', () => {
  it('reads the format, treating blank as absent', () => {
    expect(postTypeOf({ postType: 'thread' })).toBe('thread');
    expect(postTypeOf({ postType: '  ' })).toBeUndefined();
    expect(postTypeOf({})).toBeUndefined();
    expect(postTypeOf(undefined)).toBeUndefined();
  });

  it.each([
    ['post', undefined],
    ['poll', undefined],
    ['carousel', undefined],
    ['thread', THREAD],
  ])('a stored thread on format %s publishes %p', (postType, expected) => {
    expect(threadToPublish({ postType, thread: THREAD })).toEqual(expected);
  });

  it('keeps the old behaviour when no format was stored', () => {
    expect(threadToPublish({ thread: THREAD })).toEqual(THREAD);
    expect(threadToPublish({ thread: [THREAD[0]] })).toBeUndefined();
    expect(isPollAllowed({})).toBe(true);
  });

  it.each([
    ['post', false],
    ['thread', false],
    ['poll', true],
  ])('a stored poll on format %s may be sent: %p', (postType, expected) => {
    expect(isPollAllowed({ postType })).toBe(expected);
  });
});

/** Every publisher's options, with the format's fields under `metadata`. */
const options = (metadata: Record<string, any>, extra: object = {}) =>
  ({
    content: CAPTION,
    mediaItems: [],
    accessToken: 'token',
    platformAccountId: 'acct',
    channelMetadata: {
      did: 'did:plc:abc',
      instanceUrl: 'https://mastodon.test',
    },
    channelId: 1,
    metadata,
    ...extra,
  }) as any;

interface Harness {
  name: string;
  /** Publishes and returns the texts posted, in order. */
  posted: (metadata: Record<string, any>) => Promise<string[]>;
  /** The poll handed to the API on the last single post, if any. */
  lastPoll?: () => unknown;
  /** A poll in the publisher's own stored shape. */
  poll?: Record<string, unknown>;
}

function twitter(): Harness {
  const createTweet = jest.fn(async () => ({ id: String(Math.random()) }));
  const publisher = new TwitterPublisher({
    createTweet,
    uploadMedia: jest.fn(),
    lookupUserIds: jest.fn(),
  } as any);
  return {
    name: 'X',
    posted: async (metadata) => {
      await publisher.publish(options(metadata));
      return createTweet.mock.calls.map((c: any[]) => c[1]);
    },
    lastPoll: () => (createTweet.mock.calls.at(-1) as any[])[2].poll,
    poll: { options: ['Yes', 'No'], durationMinutes: 60 },
  };
}

function threads(): Harness {
  const createTextThread = jest.fn(async () => ({
    postId: String(Math.random()),
  }));
  const publisher = new ThreadsPublisher({
    createTextThread,
    createImageThread: jest.fn(),
    createVideoThread: jest.fn(),
    createCarouselThread: jest.fn(),
    findOwnPostByLink: jest.fn(),
  } as any);
  return {
    name: 'Threads',
    posted: async (metadata) => {
      await publisher.publish(options(metadata));
      return createTextThread.mock.calls.map((c: any[]) => c[2]);
    },
    lastPoll: () => (createTextThread.mock.calls.at(-1) as any[])[4]?.poll,
    poll: { options: ['Yes', 'No'] },
  };
}

function bluesky(): Harness {
  let n = 0;
  const createTextPost = jest.fn(async () => {
    n += 1;
    return { uri: `at://${n}`, cid: `cid-${n}` };
  });
  const publisher = new BlueskyPublisher({
    createTextPost,
    createImagePost: jest.fn(),
    createVideoPost: jest.fn(),
    createLinkPost: jest.fn(),
    setPostReplyControl: jest.fn(),
    setPostQuoteControl: jest.fn(),
  } as any);
  return {
    name: 'Bluesky',
    posted: async (metadata) => {
      await publisher.publish(options(metadata));
      return createTextPost.mock.calls.map((c: any[]) => c[2]);
    },
  };
}

function mastodon(): Harness {
  const createStatus = jest.fn(async () => ({
    id: String(Math.random()),
    url: 'https://mastodon.test/1',
  }));
  const publisher = new MastodonPublisher({
    createStatus,
    uploadMedia: jest.fn(),
    getApiVersion: jest.fn(),
    resolveStatusUrl: jest.fn(),
  } as any);
  return {
    name: 'Mastodon',
    posted: async (metadata) => {
      await publisher.publish(options(metadata));
      return createStatus.mock.calls.map((c: any[]) => c[2]);
    },
    lastPoll: () => (createStatus.mock.calls.at(-1) as any[])[3].poll,
    poll: { options: ['Yes', 'No'], expiresInSeconds: 86400 },
  };
}

const ALL = [twitter, threads, bluesky, mastodon];
const WITH_POLL = [twitter, threads, mastodon];

describe.each(ALL)('a stale thread (%p)', (make) => {
  it('is not published once the format is switched back to Post', async () => {
    const h = make();
    const texts = await h.posted({ postType: 'post', thread: THREAD });
    expect(texts).toEqual([CAPTION]);
  });

  it('is published as a chain when the format is Thread', async () => {
    const h = make();
    const texts = await h.posted({ postType: 'thread', thread: THREAD });
    expect(texts.map((t) => t.replace(/ \d+\/\d+$/, ''))).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  it('is still published on a row with no format stored (legacy)', async () => {
    const h = make();
    const texts = await h.posted({ thread: THREAD });
    expect(texts).toHaveLength(3);
  });
});

describe.each(WITH_POLL)('a stale poll (%p)', (make) => {
  it('is not sent once the format is switched to Post', async () => {
    const h = make();
    const texts = await h.posted({ postType: 'post', poll: h.poll });
    expect(texts).toEqual([CAPTION]);
    expect(h.lastPoll!()).toBeUndefined();
  });

  it('is not sent on a Thread either', async () => {
    const h = make();
    const texts = await h.posted({
      postType: 'thread',
      thread: THREAD,
      poll: h.poll,
    });
    expect(texts).toHaveLength(3);
    expect(h.lastPoll!()).toBeUndefined();
  });

  it('is sent when the format is Poll, even with a stale thread beside it', async () => {
    const h = make();
    const texts = await h.posted({
      postType: 'poll',
      thread: THREAD,
      poll: h.poll,
    });
    expect(texts).toEqual([CAPTION]);
    expect(h.lastPoll!()).toBeDefined();
  });
});
