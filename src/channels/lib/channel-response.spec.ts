import { toChannelResponse, type ChannelRow } from './channel-response';

const row = (over: Partial<ChannelRow> = {}): ChannelRow =>
  ({
    id: 1,
    workspaceId: 'ws',
    platform: 'bluesky',
    category: 'social',
    accountType: 'profile',
    platformAccountId: 'acc',
    accountName: 'Bluesky',
    nickname: null,
    username: null,
    profilePictureUrl: null,
    permissions: [],
    capabilities: null,
    isActive: true,
    connectionStatus: 'connected',
    lastError: null,
    lastSyncedAt: null,
    lastPostedAt: null,
    metadata: {},
    displayOrder: 1,
    timezone: 'UTC',
    color: null,
    tokenExpiresAt: null,
    refreshToken: null,
    refreshTokenIssuedAt: null,
    pausedAt: null,
    pausedByUserId: null,
    connectedByUserId: 'u1',
    connectLinkId: null,
    addedViaLinkAt: null,
    addedViaLinkEmail: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  }) as ChannelRow;

describe('toChannelResponse - connectedVia', () => {
  it('presentOne maps connectedVia from addedViaLinkAt and the email', () => {
    const dto = toChannelResponse(
      row({
        connectLinkId: 'link-1',
        addedViaLinkAt: new Date('2026-11-01T00:00:00Z'),
        addedViaLinkEmail: 'client@example.com',
      }),
      new Map(),
    );
    expect(dto.connectedVia).toEqual({
      kind: 'link',
      email: 'client@example.com',
    });
  });

  it('a link channel without an email maps email: null', () => {
    const dto = toChannelResponse(
      row({ addedViaLinkAt: new Date(), addedViaLinkEmail: null }),
      new Map(),
    );
    expect(dto.connectedVia).toEqual({ kind: 'link', email: null });
  });

  it('is null for a channel nobody added through a link', () => {
    expect(toChannelResponse(row(), new Map()).connectedVia).toBeNull();
  });

  it('a stray connectLinkId without addedViaLinkAt is not "via link"', () => {
    const dto = toChannelResponse(row({ connectLinkId: 'link-1' }), new Map());
    expect(dto.connectedVia).toBeNull();
  });
});
