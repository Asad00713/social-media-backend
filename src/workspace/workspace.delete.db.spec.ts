import { HttpException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  seedChannel,
  seedMember,
  seedWorkspace,
} from '../inbox/testing/inbox-db';
import { describeDb, withRollbackDb } from '../planner/testing/rollback-db';
import { WorkspaceService } from './workspace.service';

// 0089 adds the workspace columns `findFirst` reads; 0080 the membership
// columns seedMember writes. The harness applies each file twice, so both
// must stay idempotent.
const MIGRATIONS = [
  '0080_member_soft_removal.sql',
  '0089_workspace_settings.sql',
];

interface Billing {
  planCode: string;
  status: string;
}

/**
 * BullMQ faked: `getJob` hands back a removable job for any id and records
 * the ids removed. The billing services read the module-level `db`, which a
 * rolled-back transaction cannot reach, so they are stubs here: `billing`
 * is what the owner's subscription row says.
 */
function makeService(db: never, billing: Billing | null) {
  const removed: string[] = [];
  const publishingQueue = {
    getJob: jest.fn((id: string) =>
      Promise.resolve({
        remove: jest.fn(() => {
          removed.push(id);
          return Promise.resolve();
        }),
      }),
    ),
  };
  const subscriptionService = {
    cancelForAccount: jest.fn().mockResolvedValue('cancelled'),
  };
  const lookup = {
    findByUserId: jest
      .fn()
      .mockResolvedValue(billing ? { id: 7, ...billing } : null),
    getPlanLimits: jest.fn().mockResolvedValue({ maxWorkspaces: 1 }),
    getAddonQuantities: jest.fn().mockResolvedValue({
      extraChannels: 0,
      extraMembers: 0,
      extraWorkspaces: 0,
      extraAiTokens: 0,
    }),
    applyLimitsToAllWorkspaces: jest.fn().mockResolvedValue(undefined),
  };
  const addonService = { removeAddon: jest.fn().mockResolvedValue(undefined) };
  const timezoneMove = {
    cancelPendingMove: jest.fn().mockResolvedValue(undefined),
  };
  const service = new WorkspaceService(
    db,
    {} as never,
    {} as never,
    subscriptionService as never,
    lookup as never,
    addonService as never,
    {} as never,
    {} as never,
    timezoneMove as never,
    publishingQueue as never,
  );
  return { service, removed, subscriptionService, timezoneMove };
}

async function seedPlan(
  client: PoolClient,
  code: string,
  name: string,
): Promise<void> {
  await client.query(
    `INSERT INTO plans (code, name, base_price_cents, channels_per_workspace,
                        members_per_workspace, max_workspaces)
     VALUES ($1, $2, 0, 5, 5, 3)
     ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name`,
    [code, name],
  );
}

async function seedPost(
  client: PoolClient,
  ws: string,
  channelId: number,
  status: 'scheduled' | 'draft',
  jobId: string | null = null,
): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO posts (workspace_id, created_by_id, status, targets, scheduled_at, job_id)
     SELECT $1, w.owner_id, $2, $3::jsonb, $4, $5 FROM workspace w WHERE w.id = $1
     RETURNING id`,
    [
      ws,
      status,
      JSON.stringify([
        { channelId: String(channelId), platform: 'twitter', status },
      ]),
      status === 'scheduled' ? new Date('2027-01-15T09:00:00Z') : null,
      jobId,
    ],
  );
  return r.rows[0].id;
}

/** The brief's workspace: 3 channels (1 disconnected), 4 scheduled + 2 drafts, 2 MEMBERs, 1 ADMIN, 1 GUEST. */
async function seedAcme(client: PoolClient) {
  const { workspaceId: ws, ownerId } = await seedWorkspace(client);
  await client.query(`UPDATE workspace SET name = 'Acme' WHERE id = $1`, [ws]);
  const a = await seedChannel(client, ws, 'twitter');
  await seedChannel(client, ws, 'twitter');
  const gone = await seedChannel(client, ws, 'twitter');
  await client.query(
    `UPDATE social_media_channels
        SET connection_status = 'disconnected', disconnected_at = now()
      WHERE id = $1`,
    [gone],
  );
  const scheduled = [
    await seedPost(client, ws, a, 'scheduled', 'post-legacy-1'),
    await seedPost(client, ws, a, 'scheduled'),
    await seedPost(client, ws, a, 'scheduled'),
    await seedPost(client, ws, a, 'scheduled'),
  ];
  await seedPost(client, ws, a, 'draft');
  await seedPost(client, ws, a, 'draft');
  await seedMember(client, ws, 'MEMBER');
  await seedMember(client, ws, 'MEMBER');
  await seedMember(client, ws, 'ADMIN');
  await seedMember(client, ws, 'GUEST');
  return { ws, ownerId, scheduled };
}

async function seedSecondOwned(
  client: PoolClient,
  ownerId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO workspace (name, slug, owner_id, timezone)
     VALUES ('Second', 'second-' || substr(md5(random()::text), 1, 8), $1, 'UTC')`,
    [ownerId],
  );
}

async function workspaceExists(client: PoolClient, ws: string) {
  const r = await client.query(`SELECT 1 FROM workspace WHERE id = $1`, [ws]);
  return r.rowCount === 1;
}

async function codeOf(p: Promise<unknown>) {
  try {
    await p;
  } catch (error) {
    if (error instanceof HttpException) {
      return {
        status: error.getStatus(),
        code: (error.getResponse() as { code?: string }).code,
      };
    }
    throw error;
  }
  return undefined;
}

// NOT RUN in the lane worktree (no .env): the controller runs it after
// merge-back with PLANNER_DB_TESTS=1.
describeDb('WorkspaceService delete (database)', () => {
  it('previews what a delete takes: live channels, scheduled posts, members and guests', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      await seedPlan(client, 'FREE', 'Free');
      const { ws } = await seedAcme(client);
      const { service } = makeService(db as never, null);

      expect(await service.deletionPreview(ws)).toEqual({
        channels: 2,
        scheduledPosts: 4,
        members: 3,
        guests: 1,
        isLastOwnedWorkspace: true,
        planName: 'Free',
      });
    });
  });

  it('previews isLastOwnedWorkspace false with a second owned workspace, and the paid plan name', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      await seedPlan(client, 'PRO', 'Pro');
      const { ws, ownerId } = await seedAcme(client);
      await seedSecondOwned(client, ownerId);
      await client.query(
        `INSERT INTO subscriptions (user_id, plan_code, status) VALUES ($1, 'PRO', 'active')`,
        [ownerId],
      );
      const { service } = makeService(db as never, null);

      const preview = await service.deletionPreview(ws);
      expect(preview.isLastOwnedWorkspace).toBe(false);
      expect(preview.planName).toBe('Pro');
    });
  });

  it("deletes on ' Acme ', removes both job ids of every scheduled post, and cancels the last paid workspace's plan", async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const { ws, ownerId, scheduled } = await seedAcme(client);
      const { service, removed, subscriptionService, timezoneMove } =
        makeService(db as never, { planCode: 'PRO', status: 'active' });

      await service.remove(ws, ownerId, ' Acme ');

      expect(await workspaceExists(client, ws)).toBe(false);
      const expected = [
        ...scheduled.map((id) => `composer-publish-${id}`),
        'post-legacy-1',
      ];
      expect([...removed].sort()).toEqual([...expected].sort());
      for (const id of removed) expect(id).not.toContain(':');
      expect(timezoneMove.cancelPendingMove).toHaveBeenCalledWith(ws);
      expect(subscriptionService.cancelForAccount).toHaveBeenCalledWith(
        ownerId,
        true,
        expect.objectContaining({ changedByUserId: ownerId }),
      );
    });
  });

  it("refuses 'acme' with 400 CONFIRM_NAME_MISMATCH and the workspace stays", async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const { ws, ownerId } = await seedAcme(client);
      const { service, removed, subscriptionService } = makeService(
        db as never,
        { planCode: 'PRO', status: 'active' },
      );

      expect(await codeOf(service.remove(ws, ownerId, 'acme'))).toEqual({
        status: 400,
        code: 'CONFIRM_NAME_MISMATCH',
      });
      expect(await workspaceExists(client, ws)).toBe(true);
      expect(removed).toEqual([]);
      expect(subscriptionService.cancelForAccount).not.toHaveBeenCalled();
    });
  });

  it('keeps the plan when the owner has another workspace', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const { ws, ownerId } = await seedAcme(client);
      await seedSecondOwned(client, ownerId);
      const { service, subscriptionService } = makeService(db as never, {
        planCode: 'PRO',
        status: 'active',
      });

      await service.remove(ws, ownerId, 'Acme');

      expect(await workspaceExists(client, ws)).toBe(false);
      expect(subscriptionService.cancelForAccount).not.toHaveBeenCalled();
    });
  });

  it('cancels nothing on FREE', async () => {
    await withRollbackDb(MIGRATIONS, async (db, client) => {
      const { ws, ownerId } = await seedAcme(client);
      const { service, subscriptionService } = makeService(db as never, {
        planCode: 'FREE',
        status: 'active',
      });

      await service.remove(ws, ownerId, 'Acme');

      expect(await workspaceExists(client, ws)).toBe(false);
      expect(subscriptionService.cancelForAccount).not.toHaveBeenCalled();
    });
  });
});
