import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { WorkspaceHubService } from './workspace-hub.service';

/**
 * A db double whose `select()` chains resolve, in call order, to the arrays
 * given. The service issues: owned workspaces, accepted memberships, then —
 * only when there is at least one workspace — channels, owners, accepted
 * members and scheduled post counts.
 */
interface Chain extends PromiseLike<unknown[]> {
  from: () => Chain;
  where: (condition?: unknown) => Chain;
  innerJoin: () => Chain;
  groupBy: () => Chain;
}

function fakeDb(results: unknown[][]) {
  let i = 0;
  // The condition each select() was given, by call order.
  const wheres: unknown[] = [];
  const select = jest.fn(() => {
    const index = i++;
    const c: Chain = {
      from: () => c,
      where: (condition) => {
        wheres[index] = condition;
        return c;
      },
      innerJoin: () => c,
      groupBy: () => c,
      then: (resolve, reject) =>
        Promise.resolve(results[index] ?? []).then(resolve, reject),
    };
    return c;
  });
  return { db: { select }, select, wheres };
}

const NOW = new Date('2026-10-09T12:00:00Z');

describe('WorkspaceHubService.listSummaries', () => {
  it('never returns a soft-deleted joined workspace', async () => {
    const { db, wheres } = fakeDb([[], []]);
    const service = new WorkspaceHubService(db as never);

    await service.listSummaries('u-1', NOW);

    // A membership row survives its workspace's soft delete, so the joined
    // read has to ask the workspace table itself.
    const joined = new PgDialect().sqlToQuery(wheres[1] as SQL).sql;
    expect(joined).toContain(
      '"workspace_invitations"."workspace_id" in (select "workspace"."id" from "workspace" where "workspace"."deleted_at" is null)',
    );
  });

  it('reads the owner of a card only from a live workspace', async () => {
    const { db, wheres } = fakeDb([[{ id: 'ws-own' }], []]);
    const service = new WorkspaceHubService(db as never);

    await service.listSummaries('u-1', NOW);

    // select order: owned, joined, channels, owners.
    const owners = new PgDialect().sqlToQuery(wheres[3] as SQL).sql;
    expect(owners).toContain('"workspace"."deleted_at" is null');
  });

  it('returns no workspaces, and asks nothing more, for a user who belongs to none', async () => {
    const { db, select } = fakeDb([[], []]);
    const service = new WorkspaceHubService(db as never);

    await expect(service.listSummaries('u-1', NOW)).resolves.toEqual({
      workspaces: [],
    });
    expect(select).toHaveBeenCalledTimes(2);
  });

  it('builds one card per workspace the user owns or joined, counting each workspace once', async () => {
    const { db } = fakeDb([
      // owned
      [{ id: 'ws-own' }],
      // accepted memberships (ws-own repeated: an owner can hold an invite too)
      [{ id: 'ws-shared' }, { id: 'ws-own' }],
      // channels
      [
        {
          id: 1,
          workspaceId: 'ws-own',
          platform: 'instagram',
          accountName: 'daybreak',
          profilePictureUrl: null,
          connectionStatus: 'expired',
          tokenExpiresAt: null,
          hasRefreshToken: true,
          createdAt: new Date('2026-01-01T00:00:00Z'),
        },
      ],
      // owners
      [
        {
          workspaceId: 'ws-own',
          userId: 'u-1',
          name: 'Ali Raza',
          email: 'ali@daybreak.coffee',
          avatarUrl: null,
          avatarColor: 'blue',
        },
        {
          workspaceId: 'ws-shared',
          userId: 'u-2',
          name: null,
          email: 'jusco@x.com',
          avatarUrl: null,
          avatarColor: null,
        },
      ],
      // accepted members
      [
        {
          workspaceId: 'ws-shared',
          userId: 'u-1',
          name: 'Ali Raza',
          email: 'ali@daybreak.coffee',
          avatarUrl: null,
          avatarColor: 'blue',
          joinedAt: new Date('2026-03-01T00:00:00Z'),
        },
      ],
      // scheduled counts
      [{ workspaceId: 'ws-own', count: 5 }],
    ]);
    const service = new WorkspaceHubService(db as never);

    const { workspaces } = await service.listSummaries('u-1', NOW);

    expect(workspaces.map((w) => w.workspaceId)).toEqual([
      'ws-own',
      'ws-shared',
    ]);
    expect(workspaces[0]).toMatchObject({
      channelCount: 1,
      reconnect: [{ id: 1, platform: 'instagram' }],
      memberCount: 1,
      members: [{ id: 'u-1', name: 'Ali Raza', avatarColor: 'blue' }],
      scheduledNext7Days: 5,
    });
    // The owner leads; the invited user follows.
    expect(workspaces[1].members.map((m) => m.id)).toEqual(['u-2', 'u-1']);
    expect(workspaces[1].members[0].name).toBe('jusco');
    expect(workspaces[1].scheduledNext7Days).toBe(0);
  });
});
