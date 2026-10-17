import { NotFoundException } from '@nestjs/common';
import {
  describeDb,
  withRollbackDb,
  type DbType,
} from '../../planner/testing/rollback-db';
import { posts } from '../../drizzle/schema/posts.schema';
import { users } from '../../drizzle/schema/users.schema';
import { workspace } from '../../drizzle/schema/workspace.schema';
import { PlannerPostsService } from './planner-posts.service';

const HOUR = 3600 * 1000;
const READY_MIGRATION = '0041_post_ready.sql';

async function seed(db: DbType) {
  const stamp = Math.random().toString(36).slice(2);
  const [user] = await db
    .insert(users)
    .values({ email: `t4-${stamp}@example.com`, name: 'T4' } as never)
    .returning();
  const mk = async (name: string) => {
    const [ws] = await db
      .insert(workspace)
      .values({
        name,
        slug: `t4-${name}-${stamp}`,
        ownerId: user.id,
        timezone: 'Asia/Karachi',
      } as never)
      .returning();
    return ws;
  };
  return { user, a: await mk('A'), b: await mk('B') };
}

describeDb('PlannerPostsService (database)', () => {
  it('range excludes drafts and keeps scheduled-only and published-now posts', async () => {
    await withRollbackDb([READY_MIGRATION], async (db) => {
      const { user, a } = await seed(db);
      const now = Date.now();
      const base = { workspaceId: a.id, createdById: user.id, content: 'x' };
      await db.insert(posts).values([
        { ...base, status: 'draft', scheduledAt: new Date(now + HOUR) },
        { ...base, status: 'scheduled', scheduledAt: new Date(now + HOUR) },
        { ...base, status: 'published', publishedAt: new Date(now - HOUR) },
      ] as never);
      const svc = new PlannerPostsService(db as never);
      const res = await svc.getCalendar(
        a.id,
        new Date(now - 24 * HOUR),
        new Date(now + 24 * HOUR),
      );
      expect(res.posts.map((p) => p.status).sort()).toEqual([
        'published',
        'scheduled',
      ]);
      expect(res.timezone).toBe('Asia/Karachi');
      expect(res.total).toBe(2);
    });
  });

  it('getOne rejects a post that belongs to another workspace', async () => {
    await withRollbackDb([READY_MIGRATION], async (db) => {
      const { user, a, b } = await seed(db);
      const [p] = await db
        .insert(posts)
        .values({
          workspaceId: b.id,
          createdById: user.id,
          content: 'y',
          status: 'draft',
        } as never)
        .returning();
      const svc = new PlannerPostsService(db as never);
      await expect(svc.getOne(a.id, p.id)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(svc.getOne(b.id, p.id)).resolves.toMatchObject({
        id: p.id,
      });
    });
  });
});
