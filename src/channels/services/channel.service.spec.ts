import { ChannelService } from './channel.service';

// Minimal fake db that records the query builder chain and returns canned rows.
const rows = [
  { id: 7, workspaceId: 'ws-A' },
  { id: 3, workspaceId: 'ws-B' },
];
jest.mock('../../drizzle/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => Promise.resolve(rows),
        }),
      }),
    }),
  },
}));

describe('ChannelService.findChannelsByPlatformAccountAllWorkspaces', () => {
  it('returns every workspace holding this platform account', async () => {
    // ChannelService's constructor takes (oauthService, syncLifecycle) — neither
    // is touched by this method, so stub both.
    const service = new ChannelService({} as any, {} as any);
    const res = await service.findChannelsByPlatformAccountAllWorkspaces(
      'whatsapp',
      '111',
    );
    expect(res).toEqual(rows);
  });
});
