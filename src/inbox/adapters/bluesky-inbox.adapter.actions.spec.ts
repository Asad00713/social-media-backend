import { BadRequestException } from '@nestjs/common';
import { BlueskyService } from '../../channels/services/bluesky.service';
import { json, mockFetch, type RecordedRequest } from '../testing/fetch-mock';
import { BlueskyInboxAdapter } from './bluesky-inbox.adapter';
import type { ResolvedChannel } from './inbox-adapter.interface';

const DID = 'did:plc:me';
const XRPC = 'https://bsky.social/xrpc';
const ROOT = `at://${DID}/app.bsky.feed.post/root1`;
const REPLY = 'at://did:plc:bob/app.bsky.feed.post/reply1';

const channel: ResolvedChannel = {
  id: 1,
  workspaceId: 'w1',
  platform: 'bluesky',
  platformAccountId: DID,
  accessToken: 'jwt',
  metadata: { did: DID },
  username: 'me.bsky.social',
  accountName: 'Me',
  profilePictureUrl: null,
};

const hasPath = (r: RecordedRequest, path: string) =>
  r.url.startsWith(`${XRPC}/${path}`);

describe('BlueskyInboxAdapter.likeComment', () => {
  const adapter = new BlueskyInboxAdapter(new BlueskyService());
  let net: ReturnType<typeof mockFetch>;
  afterEach(() => net.restore());

  it('likes with a like record using the cid already on the item', async () => {
    net = mockFetch(() => json({ uri: 'at://like/1', cid: 'x' }));
    const out = await adapter.likeComment(
      channel,
      { platformItemId: REPLY, metadata: { cid: 'bafy-known' } },
      true,
    );
    expect(net.requests).toHaveLength(1);
    expect(net.requests[0]).toMatchObject({
      method: 'POST',
      url: `${XRPC}/com.atproto.repo.createRecord`,
      body: {
        repo: DID,
        collection: 'app.bsky.feed.like',
        record: {
          $type: 'app.bsky.feed.like',
          subject: { uri: REPLY, cid: 'bafy-known' },
        },
      },
    });
    expect(out).toEqual({ likeRef: 'at://like/1' });
  });

  it('resolves the cid with getPosts when the item has none', async () => {
    net = mockFetch((req) =>
      hasPath(req, 'app.bsky.feed.getPosts')
        ? json({ posts: [{ uri: REPLY, cid: 'bafy-fetched' }] })
        : json({ uri: 'at://like/2' }),
    );
    await adapter.likeComment(
      channel,
      { platformItemId: REPLY, metadata: {} },
      true,
    );
    expect(net.requests).toHaveLength(2);
    expect(net.requests[0].url).toBe(
      `${XRPC}/app.bsky.feed.getPosts?uris=${encodeURIComponent(REPLY)}`,
    );
    expect(net.requests[1].body).toMatchObject({
      record: { subject: { uri: REPLY, cid: 'bafy-fetched' } },
    });
  });

  it('unlikes by deleting the record at metadata.likeUri', async () => {
    net = mockFetch();
    const out = await adapter.likeComment(
      channel,
      {
        platformItemId: REPLY,
        metadata: { likeUri: `at://${DID}/app.bsky.feed.like/3k` },
      },
      false,
    );
    expect(net.requests[0]).toMatchObject({
      method: 'POST',
      url: `${XRPC}/com.atproto.repo.deleteRecord`,
      body: { repo: DID, collection: 'app.bsky.feed.like', rkey: '3k' },
    });
    expect(out).toEqual({ likeRef: null });
  });

  it('unlike with no like record is a no-op', async () => {
    net = mockFetch();
    await adapter.likeComment(
      channel,
      { platformItemId: REPLY, metadata: null },
      false,
    );
    expect(net.requests).toHaveLength(0);
  });
});

describe('BlueskyInboxAdapter.hideComment (threadgate)', () => {
  const adapter = new BlueskyInboxAdapter(new BlueskyService());
  let net: ReturnType<typeof mockFetch>;
  afterEach(() => net.restore());

  const replyPosts = () =>
    json({
      posts: [
        {
          uri: REPLY,
          cid: 'c',
          record: { reply: { root: { uri: ROOT }, parent: { uri: ROOT } } },
        },
      ],
    });

  function gateServer(existing: Record<string, unknown> | null) {
    return (req: RecordedRequest) => {
      if (hasPath(req, 'app.bsky.feed.getPosts')) return replyPosts();
      if (hasPath(req, 'com.atproto.repo.getRecord')) {
        return existing
          ? json({ cid: 'gate-cid', value: existing })
          : json({ error: 'RecordNotFound' }, 400);
      }
      return json({});
    };
  }
  const putOf = (n: ReturnType<typeof mockFetch>) =>
    n.requests.find((r) => hasPath(r, 'com.atproto.repo.putRecord'));

  it('creates the threadgate WITHOUT allow when none exists', async () => {
    net = mockFetch(gateServer(null));
    await adapter.hideComment(channel, REPLY, true);
    const put = putOf(net)!;
    expect(put.body).toMatchObject({
      repo: DID,
      collection: 'app.bsky.feed.threadgate',
      rkey: 'root1',
      record: {
        $type: 'app.bsky.feed.threadgate',
        post: ROOT,
        hiddenReplies: [REPLY],
      },
    });
    expect(put.body as object).not.toHaveProperty('swapRecord');
    expect((put.body as { record: object }).record).not.toHaveProperty('allow');
  });

  it('adds to an existing threadgate and keeps its reply rules', async () => {
    net = mockFetch(
      gateServer({
        $type: 'app.bsky.feed.threadgate',
        post: ROOT,
        allow: [{ $type: 'app.bsky.feed.threadgate#mentionRule' }],
        hiddenReplies: ['at://other/1'],
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    await adapter.hideComment(channel, REPLY, true);
    expect(putOf(net)!.body).toMatchObject({
      swapRecord: 'gate-cid',
      record: {
        allow: [{ $type: 'app.bsky.feed.threadgate#mentionRule' }],
        hiddenReplies: ['at://other/1', REPLY],
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    });
  });

  it('unhides by removing the reply from hiddenReplies', async () => {
    net = mockFetch(
      gateServer({
        $type: 'app.bsky.feed.threadgate',
        post: ROOT,
        hiddenReplies: [REPLY, 'at://other/1'],
      }),
    );
    await adapter.hideComment(channel, REPLY, false);
    expect(putOf(net)!.body).toMatchObject({
      record: { hiddenReplies: ['at://other/1'] },
    });
  });

  it('is a no-op when the reply is already in the wanted state', async () => {
    net = mockFetch(gateServer({ post: ROOT, hiddenReplies: [REPLY] }));
    await adapter.hideComment(channel, REPLY, true);
    expect(putOf(net)).toBeUndefined();
  });

  it('is 400 with the 300-limit reason when the list is full', async () => {
    const full = Array.from({ length: 300 }, (_, i) => `at://other/${i}`);
    net = mockFetch(gateServer({ post: ROOT, hiddenReplies: full }));
    const err: unknown = await adapter
      .hideComment(channel, REPLY, true)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getResponse()).toEqual({
      reason: 'Bluesky lets you hide up to 300 replies per post',
    });
    expect(putOf(net)).toBeUndefined();
  });

  it('refuses to hide on a thread that is not ours', async () => {
    net = mockFetch((req) =>
      hasPath(req, 'app.bsky.feed.getPosts')
        ? json({
            posts: [
              {
                uri: REPLY,
                cid: 'c',
                record: {
                  reply: {
                    root: { uri: 'at://did:plc:other/app.bsky.feed.post/r' },
                  },
                },
              },
            ],
          })
        : json({}),
    );
    await expect(
      adapter.hideComment(channel, REPLY, true),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(putOf(net)).toBeUndefined();
  });
});
