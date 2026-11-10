import {
  BadRequestException,
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { describeDb, withRollbackDb } from '../planner/testing/rollback-db';
import { seedWorkspace } from '../inbox/testing/inbox-db';
import { CODE_PATTERN, CREATE_LIMIT_PER_HOUR } from './short-link-rules';
import { ShortLinksService, isMissingTable } from './short-links.service';

const MIGRATION = '0061_short_links.sql';
const ENV: NodeJS.ProcessEnv = { APP_URL: 'https://api.test' };

type Client = {
  query: (
    sql: string,
    args?: unknown[],
  ) => Promise<{ rows: Array<Record<string, unknown>> }>;
};

async function seedPost(
  client: Client,
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

/** Codes from a list, then whatever the real generator draws. */
function queueCodes(svc: ShortLinksService, ...queue: string[]) {
  const real = svc.newCode;
  svc.newCode = () => queue.shift() ?? real();
}

const count = async (client: Client): Promise<number> =>
  (await client.query(`SELECT count(*)::int AS n FROM short_links`)).rows[0]
    .n as number;

describe('isMissingTable', () => {
  it('finds 42P01 on the error or its cause', () => {
    expect(isMissingTable({ code: '42P01' })).toBe(true);
    expect(isMissingTable({ cause: { code: '42P01' } })).toBe(true);
    expect(isMissingTable(new Error('x'))).toBe(false);
  });
});

describeDb('ShortLinksService (database)', () => {
  it('creates a link, and the same URL again returns the same one', async () => {
    await withRollbackDb([MIGRATION], async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const other = await seedWorkspace(client);
      const svc = new ShortLinksService(db);

      const a = await svc.create(
        ws,
        ownerId,
        { url: ' HTTPS://Lumiere.PK/menu?x=1 ' },
        ENV,
      );
      expect(a.code).toMatch(CODE_PATTERN);
      expect(a.code).toHaveLength(7);
      expect(a.shortUrl).toBe(`https://api.test/l/${a.code}`);
      expect(a.targetUrl).toBe('https://lumiere.pk/menu?x=1');
      expect(a.clicks).toBe(0);
      expect(a.lastClickedAt).toBeNull();
      expect(a.postId).toBeNull();

      const again = await svc.create(
        ws,
        ownerId,
        { url: 'https://lumiere.pk/menu?x=1' },
        ENV,
      );
      expect(again.id).toBe(a.id);
      expect(again.code).toBe(a.code);

      // Another workspace shortening the same URL gets its own code.
      const theirs = await svc.create(
        other.workspaceId,
        other.ownerId,
        { url: 'https://lumiere.pk/menu?x=1' },
        ENV,
      );
      expect(theirs.code).not.toBe(a.code);

      const rows = await client.query(
        `SELECT workspace_id, created_by_id FROM short_links ORDER BY created_at, workspace_id = $1 DESC`,
        [ws],
      );
      expect(rows.rows).toHaveLength(2);
      expect(rows.rows).toContainEqual({
        workspace_id: ws,
        created_by_id: ownerId,
      });
    });
  });

  it('draws again when a code is taken, and gives up after five', async () => {
    await withRollbackDb([MIGRATION], async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const svc = new ShortLinksService(db);

      queueCodes(svc, 'AAAAAAA');
      const first = await svc.create(
        ws,
        ownerId,
        { url: 'https://a.test/' },
        ENV,
      );
      expect(first.code).toBe('AAAAAAA');

      queueCodes(svc, 'AAAAAAA', 'AAAAAAA', 'BBBBBBB');
      const second = await svc.create(
        ws,
        ownerId,
        { url: 'https://b.test/' },
        ENV,
      );
      expect(second.code).toBe('BBBBBBB');
      expect(second.targetUrl).toBe('https://b.test/');

      let draws = 0;
      svc.newCode = () => {
        draws++;
        return 'AAAAAAA';
      };
      await expect(
        svc.create(ws, ownerId, { url: 'https://c.test/' }, ENV),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(draws).toBe(5);
      expect(await count(client)).toBe(2);
    });
  });

  it('refuses unsafe and looping targets, and needs a public URL', async () => {
    await withRollbackDb([MIGRATION], async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const svc = new ShortLinksService(db);
      for (const url of [
        'javascript:alert(1)',
        'data:text/html,hi',
        'https://api.test/l/AAAAAAA',
        'https://me:pw@x.test/',
        '',
      ]) {
        await expect(
          svc.create(ws, ownerId, { url }, ENV),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
      await expect(
        svc.create(ws, ownerId, { url: 'https://x.test/' }, {}),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(await count(client)).toBe(0);
    });
  });

  it('ties a link to a post of this workspace only, claiming an unowned one', async () => {
    await withRollbackDb([MIGRATION], async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const other = await seedWorkspace(client);
      const post = await seedPost(client, ws, ownerId);
      const post2 = await seedPost(client, ws, ownerId);
      const foreign = await seedPost(client, other.workspaceId, other.ownerId);
      const svc = new ShortLinksService(db);

      await expect(
        svc.create(
          ws,
          ownerId,
          { url: 'https://x.test/', postId: foreign },
          ENV,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        svc.create(
          ws,
          ownerId,
          { url: 'https://x.test/', postId: randomUUID() },
          ENV,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(await count(client)).toBe(0);

      const loose = await svc.create(
        ws,
        ownerId,
        { url: 'https://x.test/' },
        ENV,
      );
      expect(loose.postId).toBeNull();
      const claimed = await svc.create(
        ws,
        ownerId,
        { url: 'https://x.test/', postId: post },
        ENV,
      );
      expect(claimed.id).toBe(loose.id);
      expect(claimed.postId).toBe(post);
      const kept = await svc.create(
        ws,
        ownerId,
        { url: 'https://x.test/', postId: post2 },
        ENV,
      );
      expect(kept.id).toBe(loose.id);
      expect(kept.postId).toBe(post);

      // Deleting the post keeps the link (SET NULL), so it still redirects.
      await client.query(`DELETE FROM posts WHERE id = $1`, [post]);
      expect(await svc.resolve(loose.code, false)).toBe('https://x.test/');
    });
  });

  it('limits new links per workspace per hour, but still returns existing ones', async () => {
    await withRollbackDb([MIGRATION], async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const other = await seedWorkspace(client);
      const svc = new ShortLinksService(db);
      const kept = await svc.create(
        ws,
        ownerId,
        { url: 'https://kept.test/' },
        ENV,
      );
      await client.query(
        `INSERT INTO short_links (workspace_id, code, target_url)
         SELECT $1, 'q' || lpad(g::text, 6, '0'), 'https://bulk.test/' || g
         FROM generate_series(1, $2::int) g`,
        [ws, CREATE_LIMIT_PER_HOUR - 1],
      );
      const err: unknown = await svc
        .create(ws, ownerId, { url: 'https://new.test/' }, ENV)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HttpException);
      expect((err as HttpException).getStatus()).toBe(429);

      const again = await svc.create(
        ws,
        ownerId,
        { url: 'https://kept.test/' },
        ENV,
      );
      expect(again.id).toBe(kept.id);

      // Other workspaces are unaffected; older than an hour no longer counts.
      await svc.create(
        other.workspaceId,
        other.ownerId,
        { url: 'https://new.test/' },
        ENV,
      );
      await client.query(
        `UPDATE short_links SET created_at = now() - interval '61 minutes'
         WHERE workspace_id = $1 AND code LIKE 'q%'`,
        [ws],
      );
      const fresh = await svc.create(
        ws,
        ownerId,
        { url: 'https://new.test/' },
        ENV,
      );
      expect(fresh.targetUrl).toBe('https://new.test/');
    });
  });

  it('lists newest first, filtered by post and by codes, in this workspace only', async () => {
    await withRollbackDb([MIGRATION], async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const other = await seedWorkspace(client);
      const post = await seedPost(client, ws, ownerId);
      const svc = new ShortLinksService(db);
      const a = await svc.create(ws, ownerId, { url: 'https://a.test/' }, ENV);
      const b = await svc.create(
        ws,
        ownerId,
        { url: 'https://b.test/', postId: post },
        ENV,
      );
      await client.query(
        `UPDATE short_links SET created_at = now() - interval '1 minute' WHERE id = $1`,
        [a.id],
      );
      const theirs = await svc.create(
        other.workspaceId,
        other.ownerId,
        { url: 'https://c.test/' },
        ENV,
      );

      const all = await svc.list(ws, {}, ENV);
      expect(all.baseUrl).toBe('https://api.test/l');
      expect(all.links.map((l) => l.id)).toEqual([b.id, a.id]);

      const byPost = await svc.list(ws, { postId: post }, ENV);
      expect(byPost.links.map((l) => l.id)).toEqual([b.id]);
      const byCodes = await svc.list(ws, { codes: [a.code, theirs.code] }, ENV);
      expect(byCodes.links.map((l) => l.id)).toEqual([a.id]);
      expect((await svc.list(ws, { codes: [] }, ENV)).links).toEqual([]);
      expect(await svc.list(ws, {}, {})).toEqual({ baseUrl: null, links: [] });
    });
  });

  it('resolves a code, counting each GET but not a HEAD', async () => {
    await withRollbackDb([MIGRATION], async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const svc = new ShortLinksService(db);
      const link = await svc.create(
        ws,
        ownerId,
        { url: 'https://a.test/x' },
        ENV,
      );

      expect(await svc.resolve(link.code, true)).toBe('https://a.test/x');
      expect(await svc.resolve(link.code, true)).toBe('https://a.test/x');
      expect(await svc.resolve(link.code, false)).toBe('https://a.test/x');
      expect(await svc.resolve(link.code, true)).toBe('https://a.test/x');

      const [listed] = (await svc.list(ws, {}, ENV)).links;
      expect(listed.clicks).toBe(3);
      expect(listed.lastClickedAt).not.toBeNull();

      expect(await svc.resolve('Zz9Zz9Z', true)).toBeNull();
      expect(await svc.resolve('../etc', true)).toBeNull();
      expect(await svc.resolve('', true)).toBeNull();
    });
  });
});
