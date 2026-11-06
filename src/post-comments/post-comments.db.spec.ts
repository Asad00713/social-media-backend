import {
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { describeDb, withRollbackDb } from '../planner/testing/rollback-db';
import { seedMember, seedWorkspace } from '../inbox/testing/inbox-db';
import { PostCommentsService, isMissingTable } from './post-comments.service';

const MIGRATION = '0058_post_comments.sql';

async function seedPost(
  client: { query: (sql: string, args: unknown[]) => Promise<unknown> },
  workspaceId: string,
  userId: string,
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO posts (id, workspace_id, created_by_id, content, status)
     VALUES ($1, $2, $3, 'Draft', 'draft')`,
    [id, workspaceId, userId],
  );
  return id;
}

describe('isMissingTable', () => {
  it('finds 42P01 on the error or its cause', () => {
    expect(isMissingTable({ code: '42P01' })).toBe(true);
    expect(isMissingTable({ cause: { code: '42P01' } })).toBe(true);
    expect(isMissingTable({ code: '23505' })).toBe(false);
    expect(isMissingTable(null)).toBe(false);
  });
});

describeDb('PostCommentsService (database)', () => {
  it('writes, lists oldest first, resolves, and scopes to the workspace', async () => {
    await withRollbackDb([MIGRATION], async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const guest = await seedMember(client, ws, 'GUEST', { name: 'Gus' });
      const other = await seedWorkspace(client);
      const postId = await seedPost(client, ws, ownerId);
      const svc = new PostCommentsService(db);

      expect(await svc.list(ws, postId, ownerId, 'OWNER')).toEqual([]);
      const a = await svc.create(ws, postId, guest, 'GUEST', 'Swap the photo?');
      const b = await svc.create(ws, postId, ownerId, 'OWNER', 'Done');
      expect(a).toMatchObject({
        body: 'Swap the photo?',
        resolvedAt: null,
        author: { id: guest, name: 'Gus' },
        canDelete: true,
      });

      // Same second: the id breaks the tie, so the order is stable.
      const thread = await svc.list(ws, postId, guest, 'GUEST');
      expect(thread.map((c) => c.id)).toEqual(
        [a, b]
          .sort((x, y) =>
            x.createdAt === y.createdAt
              ? x.id.localeCompare(y.id)
              : x.createdAt.localeCompare(y.createdAt),
          )
          .map((c) => c.id),
      );
      expect(thread.find((c) => c.id === b.id)?.canDelete).toBe(false);

      const resolved = await svc.setResolved(
        ws,
        postId,
        a.id,
        ownerId,
        'OWNER',
        true,
      );
      expect(resolved.resolvedAt).not.toBeNull();
      expect(resolved.author?.name).toBe('Gus');
      const reopened = await svc.setResolved(
        ws,
        postId,
        a.id,
        guest,
        'GUEST',
        false,
      );
      expect(reopened.resolvedAt).toBeNull();

      // A row filed under another workspace never shows in this thread,
      // even on this post: the read is scoped by workspace as well.
      await client.query(
        `INSERT INTO post_comments (post_id, workspace_id, user_id, body)
         VALUES ($1, $2, $3, 'stray')`,
        [postId, other.workspaceId, other.ownerId],
      );
      expect(
        (await svc.list(ws, postId, ownerId, 'OWNER')).map((c) => c.body),
      ).not.toContain('stray');

      // Another workspace sees neither the post nor its comments.
      await expect(
        svc.list(other.workspaceId, postId, other.ownerId, 'OWNER'),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        svc.create(other.workspaceId, postId, other.ownerId, 'OWNER', 'x'),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        svc.setResolved(
          other.workspaceId,
          postId,
          a.id,
          other.ownerId,
          'OWNER',
          true,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        svc.remove(other.workspaceId, postId, a.id, other.ownerId, 'OWNER'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  it('the author or an admin deletes; nobody else', async () => {
    await withRollbackDb([MIGRATION], async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const member = await seedMember(client, ws, 'MEMBER');
      const admin = await seedMember(client, ws, 'ADMIN');
      const postId = await seedPost(client, ws, ownerId);
      const svc = new PostCommentsService(db);

      const mine = await svc.create(ws, postId, ownerId, 'OWNER', 'Owner note');
      await expect(
        svc.remove(ws, postId, mine.id, member, 'MEMBER'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await svc.remove(ws, postId, mine.id, admin, 'ADMIN');

      const theirs = await svc.create(ws, postId, member, 'MEMBER', 'Mine');
      await svc.remove(ws, postId, theirs.id, member, 'MEMBER');
      expect(await svc.list(ws, postId, ownerId, 'OWNER')).toEqual([]);
    });
  });

  it('the CHECK refuses an empty or over-long body; a deleted post takes its thread', async () => {
    await withRollbackDb([MIGRATION], async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const postId = await seedPost(client, ws, ownerId);
      await client.query('SAVEPOINT s1');
      await expect(
        client.query(
          `INSERT INTO post_comments (post_id, workspace_id, user_id, body) VALUES ($1, $2, $3, '')`,
          [postId, ws, ownerId],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await client.query('ROLLBACK TO SAVEPOINT s1');
      await expect(
        client.query(
          `INSERT INTO post_comments (post_id, workspace_id, user_id, body) VALUES ($1, $2, $3, repeat('x', 2001))`,
          [postId, ws, ownerId],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await client.query('ROLLBACK TO SAVEPOINT s1');

      const svc = new PostCommentsService(db);
      await svc.create(ws, postId, ownerId, 'OWNER', 'x'.repeat(2000));
      await client.query('DELETE FROM posts WHERE id = $1', [postId]);
      const left = await client.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM post_comments WHERE post_id = $1',
        [postId],
      );
      expect(left.rows[0].n).toBe(0);
    });
  });

  it('degrades before 0058 is applied: empty thread, clear 503 on write', async () => {
    // No migration listed: the table does not exist in this transaction.
    await withRollbackDb([], async (db, client) => {
      const exists = await client.query<{ t: string | null }>(
        `SELECT to_regclass('post_comments') AS t`,
      );
      expect(exists.rows[0].t).toBeNull();
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const postId = await seedPost(client, ws, ownerId);
      const svc = new PostCommentsService(db);
      await client.query('SAVEPOINT s1');
      expect(await svc.list(ws, postId, ownerId, 'OWNER')).toEqual([]);
      await client.query('ROLLBACK TO SAVEPOINT s1');
      await expect(
        svc.create(ws, postId, ownerId, 'OWNER', 'hi'),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });
});
