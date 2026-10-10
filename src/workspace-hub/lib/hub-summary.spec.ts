import {
  PREVIEW_LIMIT,
  buildHubSummaries,
  displayNameOf,
  needsReconnect,
  type HubChannelRow,
  type HubMemberRow,
} from './hub-summary';

const NOW = new Date('2026-10-09T12:00:00Z');
const WS = 'ws-1';

const channel = (over: Partial<HubChannelRow>): HubChannelRow => ({
  id: 1,
  workspaceId: WS,
  platform: 'instagram',
  accountName: 'daybreak',
  profilePictureUrl: null,
  connectionStatus: 'connected',
  tokenExpiresAt: null,
  hasRefreshToken: true,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  ...over,
});

const member = (over: Partial<HubMemberRow>): HubMemberRow => ({
  workspaceId: WS,
  userId: 'u-1',
  name: 'Ali Raza',
  email: 'ali@daybreak.coffee',
  avatarUrl: null,
  avatarColor: null,
  isOwner: false,
  joinedAt: new Date('2026-02-01T00:00:00Z'),
  ...over,
});

describe('needsReconnect', () => {
  it.each(['expired', 'revoked', 'error'])(
    'is true when the connection is %s',
    (status) => {
      expect(needsReconnect(channel({ connectionStatus: status }), NOW)).toBe(
        true,
      );
    },
  );

  it('is false for a connected channel whose token is still valid', () => {
    const row = channel({
      tokenExpiresAt: new Date('2026-10-10T00:00:00Z'),
      hasRefreshToken: false,
    });
    expect(needsReconnect(row, NOW)).toBe(false);
  });

  it('is true when the access token has expired and nothing can refresh it', () => {
    const row = channel({
      tokenExpiresAt: new Date('2026-10-09T11:59:59Z'),
      hasRefreshToken: false,
    });
    expect(needsReconnect(row, NOW)).toBe(true);
  });

  it('is false when the access token has expired but a refresh token can renew it', () => {
    // Google access tokens lapse hourly and are renewed on use; warning on
    // every one of them would cry wolf.
    const row = channel({
      tokenExpiresAt: new Date('2026-10-09T11:00:00Z'),
      hasRefreshToken: true,
    });
    expect(needsReconnect(row, NOW)).toBe(false);
  });

  it('is false while a refresh is in progress', () => {
    expect(
      needsReconnect(channel({ connectionStatus: 'refreshing' }), NOW),
    ).toBe(false);
  });
});

describe('displayNameOf', () => {
  it('uses the name when there is one', () => {
    expect(displayNameOf('  Sara Khan ', 'sara@x.com')).toBe('Sara Khan');
  });

  it('falls back to the part of the email before the @', () => {
    // Email-code sign-ups have no name until onboarding asks for one.
    expect(displayNameOf(null, 'sara.khan@x.com')).toBe('sara.khan');
    expect(displayNameOf('   ', 'sara@x.com')).toBe('sara');
  });
});

describe('buildHubSummaries', () => {
  it('returns one summary per workspace id, in the order given, even with no data', () => {
    const out = buildHubSummaries(['ws-b', 'ws-a'], [], [], [], NOW);
    expect(out.map((s) => s.workspaceId)).toEqual(['ws-b', 'ws-a']);
    expect(out[0]).toEqual({
      workspaceId: 'ws-b',
      channelCount: 0,
      channels: [],
      reconnect: [],
      memberCount: 0,
      members: [],
      scheduledNext7Days: 0,
    });
  });

  it('counts social channels only, by platform, never messaging or integrations', () => {
    const out = buildHubSummaries(
      [WS],
      [
        channel({ id: 1, platform: 'instagram' }),
        channel({ id: 2, platform: 'slack' }),
        channel({ id: 3, platform: 'google_drive' }),
        channel({ id: 4, platform: 'linkedin' }),
        channel({ id: 5, platform: 'not_a_platform' }),
      ],
      [],
      [],
      NOW,
    );
    expect(out[0].channelCount).toBe(2);
    expect(out[0].channels.map((c) => c.platform)).toEqual([
      'instagram',
      'linkedin',
    ]);
  });

  it('previews the oldest channels first, at most PREVIEW_LIMIT, while counting all', () => {
    const rows = [5, 1, 4, 2, 3].map((n) =>
      channel({
        id: n,
        accountName: `acct-${n}`,
        createdAt: new Date(`2026-01-0${n}T00:00:00Z`),
      }),
    );
    const out = buildHubSummaries([WS], rows, [], [], NOW)[0];
    expect(out.channelCount).toBe(5);
    expect(out.channels).toHaveLength(PREVIEW_LIMIT);
    expect(out.channels.map((c) => c.id)).toEqual([1, 2, 3]);
  });

  it('shapes a channel without leaking token fields', () => {
    const out = buildHubSummaries(
      [WS],
      [channel({ id: 7, profilePictureUrl: 'https://cdn/p.jpg' })],
      [],
      [],
      NOW,
    )[0];
    expect(out.channels[0]).toEqual({
      id: 7,
      platform: 'instagram',
      accountName: 'daybreak',
      avatarUrl: 'https://cdn/p.jpg',
    });
  });

  it('lists every social channel that needs reconnecting, not just the previewed ones', () => {
    const rows = [1, 2, 3, 4].map((n) =>
      channel({
        id: n,
        createdAt: new Date(`2026-01-0${n}T00:00:00Z`),
        connectionStatus: n === 4 ? 'expired' : 'connected',
      }),
    );
    rows.push(channel({ id: 9, platform: 'slack', connectionStatus: 'error' }));
    const out = buildHubSummaries([WS], rows, [], [], NOW)[0];
    expect(out.reconnect.map((c) => c.id)).toEqual([4]);
  });

  it('keeps each workspace’s channels, members and posts apart', () => {
    const out = buildHubSummaries(
      ['ws-a', 'ws-b'],
      [channel({ id: 1, workspaceId: 'ws-a' })],
      [member({ workspaceId: 'ws-b', isOwner: true })],
      [{ workspaceId: 'ws-b', count: 4 }],
      NOW,
    );
    expect(out[0]).toMatchObject({
      channelCount: 1,
      memberCount: 0,
      scheduledNext7Days: 0,
    });
    expect(out[1]).toMatchObject({
      channelCount: 0,
      memberCount: 1,
      scheduledNext7Days: 4,
    });
  });

  it('puts the owner first, then members in the order they joined', () => {
    const out = buildHubSummaries(
      [WS],
      [],
      [
        member({
          userId: 'late',
          name: 'Late',
          joinedAt: new Date('2026-05-01'),
        }),
        member({
          userId: 'owner',
          name: 'Owner',
          isOwner: true,
          joinedAt: null,
        }),
        member({
          userId: 'early',
          name: 'Early',
          joinedAt: new Date('2026-03-01'),
        }),
        member({
          userId: 'later',
          name: 'Later',
          joinedAt: new Date('2026-06-01'),
        }),
      ],
      [],
      NOW,
    )[0];
    expect(out.memberCount).toBe(4);
    expect(out.members.map((m) => m.id)).toEqual(['owner', 'early', 'late']);
  });

  it('counts a person once even if they own the workspace and also hold an invitation to it', () => {
    const out = buildHubSummaries(
      [WS],
      [],
      [
        member({ userId: 'u-1', isOwner: true, joinedAt: null }),
        // The same person's accepted invitation, newer than u-2's.
        member({ userId: 'u-1', joinedAt: new Date('2026-09-01') }),
        member({ userId: 'u-2', joinedAt: new Date('2026-02-01') }),
      ],
      [],
      NOW,
    )[0];
    expect(out.memberCount).toBe(2);
    // Counted as the owner, so still first — not placed by the invitation date.
    expect(out.members.map((m) => m.id)).toEqual(['u-1', 'u-2']);
  });

  it('shapes a member with a display name and no email', () => {
    const out = buildHubSummaries(
      [WS],
      [],
      [
        member({
          userId: 'u-9',
          name: null,
          email: 'zara@x.com',
          avatarUrl: 'https://cdn/a.png',
          avatarColor: 'violet',
        }),
      ],
      [],
      NOW,
    )[0];
    expect(out.members[0]).toEqual({
      id: 'u-9',
      name: 'zara',
      avatarUrl: 'https://cdn/a.png',
      avatarColor: 'violet',
    });
  });
});
