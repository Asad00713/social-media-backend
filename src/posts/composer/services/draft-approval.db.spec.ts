/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/require-await, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call -- test doubles are loosely typed */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  describeDb,
  withRollbackDb,
  type DbType,
} from '../../../planner/testing/rollback-db';
import { seedMember, seedWorkspace } from '../../../inbox/testing/inbox-db';
import { posts, postHistory } from '../../../drizzle/schema/posts.schema';
import { DraftApprovalService } from './draft-approval.service';
import { DraftStoreService } from './draft-store.service';
import { ComposerSchedulingService } from './composer-scheduling.service';
import { PublishOrchestratorService } from './publish-orchestrator.service';

const MIGRATIONS = ['0041_post_ready.sql'];

function harness(db: DbType) {
  const notifications = {
    approvalRequested: jest.fn(async () => undefined),
    draftApproved: jest.fn(async () => undefined),
  };
  const queue = {
    getJob: jest.fn(async () => null),
    add: jest.fn(async (_n: string, _d: unknown, opts: any) => ({
      id: opts.jobId,
    })),
  };
  const approvals = new DraftApprovalService(db, notifications as any);
  const store = new DraftStoreService(db);
  const scheduling = new ComposerSchedulingService(
    db,
    queue as any,
    { syncPost: async () => undefined } as any,
    { enforceQueueLimit: async () => undefined } as any,
  );
  // The guard runs before the resolver, publishers or events are touched.
  const orchestrator = new PublishOrchestratorService(
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    db,
  );
  return { notifications, queue, approvals, store, scheduling, orchestrator };
}

const draftBody = (draftId: string, text = 'Iced latte is back') => ({
  draftId,
  base: {
    text,
    mediaItems: [{ id: 'm1', url: 'https://cdn.test/a.jpg', type: 'image' }],
    hashtags: [],
    mentions: [],
  },
  perPlatform: {
    instagram: {
      inheritsFromBase: true,
      overrides: {},
      platformSpecific: { shareToFeed: true },
    },
  },
  channels: [
    {
      channelId: '7',
      platform: 'instagram',
      publishStatus: 'queued',
      retryCount: 0,
    },
  ],
});

const scheduleBody = (draftId: string, text?: string) => ({
  ...draftBody(draftId, text),
  scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
});

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(BadRequestException);
    return ((e as BadRequestException).getResponse() as { code: string }).code;
  }
  throw new Error('expected a refusal');
}

async function rowOf(db: DbType, id: string) {
  const [row] = await db.select().from(posts).where(eq(posts.id, id));
  return row;
}

describeDb('Draft approvals (database)', () => {
  it('request -> refusal -> approve -> schedule, with notifications', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const admin = await seedMember(client, ws, 'ADMIN', { name: 'Sara' });
      const member = await seedMember(client, ws, 'MEMBER', { name: 'Ali' });
      const h = harness(db);
      const id = randomUUID();
      await h.store.upsert(ws, member, draftBody(id) as any, 'MEMBER');

      const before = await h.approvals.get(ws, id, member, 'MEMBER');
      expect(before).toMatchObject({
        required: false,
        state: 'none',
        canTurnOff: false,
      });

      const asked = await h.approvals.setRequired(
        ws,
        id,
        member,
        'MEMBER',
        true,
      );
      expect(asked).toMatchObject({
        required: true,
        state: 'pending',
        requestedBy: { id: member, name: 'Ali' },
        canApprove: false,
      });
      const told = h.notifications.approvalRequested.mock.calls.map(
        (c: any[]) => c[0],
      );
      expect(told.sort()).toEqual([admin, ownerId].sort());

      // A second "on" is a no-op: nobody is told twice.
      await h.approvals.setRequired(ws, id, member, 'MEMBER', true);
      expect(h.notifications.approvalRequested).toHaveBeenCalledTimes(2);

      // The person waiting cannot simply switch it off.
      await expect(
        h.approvals.setRequired(ws, id, member, 'MEMBER', false),
      ).rejects.toBeInstanceOf(ForbiddenException);

      // Neither path sends it out, and nothing is written.
      expect(
        await codeOf(
          h.scheduling.schedule(ws, member, scheduleBody(id) as any),
        ),
      ).toBe('APPROVAL_REQUIRED');
      expect(
        await codeOf(
          h.orchestrator.publishInline(ws, member, draftBody(id) as any),
        ),
      ).toBe('APPROVAL_REQUIRED');
      expect(h.queue.add).not.toHaveBeenCalled();
      expect((await rowOf(db, id)).status).toBe('draft');

      // A member cannot approve; the admin can, and the requester is told.
      await expect(
        h.approvals.approve(ws, id, member, 'MEMBER'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      const forAdmin = await h.approvals.get(ws, id, admin, 'ADMIN');
      expect(forAdmin.canApprove).toBe(true);
      const approved = await h.approvals.approve(ws, id, admin, 'ADMIN');
      expect(approved).toMatchObject({
        state: 'approved',
        approvedBy: { id: admin, name: 'Sara' },
        canApprove: false,
      });
      expect(h.notifications.draftApproved).toHaveBeenCalledWith(
        member,
        expect.objectContaining({ workspaceId: ws, postId: id }),
      );

      // Saving the same content keeps the grant; an edit withdraws it.
      await h.store.upsert(ws, member, draftBody(id) as any, 'MEMBER');
      expect((await h.approvals.get(ws, id, member, 'MEMBER')).state).toBe(
        'approved',
      );
      expect(
        await codeOf(
          h.scheduling.schedule(ws, member, scheduleBody(id, 'edited') as any),
        ),
      ).toBe('APPROVAL_STALE');
      await h.store.upsert(
        ws,
        member,
        draftBody(id, 'edited') as any,
        'MEMBER',
      );
      const edited = await h.approvals.get(ws, id, member, 'MEMBER');
      expect(edited).toMatchObject({ state: 'pending', approvedBy: null });
      expect(
        (await rowOf(db, id)).metadata?.approval?.approvedAt ?? null,
      ).toBeNull();

      // Approved again, the exact content schedules, and the approval rides
      // along on the scheduled row.
      await h.approvals.approve(ws, id, admin, 'ADMIN');
      const result = await h.scheduling.schedule(
        ws,
        member,
        scheduleBody(id, 'edited') as any,
      );
      expect(result.status).toBe('scheduled');
      const scheduled = await rowOf(db, id);
      expect(scheduled.status).toBe('scheduled');
      expect(scheduled.metadata?.approval?.approvedById).toBe(admin);

      // Publishing keeps it too: the orchestrator's own row write.
      const orch = h.orchestrator as any;
      const draft = {
        ...draftBody(id, 'edited'),
        id,
        perPlatform: draftBody(id).perPlatform,
        schedule: { mode: 'now' },
      };
      const carried = await orch.approvalFor(ws, draft);
      await orch.upsertPostsRow(ws, member, draft, carried);
      expect((await rowOf(db, id)).metadata?.approval?.approvedById).toBe(
        admin,
      );

      const actions = (
        await db
          .select({ action: postHistory.action })
          .from(postHistory)
          .where(eq(postHistory.postId, id))
      ).map((r) => r.action);
      expect(actions.filter((a) => a === 'approval_requested')).toHaveLength(1);
      expect(actions.filter((a) => a === 'approved')).toHaveLength(2);
    });
  });

  it('an approver may switch it off; nobody approves their own request', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const admin = await seedMember(client, ws, 'ADMIN');
      const h = harness(db);
      const id = randomUUID();
      await h.store.upsert(ws, admin, draftBody(id) as any, 'ADMIN');
      await h.approvals.setRequired(ws, id, admin, 'ADMIN', true);
      // The requester is not told about their own request.
      expect(
        h.notifications.approvalRequested.mock.calls.map((c: any[]) => c[0]),
      ).toEqual([ownerId]);

      expect((await h.approvals.get(ws, id, admin, 'ADMIN')).canApprove).toBe(
        false,
      );
      await expect(
        h.approvals.approve(ws, id, admin, 'ADMIN'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect((await h.approvals.get(ws, id, ownerId, 'OWNER')).canApprove).toBe(
        true,
      );

      const off = await h.approvals.setRequired(ws, id, admin, 'ADMIN', false);
      expect(off).toMatchObject({ required: false, state: 'none' });
      const row = await rowOf(db, id);
      expect(row.metadata).not.toHaveProperty('approval');
      // With the requirement gone it schedules freely.
      const res = await h.scheduling.schedule(
        ws,
        admin,
        scheduleBody(id) as any,
      );
      expect(res.status).toBe('scheduled');
    });
  });

  it('an approval is for the version that was read', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const member = await seedMember(client, ws, 'MEMBER');
      const h = harness(db);
      const id = randomUUID();
      await h.store.upsert(ws, member, draftBody(id) as any, 'MEMBER');
      await h.approvals.setRequired(ws, id, member, 'MEMBER', true);

      // The draft is saved again between the approver's read and the write.
      const real = (h.approvals as any).findRow.bind(h.approvals);
      let first = true;
      jest
        .spyOn(h.approvals as any, 'findRow')
        .mockImplementation(async (...args: unknown[]) => {
          const row = await real(...args);
          if (first && row) {
            first = false;
            await db
              .update(posts)
              .set({ updatedAt: new Date(Date.now() + 1000) })
              .where(and(eq(posts.id, id), eq(posts.workspaceId, ws)));
          }
          return row;
        });
      await expect(
        h.approvals.approve(ws, id, ownerId, 'OWNER'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(
        (await rowOf(db, id)).metadata?.approval?.approvedAt ?? null,
      ).toBeNull();

      // Read again, it approves: microsecond updated_at round-trips exactly.
      jest.restoreAllMocks();
      // A now() stamp carries microseconds a JS Date would drop.
      await client.query(
        `UPDATE posts SET updated_at = now() + interval '1.234567 seconds' WHERE id = $1`,
        [id],
      );
      const ok = await h.approvals.approve(ws, id, ownerId, 'OWNER');
      expect(ok.state).toBe('approved');
    });
  });

  it('only a saved draft in this workspace can ask; scheduled posts cannot', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const { workspaceId: ws, ownerId } = await seedWorkspace(client);
      const other = await seedWorkspace(client);
      const h = harness(db);
      const id = randomUUID();
      await expect(
        h.approvals.setRequired(ws, id, ownerId, 'OWNER', true),
      ).rejects.toBeInstanceOf(NotFoundException);
      await h.store.upsert(ws, ownerId, draftBody(id) as any, 'OWNER');
      await expect(
        h.approvals.setRequired(
          other.workspaceId,
          id,
          other.ownerId,
          'OWNER',
          true,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(
        (await h.approvals.get(other.workspaceId, id, other.ownerId, 'OWNER'))
          .required,
      ).toBe(false);
      await h.scheduling.schedule(ws, ownerId, scheduleBody(id) as any);
      await expect(
        h.approvals.setRequired(ws, id, ownerId, 'OWNER', true),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
