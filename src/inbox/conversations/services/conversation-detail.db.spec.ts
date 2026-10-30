import { NotFoundException, BadRequestException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { DbType } from '../../../drizzle/db';
import { WorkspaceRoleService } from '../../../workspace-members/workspace-role.service';
import {
  describeInboxDb,
  seedChannel,
  seedItem,
  seedMember,
  seedWorkspace,
  withInboxDb,
} from '../../testing/inbox-db';
import { ConversationDetailService } from './conversation-detail.service';
import { ConversationPresenter } from './conversation-presenter.service';

const NOW = new Date('2026-10-26T12:00:00Z');
const at = (min: number) => new Date(NOW.getTime() - (600 - min) * 60_000);

function service(db: DbType): ConversationDetailService {
  return new ConversationDetailService(
    db,
    new ConversationPresenter(db),
    new WorkspaceRoleService(db),
  );
}

async function seedConv(
  client: PoolClient,
  workspaceId: string,
  channelId: number,
  platform: string,
  kind: 'dm' | 'comment_thread' | 'mention',
  threadKey: string,
  over: {
    postId?: string | null;
    participantPlatformId?: string | null;
    handle?: string | null;
    name?: string | null;
    closes?: Date | null;
  } = {},
): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO inbox_conversations
       (workspace_id, channel_id, platform, kind, thread_key, status,
        last_message_at, last_snippet, post_id, participant_platform_id,
        participant_handle, participant_name, reply_window_closes_at)
     VALUES ($1,$2,$3,$4,$5,'to_reply','2026-10-26T10:00:00Z','hi',$6,$7,$8,$9,$10)
     RETURNING id`,
    [
      workspaceId,
      channelId,
      platform,
      kind,
      threadKey,
      over.postId ?? null,
      over.participantPlatformId ?? null,
      over.handle ?? null,
      over.name ?? null,
      over.closes ?? null,
    ],
  );
  return r.rows[0].id;
}

/** Counts the SQL statements a block runs, and those reading the users table. */
async function countQueries<T>(
  client: PoolClient,
  fn: () => Promise<T>,
): Promise<{ result: T; total: number; usersReads: number }> {
  const original = client.query.bind(client) as (...a: unknown[]) => unknown;
  const seen: string[] = [];
  (client as unknown as { query: unknown }).query = (...args: unknown[]) => {
    const first = args[0];
    seen.push(
      typeof first === 'string'
        ? first
        : ((first as { text: string }).text ?? ''),
    );
    return original(...args);
  };
  try {
    const result = await fn();
    return {
      result,
      total: seen.length,
      usersReads: seen.filter((q) => /from "users"/i.test(q)).length,
    };
  } finally {
    (client as unknown as { query: unknown }).query = original;
  }
}

describeInboxDb('ConversationDetailService', () => {
  it('builds a 300-comment thread with ONE users query and a size-independent budget', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const mate = await seedMember(client, workspaceId, 'MEMBER', {
        name: 'Mate',
      });
      const ch = await seedChannel(client, workspaceId, 'facebook', {
        username: '@daybreak.coffee',
      });
      const conv = await seedConv(
        client,
        workspaceId,
        ch,
        'facebook',
        'comment_thread',
        `${ch}:p1`,
      );
      for (let i = 0; i < 300; i++) {
        await seedItem(client, {
          workspaceId,
          channelId: ch,
          platform: 'facebook',
          type: 'comment',
          platformPostId: 'p1',
          platformItemId: `c${i}`,
          platformParentId: i % 3 === 0 ? null : `c${i - 1}`,
          fromMe: i % 10 === 5,
          authoredByUserId: i % 10 === 5 ? mate : null,
          text: `comment ${i}`,
          authorHandle: `h${i}`,
          platformCreatedAt: new Date(NOW.getTime() - (300 - i) * 1000),
        });
      }
      const svc = service(db);
      const big = await countQueries(client, () =>
        svc.getDetail(workspaceId, conv, ownerId, NOW),
      );
      const count = (nodes: { replies: unknown[] }[]): number =>
        nodes.reduce(
          (n, x) => n + 1 + count(x.replies as { replies: unknown[] }[]),
          0,
        );
      expect(count(big.result.comments ?? [])).toBe(300);
      expect(big.usersReads).toBe(1);

      // The same call on a one-comment thread runs the same number of queries.
      const conv2 = await seedConv(
        client,
        workspaceId,
        ch,
        'facebook',
        'comment_thread',
        `${ch}:p2`,
      );
      await seedItem(client, {
        workspaceId,
        channelId: ch,
        platform: 'facebook',
        type: 'comment',
        platformPostId: 'p2',
        platformItemId: 'only',
        authoredByUserId: mate,
        fromMe: true,
        platformCreatedAt: at(1),
      });
      const small = await countQueries(client, () =>
        svc.getDetail(workspaceId, conv2, ownerId, NOW),
      );
      expect(small.total).toBe(big.total);
      expect(big.result.comments?.[0].sentBy).toBeNull();
    }));

  it('puts a dm timeline in time order: messages, a note and a failed queued reply; sent and cancelled stay out', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const mate = await seedMember(client, workspaceId, 'MEMBER', {
        name: 'Mate',
      });
      const ch = await seedChannel(client, workspaceId, 'facebook');
      const key = `${ch}:dm1`;
      const conv = await seedConv(
        client,
        workspaceId,
        ch,
        'facebook',
        'dm',
        key,
        {
          handle: 'sam',
          name: 'Sam',
          closes: new Date(NOW.getTime() + 3 * 3600_000),
        },
      );
      await seedItem(client, {
        workspaceId,
        channelId: ch,
        platform: 'facebook',
        type: 'dm',
        conversationId: 'dm1',
        text: 'hello',
        platformCreatedAt: at(1),
        metadata: { authorProfileUrl: 'https://fb.example/sam' },
      });
      await seedItem(client, {
        workspaceId,
        channelId: ch,
        platform: 'facebook',
        type: 'dm',
        conversationId: 'dm1',
        fromMe: true,
        authoredByUserId: mate,
        text: 'hi Sam',
        platformCreatedAt: at(3),
      });
      await client.query(
        `INSERT INTO inbox_notes (conversation_id, workspace_id, author_user_id, body)
         VALUES ($1,$2,$3,'internal') `,
        [conv, workspaceId, mate],
      );
      await client.query(
        `UPDATE inbox_notes SET created_at = $2 WHERE conversation_id = $1`,
        [conv, at(2)],
      );
      const queue = (status: string, when: Date) =>
        client.query(
          `INSERT INTO scheduled_inbox_messages
             (workspace_id, channel_id, type, thread_key, text, scheduled_at,
              status, inbox_conversation_id, created_by_user_id)
           VALUES ($1,$2,'dm',$3,$4,$5,$6,$7,$8)`,
          [workspaceId, ch, key, `q-${status}`, when, status, conv, mate],
        );
      await queue('failed', at(4));
      await queue('sent', at(5));
      await queue('cancelled', at(6));

      const d = await service(db).getDetail(workspaceId, conv, ownerId, NOW);
      expect(d.timeline.map((e) => e.kind)).toEqual([
        'message',
        'note',
        'message',
        'scheduled',
      ]);
      expect(d.comments).toBeNull();
      expect(d.post).toBeNull();
      expect(d.participant).toEqual({
        handle: 'sam',
        displayName: 'Sam',
        avatarUrl: null,
        profileUrl: 'https://fb.example/sam',
      });
      const sent = d.timeline[2];
      expect(sent.kind === 'message' && sent.canDelete).toBe(true);
      expect(sent.kind === 'message' && sent.sentBy?.name).toBe('Mate');
      const note = d.timeline[1];
      expect(note.kind === 'note' && note.canDelete).toBe(false);
      expect(d.canSendLater).toBe(true);
      expect(d.latestSendLaterAt).toBe(
        new Date(NOW.getTime() + 3 * 3600_000 - 60_000).toISOString(),
      );
    }));

  it('a GUEST cannot delete messages', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId } = await seedWorkspace(client);
      const guest = await seedMember(client, workspaceId, 'GUEST');
      const ch = await seedChannel(client, workspaceId, 'facebook');
      const conv = await seedConv(
        client,
        workspaceId,
        ch,
        'facebook',
        'dm',
        `${ch}:g`,
      );
      await seedItem(client, {
        workspaceId,
        channelId: ch,
        platform: 'facebook',
        type: 'dm',
        conversationId: 'g',
        fromMe: true,
        platformCreatedAt: at(1),
      });
      const d = await service(db).getDetail(workspaceId, conv, guest, NOW);
      const m = d.timeline[0];
      expect(m.kind === 'message' && m.canDelete).toBe(false);
    }));

  describe('viewer rights', () => {
    async function seedDm(client: PoolClient) {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const ch = await seedChannel(client, workspaceId, 'facebook');
      const dm = await seedConv(
        client,
        workspaceId,
        ch,
        'facebook',
        'dm',
        `${ch}:v`,
      );
      await seedItem(client, {
        workspaceId,
        channelId: ch,
        platform: 'facebook',
        type: 'dm',
        conversationId: 'v',
        fromMe: true,
        platformCreatedAt: at(1),
      });
      const th = await seedConv(
        client,
        workspaceId,
        ch,
        'facebook',
        'comment_thread',
        `${ch}:pv`,
      );
      await seedItem(client, {
        workspaceId,
        channelId: ch,
        platform: 'facebook',
        type: 'comment',
        platformPostId: 'pv',
        text: 'c',
        platformCreatedAt: at(1),
      });
      return { workspaceId, ownerId, dm, th };
    }

    it('a non-member platform SUPER_ADMIN gets a read-only detail with no guest text', () =>
      withInboxDb(async (db, client) => {
        const { workspaceId, dm, th } = await seedDm(client);
        const sa = await client.query<{ id: string }>(
          `INSERT INTO users (email, name, role) VALUES ($1,'Root','SUPER_ADMIN') RETURNING id`,
          [`sa-${Math.random().toString(36).slice(2)}@example.test`],
        );
        const svc = service(db);
        const thread = await svc.getDetail(workspaceId, th, sa.rows[0].id, NOW);
        const actions = thread.comments?.[0].actions;
        expect(actions).toStrictEqual({
          reply: { allowed: false },
          like: { allowed: false },
          hide: { allowed: false },
          delete: { allowed: false },
          privateReply: { allowed: false },
        });
        const msg = (await svc.getDetail(workspaceId, dm, sa.rows[0].id, NOW))
          .timeline[0];
        expect(msg.kind === 'message' && msg.canDelete).toBe(false);
      }));

    it('a member ADMIN keeps full rights', () =>
      withInboxDb(async (db, client) => {
        const { workspaceId, dm, th } = await seedDm(client);
        const admin = await seedMember(client, workspaceId, 'ADMIN');
        const svc = service(db);
        const thread = await svc.getDetail(workspaceId, th, admin, NOW);
        expect(thread.comments?.[0].actions.reply.allowed).toBe(true);
        const msg = (await svc.getDetail(workspaceId, dm, admin, NOW))
          .timeline[0];
        expect(msg.kind === 'message' && msg.canDelete).toBe(true);
      }));
  });

  it('merges the post snapshot field by field, prefers the target publishedAt, and excludes hidden comments from answered', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const ch = await seedChannel(client, workspaceId, 'facebook');
      const post = await client.query<{ id: string }>(
        `INSERT INTO posts (workspace_id, created_by_id, content, media_items, status, published_at, targets)
         VALUES ($1,$2,NULL,'[]'::jsonb,'published','2026-10-20T00:00:00Z',$3::jsonb) RETURNING id`,
        [
          workspaceId,
          ownerId,
          JSON.stringify([
            {
              channelId: String(ch),
              platform: 'facebook',
              status: 'published',
              publishedAt: '2026-10-25T09:00:00Z',
            },
          ]),
        ],
      );
      const conv = await seedConv(
        client,
        workspaceId,
        ch,
        'facebook',
        'comment_thread',
        `${ch}:pm`,
        {
          postId: post.rows[0].id,
        },
      );
      const a = await seedItem(client, {
        workspaceId,
        channelId: ch,
        platform: 'facebook',
        type: 'comment',
        platformPostId: 'pm',
        platformItemId: 'a',
        platformCreatedAt: at(1),
        metadata: {
          post: { caption: 'From snapshot', thumbnailUrl: 'https://s/t.jpg' },
        },
      });
      const h = await seedItem(client, {
        workspaceId,
        channelId: ch,
        platform: 'facebook',
        type: 'comment',
        platformPostId: 'pm',
        platformItemId: 'h',
        platformCreatedAt: at(2),
      });
      await client.query(
        `UPDATE inbox_items SET is_hidden = true WHERE id = $1`,
        [h.id],
      );
      expect(a.id).toBeDefined();
      const d = await service(db).getDetail(workspaceId, conv, ownerId, NOW);
      expect(d.post).toMatchObject({
        caption: 'From snapshot',
        thumbnailUrl: 'https://s/t.jpg',
        publishedAt: '2026-10-25T09:00:00.000Z',
        answered: { answered: 0, total: 1 },
      });
    }));

  it('marks a redacted YouTube comment', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const ch = await seedChannel(client, workspaceId, 'youtube');
      const conv = await seedConv(
        client,
        workspaceId,
        ch,
        'youtube',
        'comment_thread',
        `${ch}:v1`,
      );
      await seedItem(client, {
        workspaceId,
        channelId: ch,
        platform: 'youtube',
        type: 'comment',
        platformPostId: 'v1',
        text: null,
        platformCreatedAt: at(1),
      });
      const d = await service(db).getDetail(workspaceId, conv, ownerId, NOW);
      expect(d.comments?.[0]).toMatchObject({
        contentRedacted: true,
        text: '',
      });
      expect(d.post?.surfaceLabel).toBe('YouTube · Video');
    }));

  it('nests our replies under a mention and fills the mention block', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const ch = await seedChannel(client, workspaceId, 'threads');
      const key = `${ch}:mention:m1`;
      const conv = await seedConv(
        client,
        workspaceId,
        ch,
        'threads',
        'mention',
        key,
        {
          handle: 'pat',
          name: 'Pat',
        },
      );
      await seedItem(client, {
        workspaceId,
        channelId: ch,
        platform: 'threads',
        type: 'mention',
        platformItemId: 'm1',
        text: '@us nice',
        platformCreatedAt: at(1),
        metadata: { permalink: 'https://t.example/m1', likeCount: 4 },
      });
      await seedItem(client, {
        workspaceId,
        channelId: ch,
        platform: 'threads',
        type: 'mention',
        platformItemId: 'r1',
        platformParentId: 'm1',
        fromMe: true,
        text: 'thanks',
        platformCreatedAt: at(2),
        metadata: { mentionRoot: 'm1' },
      });
      const d = await service(db).getDetail(workspaceId, conv, ownerId, NOW);
      expect(d.comments).toHaveLength(1);
      expect(d.comments?.[0].replies).toHaveLength(1);
      expect(d.mention).toEqual({
        text: '@us nice',
        permalink: 'https://t.example/m1',
        likes: 4,
        replies: 1,
      });
    }));

  it('hidden inbound carries is_hidden but does not change participant facts', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const ch = await seedChannel(client, workspaceId, 'threads');
      const key = `${ch}:mention:m1`;
      const conv = await seedConv(
        client,
        workspaceId,
        ch,
        'threads',
        'mention',
        key,
        {
          handle: 'pat',
          name: 'Pat',
        },
      );
      await seedItem(client, {
        workspaceId,
        channelId: ch,
        platform: 'threads',
        type: 'mention',
        platformItemId: 'm1',
        text: 'a',
        authorHandle: 'pat',
        platformCreatedAt: at(1),
        metadata: { authorProfileUrl: 'https://t.example/pat' },
      });
      const hidden = await seedItem(client, {
        workspaceId,
        channelId: ch,
        platform: 'threads',
        type: 'mention',
        platformItemId: 'm2',
        platformParentId: 'm1',
        authorHandle: 'troll',
        text: 'b',
        platformCreatedAt: at(2),
        metadata: {
          mentionRoot: 'm1',
          authorProfileUrl: 'https://t.example/troll',
        },
      });
      await client.query(
        `UPDATE inbox_items SET is_hidden = true WHERE id = $1`,
        [hidden.id],
      );
      const d = await service(db).getDetail(workspaceId, conv, ownerId, NOW);
      expect(d.participant).toMatchObject({
        handle: 'pat',
        profileUrl: 'https://t.example/pat',
      });
      expect(d.comments?.[0].replies[0].isHidden).toBe(true);
    }));

  it('reads post, latest likes, campaign day and answered counts for a published post', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const ch = await seedChannel(client, workspaceId, 'instagram');
      const post = await client.query<{ id: string }>(
        `INSERT INTO posts (workspace_id, created_by_id, content, media_items,
                            status, published_at, targets)
         VALUES ($1,$2,'Latte art','[{"url":"https://m/v.mp4","type":"video","thumbnailUrl":"https://m/t.jpg"}]'::jsonb,
                 'published','2026-10-25T09:00:00Z', $3::jsonb) RETURNING id`,
        [
          workspaceId,
          ownerId,
          JSON.stringify([
            {
              channelId: String(ch),
              platform: 'instagram',
              status: 'published',
              platformPostUrl: 'https://ig.example/p/1',
            },
          ]),
        ],
      );
      const postId = post.rows[0].id;
      for (const [snap, likes] of [
        ['2026-10-25T10:00:00Z', 3],
        ['2026-10-26T10:00:00Z', 9],
      ] as const) {
        await client.query(
          `INSERT INTO post_metric_snapshots
             (post_id, channel_id, snapshot_at, age_bucket, likes_count, fetched_at, sync_status)
           VALUES ($1,$2,$3,'24h',$4,$3,'ok')`,
          [postId, ch, snap, likes],
        );
      }
      const camp = await client.query<{ id: string }>(
        `INSERT INTO campaigns (workspace_id, created_by_id, name, type, schedule)
         VALUES ($1,$2,'Autumn','standard','{}'::jsonb) RETURNING id`,
        [workspaceId, ownerId],
      );
      for (const [date, pid] of [
        ['2026-10-24', null],
        ['2026-10-25', postId],
      ] as const) {
        await client.query(
          `INSERT INTO campaign_slot_content
             (campaign_id, date, channel_id, time, content, post_id)
           VALUES ($1,$2,$3,'09:00','{}'::jsonb,$4)`,
          [camp.rows[0].id, date, String(ch), pid],
        );
      }
      const conv = await seedConv(
        client,
        workspaceId,
        ch,
        'instagram',
        'comment_thread',
        `${ch}:ig1`,
        { postId },
      );
      await seedItem(client, {
        workspaceId,
        channelId: ch,
        platform: 'instagram',
        type: 'comment',
        platformPostId: 'ig1',
        platformItemId: 'a',
        repliedAt: at(5),
        platformCreatedAt: at(1),
      });
      await seedItem(client, {
        workspaceId,
        channelId: ch,
        platform: 'instagram',
        type: 'comment',
        platformPostId: 'ig1',
        platformItemId: 'b',
        platformCreatedAt: at(2),
      });
      const d = await service(db).getDetail(workspaceId, conv, ownerId, NOW);
      expect(d.post).toMatchObject({
        id: postId,
        caption: 'Latte art',
        thumbnailUrl: 'https://m/t.jpg',
        mediaType: 'video',
        platformPostUrl: 'https://ig.example/p/1',
        surfaceLabel: 'Instagram · Reel',
        likes: 9,
        answered: { answered: 1, total: 2 },
        campaign: { name: 'Autumn', dayLabel: 'day 2' },
      });
    }));

  it('falls back to the items post snapshot when the thread has no post row', () =>
    withInboxDb(async (db, client) => {
      const { workspaceId, ownerId } = await seedWorkspace(client);
      const ch = await seedChannel(client, workspaceId, 'bluesky');
      const conv = await seedConv(
        client,
        workspaceId,
        ch,
        'bluesky',
        'comment_thread',
        `${ch}:at://did:plc:x/app.bsky.feed.post/y`,
      );
      await seedItem(client, {
        workspaceId,
        channelId: ch,
        platform: 'bluesky',
        type: 'comment',
        platformPostId: 'at://did:plc:x/app.bsky.feed.post/y',
        platformCreatedAt: at(1),
        metadata: { post: { caption: 'Hello sky', mediaType: 'image' } },
      });
      const d = await service(db).getDetail(workspaceId, conv, ownerId, NOW);
      expect(d.post).toMatchObject({
        id: null,
        caption: 'Hello sky',
        mediaType: 'image',
        surfaceLabel: 'Bluesky · Post',
        campaign: null,
        likes: null,
      });
    }));

  it('answers 404 for a conversation of another workspace', () =>
    withInboxDb(async (db, client) => {
      const a = await seedWorkspace(client);
      const b = await seedWorkspace(client);
      const ch = await seedChannel(client, b.workspaceId, 'facebook');
      const conv = await seedConv(
        client,
        b.workspaceId,
        ch,
        'facebook',
        'dm',
        `${ch}:x`,
      );
      const svc = service(db);
      await expect(
        svc.getDetail(a.workspaceId, conv, a.ownerId, NOW),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(svc.getProfile(a.workspaceId, conv)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    }));

  describe('getDetailByKey', () => {
    it('returns the same detail as getDetail; unknown and foreign keys are 404', () =>
      withInboxDb(async (db, client) => {
        const { workspaceId, ownerId } = await seedWorkspace(client);
        const other = await seedWorkspace(client);
        const ch = await seedChannel(client, workspaceId, 'facebook');
        const key = `${ch}:p1`;
        const conv = await seedConv(
          client,
          workspaceId,
          ch,
          'facebook',
          'comment_thread',
          key,
        );
        await seedItem(client, {
          workspaceId,
          channelId: ch,
          platform: 'facebook',
          type: 'comment',
          platformPostId: 'p1',
          text: 'x',
          platformCreatedAt: at(1),
        });
        const svc = service(db);
        const byId = await svc.getDetail(workspaceId, conv, ownerId, NOW);
        const byKey = await svc.getDetailByKey(workspaceId, key, ownerId, NOW);
        expect(byKey).toStrictEqual(byId);
        expect(byKey.row.id).toBe(conv);
        await expect(
          svc.getDetailByKey(workspaceId, `${ch}:nope`, ownerId, NOW),
        ).rejects.toBeInstanceOf(NotFoundException);
        await expect(
          svc.getDetailByKey(other.workspaceId, key, other.ownerId, NOW),
        ).rejects.toBeInstanceOf(NotFoundException);
      }));
  });

  describe('getProfile', () => {
    it('counts an author with 2 dm threads and 3 comments, newest five first', () =>
      withInboxDb(async (db, client) => {
        const { workspaceId } = await seedWorkspace(client);
        const ch = await seedChannel(client, workspaceId, 'facebook');
        const dmA = await seedConv(
          client,
          workspaceId,
          ch,
          'facebook',
          'dm',
          `${ch}:dA`,
          {
            participantPlatformId: 'sam-1',
          },
        );
        await seedConv(client, workspaceId, ch, 'facebook', 'dm', `${ch}:dB`);
        const thread = await seedConv(
          client,
          workspaceId,
          ch,
          'facebook',
          'comment_thread',
          `${ch}:post1`,
        );
        const mk = (
          type: 'dm' | 'comment',
          convId: string | null,
          postId: string | null,
          id: string,
          min: number,
        ) =>
          seedItem(client, {
            workspaceId,
            channelId: ch,
            platform: 'facebook',
            type,
            conversationId: convId,
            platformPostId: postId,
            platformItemId: id,
            authorPlatformId: 'sam-1',
            platformCreatedAt: at(min),
            metadata: postId ? { post: { caption: 'Latte art' } } : {},
          });
        await mk('dm', 'dA', null, 'i1', 1);
        await mk('dm', 'dB', null, 'i2', 2);
        await mk('comment', null, 'post1', 'i3', 3);
        await mk('comment', null, 'post1', 'i4', 4);
        await mk('comment', null, 'post1', 'i5', 5);
        // someone else, and our own reply: not Sam's
        await seedItem(client, {
          workspaceId,
          channelId: ch,
          platform: 'facebook',
          type: 'dm',
          conversationId: 'dA',
          authorPlatformId: 'someone',
          platformCreatedAt: at(6),
        });

        const p = await service(db).getProfile(workspaceId, dmA);
        expect(p.conversations).toBe(3);
        expect(p.commentsOnOurPosts).toBe(3);
        expect(p.firstMessageAt).toBe(at(1).toISOString());
        expect(p.recent).toHaveLength(5);
        expect(p.recent[0]).toEqual({
          label: 'Commented on Latte art',
          at: at(5).toISOString(),
          conversationId: thread,
        });
        expect(p.recent[4]).toMatchObject({
          label: 'Sent a message',
          conversationId: dmA,
        });
      }));

    it('labels a comment by the post row caption when no snapshot exists; foreign profile is 404', () =>
      withInboxDb(async (db, client) => {
        const { workspaceId, ownerId } = await seedWorkspace(client);
        const other = await seedWorkspace(client);
        const ch = await seedChannel(client, workspaceId, 'facebook');
        const post = await client.query<{ id: string }>(
          `INSERT INTO posts (workspace_id, created_by_id, content, status)
           VALUES ($1,$2,'Row caption','published') RETURNING id`,
          [workspaceId, ownerId],
        );
        const dm = await seedConv(
          client,
          workspaceId,
          ch,
          'facebook',
          'dm',
          `${ch}:dz`,
          {
            participantPlatformId: 'z-1',
          },
        );
        await seedConv(
          client,
          workspaceId,
          ch,
          'facebook',
          'comment_thread',
          `${ch}:pz`,
          {
            postId: post.rows[0].id,
          },
        );
        await seedItem(client, {
          workspaceId,
          channelId: ch,
          platform: 'facebook',
          type: 'comment',
          platformPostId: 'pz',
          authorPlatformId: 'z-1',
          platformCreatedAt: at(1),
        });
        const svc = service(db);
        const p = await svc.getProfile(workspaceId, dm);
        expect(p.recent[0].label).toBe('Commented on Row caption');
        await expect(
          svc.getProfile(other.workspaceId, dm),
        ).rejects.toBeInstanceOf(NotFoundException);
      }));

    it('answers 400 for a comment thread', () =>
      withInboxDb(async (db, client) => {
        const { workspaceId } = await seedWorkspace(client);
        const ch = await seedChannel(client, workspaceId, 'facebook');
        const conv = await seedConv(
          client,
          workspaceId,
          ch,
          'facebook',
          'comment_thread',
          `${ch}:p`,
        );
        await expect(
          service(db).getProfile(workspaceId, conv),
        ).rejects.toBeInstanceOf(BadRequestException);
      }));
  });
});
