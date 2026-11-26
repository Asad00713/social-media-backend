import { Logger } from '@nestjs/common';
import {
  getRefreshTokenTtlDays,
  type SupportedPlatform,
} from '../../drizzle/schema/channels.schema';
import { isExpiringWithin, refreshTokenExpiresAt } from './channel-health';
import { toChannelResponse } from './channel-response';
import { RefreshTokenExpiryScheduler } from '../schedulers/refresh-token-expiry.scheduler';
import { ChannelHealthNotifier } from '../services/channel-health-notifier.service';
import { AppLinks } from '../../email/links/app-links';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-11-26T12:00:00Z');
const WS = 'ws-1';
const OWNER = { id: 'u-owner', email: 'owner@x.test', name: 'Owner' };

/**
 * The five platforms served by our single Google OAuth app. They share one
 * publishing status, so they share one refresh-token rule.
 */
const GOOGLE_PLATFORMS: SupportedPlatform[] = [
  'youtube',
  'google_business',
  'google_drive',
  'google_photos',
  'google_calendar',
];

/** A freshly-connected Google channel: the grant was issued moments ago. */
function freshGoogleChannel(platform: SupportedPlatform) {
  return {
    platform,
    tokenExpiresAt: null,
    refreshToken: 'enc:refresh',
    refreshTokenIssuedAt: new Date(NOW.getTime() - 60 * 1000),
  };
}

describe('Google refresh-token TTL', () => {
  const saved: Record<string, string | undefined> = {};
  const envKey = (p: SupportedPlatform) =>
    `${p.toUpperCase().replace(/-/g, '_')}_REFRESH_TOKEN_TTL_DAYS`;

  beforeEach(() => {
    // The override path is real configuration: a deployment may have it set,
    // which would mask the default this suite is about.
    for (const p of GOOGLE_PLATFORMS) {
      saved[envKey(p)] = process.env[envKey(p)];
      delete process.env[envKey(p)];
    }
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it.each(GOOGLE_PLATFORMS)(
    '%s reports no refresh-token expiry',
    (platform) => {
      expect(getRefreshTokenTtlDays(platform)).toBeNull();
    },
  );

  it.each(GOOGLE_PLATFORMS)(
    'a freshly-connected %s channel has no refresh-token deadline',
    (platform) => {
      expect(refreshTokenExpiresAt(freshGoogleChannel(platform))).toBeNull();
    },
  );

  it.each(GOOGLE_PLATFORMS)(
    'a freshly-connected %s channel is not in the 7-day expiring window',
    (platform) => {
      expect(isExpiringWithin(freshGoogleChannel(platform), 7, NOW)).toBe(
        false,
      );
    },
  );

  it.each(GOOGLE_PLATFORMS)(
    'the Channels page shows no countdown for a fresh %s channel',
    (platform) => {
      const row = {
        ...freshGoogleChannel(platform),
        id: 1,
        workspaceId: WS,
        accountId: 'acct',
        accountName: 'Acct',
        nickname: null,
        showInSidebar: false,
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
        displayOrder: 0,
        timezone: 'UTC',
        color: null,
        accountType: 'channel',
        category: null,
        createdAt: NOW,
        updatedAt: NOW,
        pausedAt: null,
        pausedByUserId: null,
        connectedByUserId: null,
      };
      const dto = toChannelResponse(row as never, new Map(), NOW);
      expect(dto.refreshTokenExpiresInDays).toBeNull();
    },
  );

  it.each(GOOGLE_PLATFORMS)(
    'an explicit %s TTL override still takes effect',
    (platform) => {
      process.env[envKey(platform)] = '30';
      expect(getRefreshTokenTtlDays(platform)).toBe(30);
      // And it flows all the way through to the health model, so a future
      // environment that must force a TTL is not silently ignored.
      expect(
        refreshTokenExpiresAt({
          platform,
          refreshToken: 'enc:refresh',
          refreshTokenIssuedAt: NOW,
        })?.getTime(),
      ).toBe(NOW.getTime() + 30 * DAY);
    },
  );
});

/**
 * The bug as the owner experienced it: with a 7-day TTL and a 7-day warning
 * threshold, `daysLeft` is 7 the moment the channel connects, so the cron
 * mailed "reconnect soon" for a grant that had just been issued.
 */
describe('RefreshTokenExpiryScheduler and Google channels', () => {
  function setup(rows: unknown[]) {
    const db = {
      select: () => ({ from: () => ({ where: () => Promise.resolve(rows) }) }),
    };
    const notify = {
      notify: jest
        .fn<Promise<void>, [{ email: { idempotencyKey: string } }]>()
        .mockResolvedValue(undefined),
    };
    const recipients = {
      admins: jest.fn().mockResolvedValue([OWNER]),
      workspace: jest.fn().mockResolvedValue({ id: WS, timezone: 'UTC' }),
    };
    const taken = new Set<string>();
    const once = {
      claim: jest.fn((k: string) => {
        if (taken.has(k)) return Promise.resolve(false);
        taken.add(k);
        return Promise.resolve(true);
      }),
    };
    const notifierDb = {
      select: () => ({
        from: () => ({
          where: () =>
            Promise.resolve([{ n: 1, next: new Date(Date.now() + DAY) }]),
        }),
      }),
    };
    const notifier = new ChannelHealthNotifier(
      notifierDb as never,
      notify as never,
      recipients as never,
      once as never,
      new AppLinks({ get: () => undefined } as never),
      { tokenExpired: jest.fn() } as never,
    );
    return {
      scheduler: new RefreshTokenExpiryScheduler(db as never, notifier),
      notify,
    };
  }

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it.each(GOOGLE_PLATFORMS)(
    'does not mail the owner about a %s channel connected a minute ago',
    async (platform) => {
      const { scheduler, notify } = setup([
        {
          id: 1,
          platform,
          accountName: 'Acct',
          accountType: 'channel',
          username: null,
          workspaceId: WS,
          refreshTokenIssuedAt: new Date(Date.now() - 60 * 1000),
          tokenExpiresAt: null,
        },
      ]);
      await scheduler.checkRefreshTokenExpiry();
      expect(notify.notify).not.toHaveBeenCalled();
    },
  );

  it('still mails a platform whose refresh token really does run out', async () => {
    // Guard against "fixing" the false warning by muting the cron: LinkedIn's
    // 60-day TTL must still produce a warning six days out.
    const { scheduler, notify } = setup([
      {
        id: 2,
        platform: 'linkedin',
        accountName: 'Acct',
        accountType: 'profile',
        username: null,
        workspaceId: WS,
        refreshTokenIssuedAt: new Date(Date.now() - (60 - 6 - 0.5) * DAY),
        tokenExpiresAt: null,
      },
    ]);
    await scheduler.checkRefreshTokenExpiry();
    expect(notify.notify).toHaveBeenCalledTimes(1);
  });
});
