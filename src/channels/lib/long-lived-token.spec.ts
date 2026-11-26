import {
  expiryFrom,
  isLongLivedPlatform,
  shouldRenew,
  MIN_TOKEN_AGE_HOURS,
  RENEW_BEFORE_DAYS,
} from './long-lived-token';

const NOW = new Date('2026-11-26T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

/** A channel whose token expires `days` from NOW, last written long ago. */
function channel(platform: string, days: number | null) {
  return {
    platform,
    tokenExpiresAt: days === null ? null : new Date(NOW.getTime() + days * DAY),
    updatedAt: new Date(NOW.getTime() - 30 * DAY),
  };
}

describe('isLongLivedPlatform', () => {
  it('covers the two platforms whose tokens actually lapse', () => {
    expect(isLongLivedPlatform('instagram')).toBe(true);
    expect(isLongLivedPlatform('threads')).toBe(true);
  });

  it('leaves Facebook out, because Page tokens do not expire', () => {
    // Not an oversight. `channel-connect.service.ts` stores a PAGE access
    // token for Facebook with `tokenExpiresAt: undefined`, and Meta documents
    // long-lived Page tokens as having no expiry. Including Facebook would
    // spend a renewal call on a token with nothing to renew.
    expect(isLongLivedPlatform('facebook')).toBe(false);
  });

  it('leaves the OAuth2 platforms to the existing refresh-token cron', () => {
    // These have a real refresh_token, so TokenRefreshScheduler already
    // handles them every 10 minutes. Renewing them here would double up.
    for (const p of ['youtube', 'tiktok', 'linkedin', 'twitter', 'pinterest']) {
      expect(isLongLivedPlatform(p)).toBe(false);
    }
  });
});

describe('shouldRenew', () => {
  it('renews a token inside the window', () => {
    expect(shouldRenew(channel('instagram', 5), NOW)).toEqual({ renew: true });
    expect(shouldRenew(channel('threads', 1), NOW)).toEqual({ renew: true });
  });

  it('leaves a token alone while it still has plenty of life', () => {
    expect(shouldRenew(channel('instagram', 45), NOW)).toEqual({
      renew: false,
      reason: 'not-due',
    });
  });

  it('renews exactly at the window edge', () => {
    // A token due in just under RENEW_BEFORE_DAYS is in; one due in more is
    // out. Pinned so the boundary cannot drift silently.
    const inside = channel('instagram', RENEW_BEFORE_DAYS - 0.01);
    const outside = channel('instagram', RENEW_BEFORE_DAYS + 0.01);
    expect(shouldRenew(inside, NOW).renew).toBe(true);
    expect(shouldRenew(outside, NOW).renew).toBe(false);
  });

  it('does not touch a platform it does not own', () => {
    expect(shouldRenew(channel('youtube', 2), NOW)).toEqual({
      renew: false,
      reason: 'not-long-lived',
    });
    expect(shouldRenew(channel('facebook', 2), NOW)).toEqual({
      renew: false,
      reason: 'not-long-lived',
    });
  });

  it('treats a missing expiry as nothing to renew, not as overdue', () => {
    // The Instagram channel created beside a Facebook Page shares the Page's
    // non-expiring token and records no expiry. Renewing on a null date would
    // hammer Meta for every such channel, every day.
    expect(shouldRenew(channel('instagram', null), NOW)).toEqual({
      renew: false,
      reason: 'no-expiry',
    });
  });

  it('reports an already-expired token separately from a not-due one', () => {
    // Meta refuses to renew a lapsed token, so this cannot be fixed by a
    // call — only by the user reconnecting. The caller needs to tell the two
    // apart to know which one to email about.
    expect(shouldRenew(channel('instagram', -1), NOW)).toEqual({
      renew: false,
      reason: 'already-expired',
    });
  });

  it('respects Meta’s 24-hour minimum token age', () => {
    // Meta rejects a renewal for a token younger than 24h. A channel
    // connected an hour ago is inside the window only if its expiry is odd,
    // but the guard must hold regardless.
    const justConnected = {
      platform: 'instagram',
      tokenExpiresAt: new Date(NOW.getTime() + 2 * DAY),
      updatedAt: new Date(NOW.getTime() - 1 * 60 * 60 * 1000),
    };
    expect(shouldRenew(justConnected, NOW)).toEqual({
      renew: false,
      reason: 'too-young',
    });

    const oldEnough = {
      ...justConnected,
      updatedAt: new Date(NOW.getTime() - (MIN_TOKEN_AGE_HOURS + 1) * 3600_000),
    };
    expect(shouldRenew(oldEnough, NOW).renew).toBe(true);
  });

  it('renews when the row has no updatedAt rather than never renewing', () => {
    // A missing timestamp must not become a permanent block: the cost of
    // being wrong is one rejected API call, versus the token lapsing.
    expect(
      shouldRenew(
        {
          platform: 'threads',
          tokenExpiresAt: new Date(NOW.getTime() + 3 * DAY),
          updatedAt: null,
        },
        NOW,
      ),
    ).toEqual({ renew: true });
  });

  it('does not invent a renewal from an unparseable expiry', () => {
    expect(
      shouldRenew({ platform: 'instagram', tokenExpiresAt: 'not-a-date' }, NOW),
    ).toEqual({ renew: false, reason: 'no-expiry' });
  });
});

describe('expiryFrom', () => {
  it('uses what Meta returned', () => {
    // Meta's real answer is ~5,183,944s — just under 60 days.
    expect(expiryFrom(5_183_944, NOW).toISOString()).toBe(
      new Date(NOW.getTime() + 5_183_944 * 1000).toISOString(),
    );
  });

  it('falls back to 60 days when Meta says nothing', () => {
    // 60 days is the documented lifetime for all of these tokens. Guessing
    // shorter would renew needlessly; longer would miss the window entirely.
    const expected = new Date(NOW.getTime() + 60 * DAY).toISOString();
    expect(expiryFrom(null, NOW).toISOString()).toBe(expected);
    expect(expiryFrom(undefined, NOW).toISOString()).toBe(expected);
    expect(expiryFrom(0, NOW).toISOString()).toBe(expected);
  });
});
