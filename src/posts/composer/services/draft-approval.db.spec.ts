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
import { RecipientsService } from '../../../notifications/recipients.service';
import { DraftApprovalService } from './draft-approval.service';
import { DraftStoreService } from './draft-store.service';
import { ComposerSchedulingService } from './composer-scheduling.service';
import { PublishOrchestratorService } from './publish-orchestrator.service';
import { ApprovalPolicyService } from './approval-policy.service';
import { WorkspaceRoleService } from '../../../workspace-members/workspace-role.service';
import type { ApprovalPolicy } from '../../../drizzle/schema/workspace.schema';

// Copied from planner-posts.service.db.spec.ts: the local DB sits at 0055 and
// the schema now names columns up to 0092.
const MIGRATIONS = [
  '0041_post_ready.sql',
  '0070_users_sessions_revoked_at.sql',
  '0071_users_pending_email.sql',
  '0073_users_email_changed_at.sql',
  '0090_user_account_settings.sql',
  '0091_workspace_settings.sql',
  '0092_workspace_labels.sql',
];

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
  // The real recipients lookup; NotifyService is a double that only runs the
  // bell, so the email path stays out of these approval-rule tests.
  const notify = {
    notify: jest.fn(async (input: any) => {
      await input.bell?.();
    }),
  };
  const links = { planner: () => 'https://app.test/planner' };
  const policy = new ApprovalPolicyService(db, new WorkspaceRoleService(db));
  const approvals = new DraftApprovalService(
    db,
    notifications as any,
    notify as any,
    new RecipientsService(db),
    links as any,
    policy,
  );
  // The service fires its notifications without awaiting them. Hold on to
  // each one as it starts so a test can wait for exactly those to finish. Plain
  // assignment, not jest.spyOn, so jest.restoreAllMocks() leaves it in place.
  const inflight: Promise<unknown>[] = [];
  for (const name of ['notifyApprovers', 'notifyRequester']) {
    const original = (approvals as any)[name].bind(approvals);
    (approvals as any)[name] = (...args: unknown[]) => {
      const done = original(...args);
      inflight.push(done);
      return done;
    };
  }
  const settle = async () => {
    await Promise.all(inflight.splice(0));
  };
  const store = new DraftStoreService(
    db,
    undefined,
    undefined,
    undefined,
    policy,
  );
  const scheduling = new ComposerSchedulingService(
    db,
    queue as any,
    { syncPost: async () => undefined } as any,
    { enforceQueueLimit: async () => undefined } as any,
    undefined,
    undefined,
    policy,
  );
  // The guard runs before the resolver, publishers or events are touched.
  const orchestrator = new PublishOrchestratorService(
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    db,
    { send: jest.fn() } as any, // PostReminderService
    undefined,
    policy,
  );
  return {
    notifications,
    queue,
    approvals,
    store,
    scheduling,
    orchestrator,
    settle,
  };
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

async function setPolicy(client: any, ws: string, policy: ApprovalPolicy) {
  await client.query(
    `UPDATE workspace SET approval_policy = $1 WHERE id = $2`,
    [policy, ws],
  );
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
      await h.settle();
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
      await h.settle();
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
      await h.settle();
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
      await h.settle();
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
      await h.settle();
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
      await h.settle();

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
      await h.settle();
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

  describe('workspace approval policy', () => {
    it('members: a MEMBER draft needs approval, an approver cannot drop it while covered', async () => {
      await withRollbackDb(MIGRATIONS, async (db, client) => {
        const { workspaceId: ws, ownerId } = await seedWorkspace(client);
        const admin = await seedMember(client, ws, 'ADMIN');
        const member = await seedMember(client, ws, 'MEMBER');
        await setPolicy(client, ws, 'members');
        const h = harness(db);

        const id = randomUUID();
        await h.store.upsert(ws, member, draftBody(id) as any, 'MEMBER');
        await h.settle();
        expect((await rowOf(db, id)).metadata?.approval).toMatchObject({
          required: true,
          byPolicy: true,
          requestedById: member,
          approvedAt: null,
        });
        // Nobody is told until the author sends it for approval.
        expect(h.notifications.approvalRequested).not.toHaveBeenCalled();
        // A later save keeps it.
        await h.store.upsert(ws, member, draftBody(id, 'v2') as any, 'MEMBER');
        expect((await rowOf(db, id)).metadata?.approval?.byPolicy).toBe(true);

        expect((await h.approvals.get(ws, id, admin, 'ADMIN')).canTurnOff).toBe(
          false,
        );
        const refused = await h.approvals
          .setRequired(ws, id, admin, 'ADMIN', false)
          .then(
            () => null,
            (e: unknown) => e,
          );
        expect(refused).toBeInstanceOf(ForbiddenException);
        expect((refused as ForbiddenException).getResponse()).toMatchObject({
          statusCode: 403,
          error: 'Forbidden',
          code: 'APPROVAL_REQUIRED_BY_POLICY',
        });
        expect((await rowOf(db, id)).metadata?.approval?.required).toBe(true);

        await setPolicy(client, ws, 'none');
        expect((await h.approvals.get(ws, id, admin, 'ADMIN')).canTurnOff).toBe(
          true,
        );
        const off = await h.approvals.setRequired(
          ws,
          id,
          admin,
          'ADMIN',
          false,
        );
        expect(off).toMatchObject({ required: false, state: 'none' });

        // An OWNER is not covered by `members`.
        await setPolicy(client, ws, 'members');
        const ownDraft = randomUUID();
        await h.store.upsert(ws, ownerId, draftBody(ownDraft) as any, 'OWNER');
        expect((await rowOf(db, ownDraft)).metadata).not.toHaveProperty(
          'approval',
        );
      });
    });

    it('a draft made before the policy changed keeps no approval on save', async () => {
      await withRollbackDb(MIGRATIONS, async (db, client) => {
        const { workspaceId: ws } = await seedWorkspace(client);
        const member = await seedMember(client, ws, 'MEMBER');
        const h = harness(db);
        const id = randomUUID();
        await h.store.upsert(ws, member, draftBody(id) as any, 'MEMBER');
        await setPolicy(client, ws, 'everyone');
        await h.store.upsert(ws, member, draftBody(id, 'v2') as any, 'MEMBER');
        expect((await rowOf(db, id)).metadata).not.toHaveProperty('approval');
      });
    });

    it('sending a policy request for approval tells the approvers once', async () => {
      await withRollbackDb(MIGRATIONS, async (db, client) => {
        const { workspaceId: ws, ownerId } = await seedWorkspace(client);
        const admin = await seedMember(client, ws, 'ADMIN');
        const member = await seedMember(client, ws, 'MEMBER');
        await setPolicy(client, ws, 'members');
        const h = harness(db);
        const id = randomUUID();
        await h.store.upsert(ws, member, draftBody(id) as any, 'MEMBER');
        const before = (await rowOf(db, id)).metadata?.approval;
        expect(before?.notifiedAt).toBeUndefined();

        const view = await h.approvals.setRequired(
          ws,
          id,
          member,
          'MEMBER',
          true,
        );
        await h.settle();
        expect(view).toMatchObject({ required: true, state: 'pending' });
        expect(
          h.notifications.approvalRequested.mock.calls
            .map((c: any[]) => c[0])
            .sort(),
        ).toEqual([admin, ownerId].sort());
        const after = (await rowOf(db, id)).metadata?.approval;
        expect(typeof after?.notifiedAt).toBe('string');
        expect(after?.requestedAt).toBe(before?.requestedAt);

        await h.approvals.setRequired(ws, id, member, 'MEMBER', true);
        await h.settle();
        expect(h.notifications.approvalRequested).toHaveBeenCalledTimes(2);
      });
    });

    it('a policy request approved before it was sent tells nobody when sent', async () => {
      await withRollbackDb(MIGRATIONS, async (db, client) => {
        const { workspaceId: ws } = await seedWorkspace(client);
        const admin = await seedMember(client, ws, 'ADMIN');
        const member = await seedMember(client, ws, 'MEMBER');
        await setPolicy(client, ws, 'members');
        const h = harness(db);
        const id = randomUUID();
        await h.store.upsert(ws, member, draftBody(id) as any, 'MEMBER');
        await h.approvals.approve(ws, id, admin, 'ADMIN');
        await h.settle();
        h.notifications.approvalRequested.mockClear();

        const view = await h.approvals.setRequired(
          ws,
          id,
          member,
          'MEMBER',
          true,
        );
        await h.settle();
        expect(view.state).toBe('approved');
        expect(h.notifications.approvalRequested).not.toHaveBeenCalled();
        expect(
          (await rowOf(db, id)).metadata?.approval?.notifiedAt,
        ).toBeUndefined();
      });
    });

    it('everyone covers an ADMIN but never the OWNER', async () => {
      await withRollbackDb(MIGRATIONS, async (db, client) => {
        const { workspaceId: ws, ownerId } = await seedWorkspace(client);
        const admin = await seedMember(client, ws, 'ADMIN');
        await setPolicy(client, ws, 'everyone');
        const h = harness(db);

        const adminDraft = randomUUID();
        await h.store.upsert(ws, admin, draftBody(adminDraft) as any, 'ADMIN');
        expect((await rowOf(db, adminDraft)).metadata?.approval).toMatchObject({
          required: true,
          byPolicy: true,
          requestedById: admin,
        });
        expect(
          await codeOf(
            h.scheduling.schedule(ws, admin, scheduleBody(adminDraft) as any),
          ),
        ).toBe('APPROVAL_REQUIRED');
        // The ADMIN's own request is locked for the ADMIN too.
        expect(
          (await h.approvals.get(ws, adminDraft, admin, 'ADMIN')).canTurnOff,
        ).toBe(false);

        const ownerDraft = randomUUID();
        await h.store.upsert(
          ws,
          ownerId,
          draftBody(ownerDraft) as any,
          'OWNER',
        );
        expect((await rowOf(db, ownerDraft)).metadata).not.toHaveProperty(
          'approval',
        );
        const res = await h.scheduling.schedule(
          ws,
          ownerId,
          scheduleBody(ownerDraft) as any,
        );
        expect(res.status).toBe('scheduled');
        // The OWNER may still approve the ADMIN's draft and lift nothing else.
        const approved = await h.approvals.approve(
          ws,
          adminDraft,
          ownerId,
          'OWNER',
        );
        await h.settle();
        expect(approved.state).toBe('approved');
        expect(
          (
            await h.scheduling.schedule(
              ws,
              admin,
              scheduleBody(adminDraft) as any,
            )
          ).status,
        ).toBe('scheduled');
      });
    });

    it('a pure time move of a scheduled post is not gated in the composer', async () => {
      await withRollbackDb(MIGRATIONS, async (db, client) => {
        const { workspaceId: ws } = await seedWorkspace(client);
        const member = await seedMember(client, ws, 'MEMBER');
        const h = harness(db);
        const id = randomUUID();
        // Scheduled before the policy existed.
        await h.store.upsert(ws, member, draftBody(id) as any, 'MEMBER');
        await h.scheduling.schedule(ws, member, scheduleBody(id) as any);
        await setPolicy(client, ws, 'members');

        const moved = {
          ...scheduleBody(id),
          scheduledAt: new Date(Date.now() + 7_200_000).toISOString(),
        };
        expect(
          (await h.scheduling.schedule(ws, member, moved as any)).status,
        ).toBe('scheduled');
        // A content change of the same scheduled post is gated.
        expect(
          await codeOf(
            h.scheduling.schedule(
              ws,
              member,
              scheduleBody(id, 'edited') as any,
            ),
          ),
        ).toBe('APPROVAL_REQUIRED');
        // So is a re-time that changes the title or starts a repeat: both
        // reach what is published, though the content is the same.
        const later = new Date(Date.now() + 10_800_000).toISOString();
        for (const extra of [
          { title: 'A new title' },
          {
            recurrence: { freq: 'daily', interval: 1, ends: { type: 'never' } },
          },
          { base: { ...scheduleBody(id).base, hashtags: ['#sale'] } },
        ]) {
          expect(
            await codeOf(
              h.scheduling.schedule(ws, member, {
                ...scheduleBody(id),
                scheduledAt: later,
                ...extra,
              } as any),
            ),
          ).toBe('APPROVAL_REQUIRED');
        }
        expect(h.queue.add).toHaveBeenCalledTimes(2);
      });
    });

    it('a covered author cannot schedule or publish without a stored approval', async () => {
      await withRollbackDb(MIGRATIONS, async (db, client) => {
        const { workspaceId: ws } = await seedWorkspace(client);
        const admin = await seedMember(client, ws, 'ADMIN');
        const member = await seedMember(client, ws, 'MEMBER');
        const h = harness(db);

        // Made before the policy, so the row carries no approval.
        const old = randomUUID();
        await h.store.upsert(ws, member, draftBody(old) as any, 'MEMBER');
        await setPolicy(client, ws, 'members');

        // Never saved at all, and saved before the policy: both refused.
        for (const id of [randomUUID(), old]) {
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
        }
        // A time per channel goes through the split path: refused too.
        const at = (hours: number) =>
          new Date(Date.now() + hours * 3_600_000).toISOString();
        const split = {
          ...draftBody(old),
          scheduleMode: 'per_channel',
          scheduledAt: at(1),
          channels: [
            { ...draftBody(old).channels[0], scheduleAt: at(1) },
            {
              channelId: '8',
              platform: 'instagram',
              publishStatus: 'queued',
              retryCount: 0,
              scheduleAt: at(2),
            },
          ],
        };
        expect(
          await codeOf(h.scheduling.schedule(ws, member, split as any)),
        ).toBe('APPROVAL_REQUIRED');
        expect(h.queue.add).not.toHaveBeenCalled();
        expect((await rowOf(db, old)).status).toBe('draft');

        // An ADMIN is not covered by `members`.
        const res = await h.scheduling.schedule(
          ws,
          admin,
          scheduleBody(randomUUID()) as any,
        );
        expect(res.status).toBe('scheduled');
        const orch = h.orchestrator as any;
        await expect(
          orch.approvalFor(ws, {
            ...draftBody(randomUUID()),
            id: randomUUID(),
            createdById: admin,
            perPlatform: {},
          }),
        ).resolves.toEqual({});
      });
    });
  });
});
