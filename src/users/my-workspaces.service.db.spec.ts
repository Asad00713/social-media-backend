import type { PoolClient } from 'pg';
import {
  describeDb,
  withRollbackDb,
  type DbType,
} from '../planner/testing/rollback-db';
import { MyWorkspacesService } from './my-workspaces.service';

// 0080: REMOVED invitations. 0089: workspace columns the schema selects.
// 0091 is not needed: nothing here deletes a user.
const MIGRATIONS = [
  '0080_member_soft_removal.sql',
  '0088_user_account_settings.sql',
  '0089_workspace_settings.sql',
];

const rand = () => Math.random().toString(36).slice(2, 10);

async function seedUser(
  client: PoolClient,
  name: string | null,
): Promise<{ id: string; email: string }> {
  const email = `mw-${rand()}@example.test`;
  const r = await client.query<{ id: string }>(
    `INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id`,
    [email, name],
  );
  return { id: r.rows[0].id, email };
}

async function seedWorkspace(
  client: PoolClient,
  ownerId: string,
  name: string,
): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO workspace (name, slug, owner_id) VALUES ($1, $2, $3) RETURNING id`,
    [name, `mw-${rand()}`, ownerId],
  );
  return r.rows[0].id;
}

async function seedPlan(
  client: PoolClient,
  code: string,
  name: string,
): Promise<void> {
  // The plan rows may or may not exist locally; the transaction is rolled
  // back either way.
  await client.query(
    `INSERT INTO plans (code, name, base_price_cents, channels_per_workspace,
                        members_per_workspace, max_workspaces)
     VALUES ($1, $2, 0, 5, 5, 3)
     ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name`,
    [code, name],
  );
}

async function seedSubscription(
  client: PoolClient,
  userId: string,
  planCode: string,
  status: string,
): Promise<void> {
  await client.query(
    `INSERT INTO subscriptions (user_id, plan_code, status) VALUES ($1, $2, $3)`,
    [userId, planCode, status],
  );
}

async function seedMembership(
  client: PoolClient,
  workspaceId: string,
  user: { id: string; email: string },
  role: 'ADMIN' | 'MEMBER' | 'GUEST',
  status: 'ACCEPTED' | 'PENDING' | 'REMOVED',
  invitedBy: string | null,
): Promise<void> {
  await client.query(
    `INSERT INTO workspace_invitations
       (workspace_id, email, user_id, role, status, invited_by, token, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now() + interval '7 days')`,
    [
      workspaceId,
      user.email,
      user.id,
      role,
      status,
      invitedBy,
      rand() + rand(),
    ],
  );
}

function run<T>(
  fn: (service: MyWorkspacesService, client: PoolClient) => Promise<T>,
): Promise<T> {
  return withRollbackDb(MIGRATIONS, (db: DbType, client) =>
    fn(new MyWorkspacesService(db), client),
  );
}

describeDb('MyWorkspacesService (database)', () => {
  it('lists owned and joined workspaces, never a removed one', async () => {
    await run(async (service, client) => {
      await seedPlan(client, 'FREE', 'Free');
      await seedPlan(client, 'PRO', 'Pro');
      const me = await seedUser(client, 'Me');
      const hina = await seedUser(client, 'Hina');
      await seedSubscription(client, me.id, 'PRO', 'active');

      const w1 = await seedWorkspace(client, me.id, 'Mine');
      const w2 = await seedWorkspace(client, hina.id, 'Hina Studio');
      const w3 = await seedWorkspace(client, hina.id, 'Left Long Ago');
      await seedMembership(client, w2, me, 'MEMBER', 'ACCEPTED', hina.id);
      await seedMembership(client, w3, me, 'MEMBER', 'REMOVED', hina.id);

      const { workspaces } = await service.list(me.id);

      expect(workspaces).toEqual([
        {
          id: w1,
          name: 'Mine',
          logo: null,
          role: 'OWNER',
          planName: 'Pro',
          invitedByName: null,
          ownerName: 'Me',
        },
        {
          id: w2,
          name: 'Hina Studio',
          logo: null,
          role: 'MEMBER',
          planName: 'Free',
          invitedByName: 'Hina',
          ownerName: 'Hina',
        },
      ]);
    });
  });

  it('a PENDING invitation is not a workspace of mine yet', async () => {
    await run(async (service, client) => {
      await seedPlan(client, 'FREE', 'Free');
      const me = await seedUser(client, 'Me');
      const hina = await seedUser(client, 'Hina');
      const w = await seedWorkspace(client, hina.id, 'Not Yet');
      await seedMembership(client, w, me, 'MEMBER', 'PENDING', hina.id);

      expect((await service.list(me.id)).workspaces).toEqual([]);
    });
  });

  it('owned workspaces first, then the rest by name', async () => {
    await run(async (service, client) => {
      await seedPlan(client, 'FREE', 'Free');
      const me = await seedUser(client, 'Me');
      const hina = await seedUser(client, 'Hina');
      const zOwned = await seedWorkspace(client, me.id, 'Zeta');
      const aOwned = await seedWorkspace(client, me.id, 'Alpha');
      const bJoined = await seedWorkspace(client, hina.id, 'Beta');
      const aJoined = await seedWorkspace(client, hina.id, 'Aardvark');
      await seedMembership(client, bJoined, me, 'ADMIN', 'ACCEPTED', hina.id);
      await seedMembership(client, aJoined, me, 'GUEST', 'ACCEPTED', hina.id);

      const ids = (await service.list(me.id)).workspaces.map((w) => w.id);
      expect(ids).toEqual([aOwned, zOwned, aJoined, bJoined]);
    });
  });

  it('the plan name comes from the OWNER subscription, and only a live one counts', async () => {
    await run(async (service, client) => {
      await seedPlan(client, 'FREE', 'Free');
      await seedPlan(client, 'PRO', 'Pro');
      await seedPlan(client, 'MAX', 'Max');
      const me = await seedUser(client, 'Me');
      const trialOwner = await seedUser(client, 'Trial');
      const lapsedOwner = await seedUser(client, 'Lapsed');
      // MY plan must not leak onto a workspace somebody else owns.
      await seedSubscription(client, me.id, 'MAX', 'active');
      await seedSubscription(client, trialOwner.id, 'PRO', 'trialing');
      await seedSubscription(client, lapsedOwner.id, 'PRO', 'canceled');

      const wTrial = await seedWorkspace(client, trialOwner.id, 'Trial Co');
      const wLapsed = await seedWorkspace(client, lapsedOwner.id, 'Lapsed Co');
      await seedMembership(client, wTrial, me, 'MEMBER', 'ACCEPTED', null);
      await seedMembership(client, wLapsed, me, 'MEMBER', 'ACCEPTED', null);

      const byId = new Map(
        (await service.list(me.id)).workspaces.map((w) => [w.id, w]),
      );
      expect(byId.get(wTrial)?.planName).toBe('Pro');
      expect(byId.get(wLapsed)?.planName).toBe('Free');
    });
  });

  it('past_due still counts as the paid plan', async () => {
    await run(async (service, client) => {
      await seedPlan(client, 'FREE', 'Free');
      await seedPlan(client, 'PRO', 'Pro');
      const me = await seedUser(client, 'Me');
      await seedSubscription(client, me.id, 'PRO', 'past_due');
      await seedWorkspace(client, me.id, 'Overdue');

      expect((await service.list(me.id)).workspaces[0].planName).toBe('Pro');
    });
  });

  it('invitedByName is null when the inviter is gone, and falls back to the email when they have no name', async () => {
    await run(async (service, client) => {
      await seedPlan(client, 'FREE', 'Free');
      const me = await seedUser(client, 'Me');
      const owner = await seedUser(client, null);
      const wGone = await seedWorkspace(client, owner.id, 'Gone Inviter');
      const wNameless = await seedWorkspace(client, owner.id, 'Nameless');
      await seedMembership(client, wGone, me, 'MEMBER', 'ACCEPTED', null);
      await seedMembership(
        client,
        wNameless,
        me,
        'MEMBER',
        'ACCEPTED',
        owner.id,
      );

      const byId = new Map(
        (await service.list(me.id)).workspaces.map((w) => [w.id, w]),
      );
      expect(byId.get(wGone)?.invitedByName).toBeNull();
      expect(byId.get(wNameless)?.invitedByName).toBe(owner.email);
      // The owner name falls back to the email the same way.
      expect(byId.get(wNameless)?.ownerName).toBe(owner.email);
    });
  });

  it('a person with no workspaces gets an empty list', async () => {
    await run(async (service, client) => {
      await seedPlan(client, 'FREE', 'Free');
      const me = await seedUser(client, 'Me');
      expect(await service.list(me.id)).toEqual({ workspaces: [] });
    });
  });
});
