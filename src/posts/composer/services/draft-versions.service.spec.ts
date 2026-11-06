/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- test doubles are loosely typed */
import { ConflictException, NotFoundException } from '@nestjs/common';
import { PgDialect } from 'drizzle-orm/pg-core';
import { postHistory, posts } from '../../../drizzle/schema/posts.schema';
import { VERSION_ACTION, type DraftSnapshot } from '../lib/draft-versions';
import { DraftVersionsService } from './draft-versions.service';
import { DraftStoreService } from './draft-store.service';
import { ComposerSchedulingService } from './composer-scheduling.service';

const WS = 'w1';
const snap = (text = 'Hello'): DraftSnapshot => ({
  text,
  mediaItems: [],
  hashtags: [],
  mentions: [],
  perPlatform: {},
  channels: [{ channelId: '7', platform: 'facebook' }],
});

/**
 * Every select answers from `answers[table]`; inserts, deletes and the
 * where clauses they were given are kept for the assertions.
 */
function fakeDb(answers: { posts?: any[]; history?: any[] }) {
  const log = {
    inserted: [] as any[],
    deleted: 0,
    wheres: [] as Array<{ table: unknown; where: any }>,
  };
  const chain = (table: unknown) => {
    const rows = table === posts ? answers.posts : answers.history;
    const q: any = Promise.resolve(rows ?? []);
    q.where = (w: any) => {
      log.wheres.push({ table, where: w });
      return q;
    };
    q.orderBy = () => q;
    q.limit = () => q;
    q.leftJoin = () => q;
    return q;
  };
  const db = {
    select: () => ({ from: (table: unknown) => chain(table) }),
    insert: () => ({
      values: (v: any) => {
        log.inserted.push(v);
        const p: any = Promise.resolve();
        p.returning = async () => [
          { ...v, createdAt: new Date(), updatedAt: new Date() },
        ];
        return p;
      },
    }),
    update: () => ({
      set: (v: any) => ({
        where: () => ({
          returning: async () => [
            {
              id: 'd1',
              workspaceId: WS,
              ...v,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
        }),
      }),
    }),
    delete: () => ({
      where: async () => {
        log.deleted++;
      },
    }),
  };
  return { db, log };
}

const sql = (w: any) => new PgDialect().sqlToQuery(w);

describe('DraftVersionsService.record', () => {
  it('writes the first snapshot as "created" and prunes', async () => {
    const { db, log } = fakeDb({ history: [] });
    await new DraftVersionsService(db).record('p1', 'u1', snap());
    expect(log.inserted).toHaveLength(1);
    expect(log.inserted[0]).toMatchObject({
      postId: 'p1',
      action: VERSION_ACTION,
      performedById: 'u1',
      details: { snapshot: snap(), change: { kind: 'created' } },
    });
    expect(log.deleted).toBe(1);
  });

  it('writes nothing when the content did not change', async () => {
    const { db, log } = fakeDb({
      history: [{ details: { snapshot: snap(), change: { kind: 'created' } } }],
    });
    await new DraftVersionsService(db).record('p1', 'u1', snap());
    expect(log.inserted).toHaveLength(0);
  });

  it('describes the change against the latest snapshot of THIS post', async () => {
    const { db, log } = fakeDb({
      history: [{ details: { snapshot: snap(), change: { kind: 'created' } } }],
    });
    await new DraftVersionsService(db).record('p1', 'u1', snap('New words'));
    expect(log.inserted[0].details.change).toEqual({
      kind: 'caption',
      excerpt: 'New words',
    });
    const latest = sql(log.wheres[0].where);
    expect(latest.params).toEqual(['p1', VERSION_ACTION]);
  });

  it('marks a restore as one', async () => {
    const { db, log } = fakeDb({ history: [] });
    await new DraftVersionsService(db).record('p1', 'u1', snap(), {
      restoredFrom: '2026-11-05T10:42:00.000Z',
    });
    expect(log.inserted[0].details.change).toEqual({
      kind: 'restored',
      fromAt: '2026-11-05T10:42:00.000Z',
    });
  });

  it('never throws: the save has already happened', async () => {
    const db = {
      select: () => {
        throw new Error('db down');
      },
    };
    await expect(
      new DraftVersionsService(db).record('p1', 'u1', snap()),
    ).resolves.toBeUndefined();
  });
});

describe('DraftVersionsService.list', () => {
  it('404s a post outside the workspace', async () => {
    const { db, log } = fakeDb({ posts: [] });
    await expect(
      new DraftVersionsService(db).list(WS, 'p1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    const q = sql(log.wheres[0].where);
    expect(q.sql).toContain('"posts"."workspace_id"');
    expect(q.params).toEqual(['p1', WS]);
  });

  it('returns the status and the readable versions, newest first as stored', async () => {
    const at = new Date('2026-11-06T09:00:00Z');
    const { db } = fakeDb({
      posts: [{ status: 'draft', metadata: {} }],
      history: [
        {
          id: 'v2',
          createdAt: at,
          details: {
            snapshot: { ...snap('B'), mediaItems: [{ id: 'a' }] },
            change: { kind: 'caption', excerpt: 'B' },
          },
          authorId: 'u2',
          authorName: null,
          authorEmail: 'sara@x.io',
          authorAvatar: null,
        },
        { id: 'junk', createdAt: at, details: { platformPostId: 'p' } },
      ],
    });
    const out = await new DraftVersionsService(db).list(WS, 'p1');
    expect(out.postStatus).toBe('draft');
    expect(out.versions).toEqual([
      {
        id: 'v2',
        createdAt: at.toISOString(),
        author: { id: 'u2', name: 'sara@x.io', avatarUrl: null },
        change: { kind: 'caption', excerpt: 'B' },
        text: 'B',
        mediaCount: 1,
        channelCount: 1,
      },
    ]);
  });
});

describe('DraftVersionsService.loadForRestore', () => {
  it('refuses anything but a draft', async () => {
    const { db } = fakeDb({ posts: [{ status: 'scheduled', metadata: {} }] });
    await expect(
      new DraftVersionsService(db).loadForRestore(WS, 'p1', 'v1'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('404s a version that is not one of this post’s snapshots', async () => {
    const { db, log } = fakeDb({
      posts: [{ status: 'draft', metadata: {} }],
      history: [],
    });
    await expect(
      new DraftVersionsService(db).loadForRestore(WS, 'p1', 'v1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    const q = sql(log.wheres.find((w) => w.table === postHistory)!.where);
    expect(q.params).toEqual(['v1', 'p1', VERSION_ACTION]);
  });
});

describe('saves record versions', () => {
  const dto = {
    draftId: 'd1',
    base: { text: 'Hi', mediaItems: [], hashtags: [], mentions: [] },
    channels: [
      {
        channelId: '7',
        platform: 'facebook',
        publishStatus: 'queued',
        retryCount: 0,
      },
    ],
  } as any;

  it('Save draft records the content it wrote', async () => {
    const { db } = fakeDb({ posts: [] });
    const versions = { record: jest.fn(async () => undefined) };
    await new DraftStoreService(db, versions as any).upsert(WS, 'u1', dto);
    expect(versions.record).toHaveBeenCalledWith(
      'd1',
      'u1',
      expect.objectContaining({
        text: 'Hi',
        channels: [{ channelId: '7', platform: 'facebook' }],
      }),
      {},
    );
  });

  it('Schedule records it too', async () => {
    const { db } = fakeDb({ posts: [] });
    const versions = { record: jest.fn(async () => undefined) };
    const svc = new ComposerSchedulingService(
      {
        ...db,
        update: () => ({ set: () => ({ where: async () => undefined }) }),
      } as any,
      { getJob: jest.fn(async () => null), add: jest.fn() } as any,
      { syncPost: jest.fn(async () => undefined) } as any,
      { enforceQueueLimit: jest.fn(async () => undefined) } as any,
      versions as any,
    );
    await svc.schedule(WS, 'u1', {
      ...dto,
      scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(versions.record).toHaveBeenCalledWith(
      'd1',
      'u1',
      expect.objectContaining({ text: 'Hi' }),
    );
  });

  it('Restore writes the snapshot back as a new save, keeping the schedule', async () => {
    const { db, log } = fakeDb({
      posts: [{ id: 'd1', status: 'draft', createdById: 'u1', metadata: {} }],
    });
    const old: DraftSnapshot = {
      ...snap('Old words'),
      title: 'Old title',
      perPlatform: { x: { inheritsFromBase: false } } as any,
    };
    const versions = {
      record: jest.fn(async () => undefined),
      loadForRestore: jest.fn(async () => ({
        post: {
          status: 'draft',
          metadata: { schedule: { mode: 'all_same_time', scheduleAt: 'T' } },
        },
        snapshot: old,
        createdAt: '2026-11-05T10:42:00.000Z',
      })),
    };
    let written: any;
    const spyDb = {
      ...db,
      update: () => ({
        set: (v: any) => {
          written = v;
          return db.update().set(v);
        },
      }),
    };
    const draft = await new DraftStoreService(
      spyDb,
      versions as any,
    ).restoreVersion(WS, 'd1', 'v1', 'u1', 'MEMBER' as any);
    expect(versions.loadForRestore).toHaveBeenCalledWith(WS, 'd1', 'v1');
    expect(written.content).toBe('Old words');
    expect(written.platformContent).toEqual(old.perPlatform);
    expect(written.targets).toEqual([
      {
        channelId: '7',
        platform: 'facebook',
        publishStatus: 'queued',
        retryCount: 0,
      },
    ]);
    expect(written.metadata).toMatchObject({
      title: 'Old title',
      schedule: { mode: 'all_same_time', scheduleAt: 'T' },
    });
    expect(versions.record).toHaveBeenCalledWith(
      'd1',
      'u1',
      expect.objectContaining({ text: 'Old words' }),
      { restoredFrom: '2026-11-05T10:42:00.000Z' },
    );
    expect(draft.base.text).toBe('Old words');
    expect(log.inserted).toHaveLength(0);
  });
});
