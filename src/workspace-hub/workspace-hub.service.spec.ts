import { WorkspaceHubService } from './workspace-hub.service';

/**
 * A db double whose `select()` chains resolve, in call order, to the arrays
 * given. The service issues: owned workspaces, accepted memberships, then —
 * only when there is at least one workspace — channels, owners, accepted
 * members and scheduled post counts.
 */
interface Chain extends PromiseLike<unknown[]> {
  from: () => Chain;
  where: () => Chain;
  innerJoin: () => Chain;
  groupBy: () => Chain;
}

function fakeDb(results: unknown[][]) {
  let i = 0;
  const select = jest.fn(() => {
    const index = i++;
    const c: Chain = {
      from: () => c,
      where: () => c,
      innerJoin: () => c,
      groupBy: () => c,
      then: (resolve, reject) =>
        Promise.resolve(results[index] ?? []).then(resolve, reject),
    };
    return c;
  });
  return { db: { select }, select };
}

const NOW = new Date('2026-10-09T12:00:00Z');

describe('WorkspaceHubService.listSummaries', () => {
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
