import {
  channelHealth,
  isExpiringWithin,
  postingFailsAt,
  refreshTokenExpiresAt,
  type ChannelHealthInput,
} from './channel-health';

const NOW = new Date('2026-11-12T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const days = (n: number) => new Date(NOW.getTime() + n * DAY);

const base = (over: Partial<ChannelHealthInput> = {}): ChannelHealthInput => ({
  platform: 'mastodon',
  isActive: true,
  pausedAt: null,
  connectionStatus: 'connected',
  lastError: null,
  tokenExpiresAt: null,
  refreshToken: null,
  refreshTokenIssuedAt: null,
  ...over,
});

describe('channelHealth precedence', () => {
  it('a token that never expires is ok', () => {
    expect(channelHealth(base(), { now: NOW })).toEqual({ kind: 'ok' });
  });

  it('locked beats paused, which beats reconnect', () => {
    const broken = base({
      connectionStatus: 'revoked',
      pausedAt: days(-1),
      isActive: false,
    });
    expect(channelHealth(broken, { now: NOW }).kind).toBe('locked');
    expect(
      channelHealth({ ...broken, isActive: true }, { now: NOW }).kind,
    ).toBe('paused');
    expect(
      channelHealth({ ...broken, isActive: true, pausedAt: null }, { now: NOW })
        .kind,
    ).toBe('reconnect');
  });

  it('paused carries when and by whom', () => {
    const who = { id: 'u1', name: 'Asad' };
    expect(
      channelHealth(base({ pausedAt: days(-2) }), { now: NOW, pausedBy: who }),
    ).toEqual({
      kind: 'paused',
      pausedAt: days(-2).toISOString(),
      pausedBy: who,
    });
    expect(
      channelHealth(base({ pausedAt: days(-2) }), { now: NOW }).pausedBy,
    ).toBeNull();
  });

  it.each(['expired', 'revoked', 'error'])(
    "status '%s' needs a reconnect, with the last error as the reason",
    (status) => {
      expect(
        channelHealth(
          base({ connectionStatus: status, lastError: 'Token revoked' }),
          { now: NOW },
        ),
      ).toEqual({ kind: 'reconnect', reason: 'Token revoked' });
    },
  );

  it('an expired access token with no refresh token needs a reconnect', () => {
    expect(
      channelHealth(base({ platform: 'facebook', tokenExpiresAt: days(-1) }), {
        now: NOW,
      }),
    ).toEqual({ kind: 'reconnect', reason: null });
  });

  it('an expired access token that can still refresh is ok', () => {
    expect(
      channelHealth(
        base({
          platform: 'tiktok', // refreshes; 365-day refresh token
          tokenExpiresAt: days(-1),
          refreshToken: 'enc',
          refreshTokenIssuedAt: days(-10),
        }),
        { now: NOW },
      ).kind,
    ).toBe('ok');
  });

  it('a refresh token whose TTL has passed needs a reconnect', () => {
    expect(
      channelHealth(
        base({
          platform: 'tiktok',
          tokenExpiresAt: days(-1),
          refreshToken: 'enc',
          refreshTokenIssuedAt: days(-400),
        }),
        { now: NOW },
      ).kind,
    ).toBe('reconnect');
  });

  it('a non-refreshing token ending within 7 days is expiring, with when', () => {
    expect(
      channelHealth(base({ platform: 'facebook', tokenExpiresAt: days(5) }), {
        now: NOW,
      }),
    ).toEqual({ kind: 'expiring', expiresAt: days(5).toISOString() });
    expect(
      channelHealth(base({ platform: 'facebook', tokenExpiresAt: days(8) }), {
        now: NOW,
      }).kind,
    ).toBe('ok');
  });

  it('a refreshing channel is expiring when its refresh TTL ends within 7 days', () => {
    // twitter: 180-day refresh token, refreshes itself.
    const ch = base({
      platform: 'twitter',
      tokenExpiresAt: days(0.05),
      refreshToken: 'enc',
      refreshTokenIssuedAt: days(-175),
    });
    expect(channelHealth(ch, { now: NOW })).toEqual({
      kind: 'expiring',
      expiresAt: days(5).toISOString(),
    });
  });

  it('a refreshing channel with an access token about to expire is NOT expiring', () => {
    const ch = base({
      platform: 'twitter',
      tokenExpiresAt: days(0.05),
      refreshToken: 'enc',
      refreshTokenIssuedAt: days(-10),
    });
    expect(channelHealth(ch, { now: NOW }).kind).toBe('ok');
  });
});

describe('postingFailsAt', () => {
  it('refreshing: the later of access expiry and refresh expiry', () => {
    const ch = {
      platform: 'linkedin', // 60-day refresh
      connectionStatus: 'connected',
      tokenExpiresAt: days(50),
      refreshToken: 'enc',
      refreshTokenIssuedAt: days(-20),
    };
    expect(postingFailsAt(ch)).toEqual(days(50));
    expect(postingFailsAt({ ...ch, tokenExpiresAt: days(10) })).toEqual(
      days(40),
    );
  });

  it('refreshing with an unknown refresh age never fails on its own', () => {
    expect(
      postingFailsAt({
        platform: 'linkedin',
        tokenExpiresAt: days(1),
        refreshToken: 'enc',
        refreshTokenIssuedAt: null,
      }),
    ).toBeNull();
  });

  it('not refreshing: the earlier of the two', () => {
    expect(
      postingFailsAt({
        platform: 'facebook',
        tokenExpiresAt: days(30),
        refreshToken: 'enc',
        refreshTokenIssuedAt: days(-50), // 60-day TTL -> days(10)
      }),
    ).toEqual(days(10));
  });

  it('honours the env TTL override', () => {
    const prev = process.env.YOUTUBE_REFRESH_TOKEN_TTL_DAYS;
    process.env.YOUTUBE_REFRESH_TOKEN_TTL_DAYS = '36500';
    try {
      expect(
        refreshTokenExpiresAt({
          platform: 'youtube',
          refreshToken: 'enc',
          refreshTokenIssuedAt: days(0),
        }),
      ).toEqual(days(36500));
    } finally {
      if (prev === undefined) delete process.env.YOUTUBE_REFRESH_TOKEN_TTL_DAYS;
      else process.env.YOUTUBE_REFRESH_TOKEN_TTL_DAYS = prev;
    }
  });
});

describe('isExpiringWithin (/expiring)', () => {
  it('keeps the original access-token rule', () => {
    const ch = {
      platform: 'twitter',
      tokenExpiresAt: days(2),
      refreshToken: null,
      refreshTokenIssuedAt: null,
    };
    expect(isExpiringWithin(ch, 7, NOW)).toBe(true);
    expect(isExpiringWithin(ch, 1, NOW)).toBe(false);
    expect(isExpiringWithin({ ...ch, tokenExpiresAt: days(-1) }, 7, NOW)).toBe(
      false,
    );
  });

  it('also catches a refresh token whose TTL ends in the window', () => {
    const ch = {
      platform: 'twitter', // 180 days
      tokenExpiresAt: null,
      refreshToken: 'enc',
      refreshTokenIssuedAt: days(-176),
    };
    expect(isExpiringWithin(ch, 7, NOW)).toBe(true);
    expect(isExpiringWithin(ch, 3, NOW)).toBe(false);
    expect(
      isExpiringWithin({ ...ch, refreshTokenIssuedAt: days(-200) }, 7, NOW),
    ).toBe(false);
  });
});
