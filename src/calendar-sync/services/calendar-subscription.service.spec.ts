// CalendarSubscriptionService reads `calendar_sync_state` through the
// module-level `db` singleton (not DI) — jest.mock it and feed renewDueSoon()
// the candidate rows directly.
jest.mock('../../drizzle/db', () => {
  const selectResult: { rows: unknown[] } = { rows: [] };
  return {
    __selectResult: selectResult,
    db: {
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn(() => Promise.resolve(selectResult.rows)),
        })),
      })),
      update: jest.fn(() => ({
        set: jest.fn(() => ({ where: jest.fn(() => Promise.resolve()) })),
      })),
    },
  };
});

import { ChannelService } from '../../channels/services/channel.service';
import { GoogleCalendarService } from '../../channels/services/google-calendar.service';
import type { CalendarSyncStateRow } from '../../drizzle/schema/calendar-sync.schema';
import {
  CalendarSubscriptionService,
  isRenewalDue,
} from './calendar-subscription.service';

const dbMock = jest.requireMock('../../drizzle/db') as unknown as {
  __selectResult: { rows: unknown[] };
};

const NOW = new Date('2026-07-13T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

function googleState(
  channelId: number,
  watchExpiration: Date | null,
): CalendarSyncStateRow {
  return {
    id: `g-${channelId}`,
    channelId,
    provider: 'google',
    syncToken: null,
    deltaLink: null,
    watchChannelId: 'watch-1',
    watchResourceId: 'res-1',
    watchExpiration,
    subscriptionId: null,
    subscriptionExpiration: null,
    lastFullSyncAt: null,
    lastIncrementalSyncAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function outlookState(
  channelId: number,
  subscriptionExpiration: Date | null,
): CalendarSyncStateRow {
  return {
    id: `o-${channelId}`,
    channelId,
    provider: 'outlook',
    syncToken: null,
    deltaLink: null,
    watchChannelId: null,
    watchResourceId: null,
    watchExpiration: null,
    subscriptionId: 'sub-1',
    subscriptionExpiration,
    lastFullSyncAt: null,
    lastIncrementalSyncAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe('isRenewalDue (expiry windows)', () => {
  // Google push channels can't be renewed → we stop + re-watch, with a 24h
  // safety margin. Graph subscriptions renew in place, 12h margin.
  it.each([
    ['google', 23 * HOUR, true, 'inside the 24h window'],
    ['google', 25 * HOUR, false, 'outside the 24h window'],
    ['google', -1 * HOUR, true, 'already expired'],
    ['outlook', 11 * HOUR, true, 'inside the 12h window'],
    ['outlook', 13 * HOUR, false, 'outside the 12h window'],
    ['outlook', -1 * HOUR, true, 'already expired'],
  ])('%s expiring in %dms → %s (%s)', (provider, deltaMs, expected) => {
    const expiry = new Date(NOW.getTime() + deltaMs);
    const state =
      provider === 'google' ? googleState(1, expiry) : outlookState(1, expiry);

    expect(isRenewalDue(state, NOW)).toBe(expected);
  });

  it('is never due when the connection has no subscription at all', () => {
    expect(isRenewalDue(googleState(1, null), NOW)).toBe(false);
    expect(isRenewalDue(outlookState(2, null), NOW)).toBe(false);
  });
});

describe('CalendarSubscriptionService.renewDueSoon', () => {
  let service: CalendarSubscriptionService;
  let renewOne: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(NOW);

    service = new CalendarSubscriptionService(
      {} as unknown as ChannelService,
      {} as unknown as GoogleCalendarService,
    );

    // Provider I/O is out of scope here — this spec pins the SELECTION.
    renewOne = jest
      .spyOn(
        service as unknown as {
          renewOne: (s: CalendarSyncStateRow) => unknown;
        },
        'renewOne',
      )
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('renews only the connections inside their provider safety window', async () => {
    const dueGoogle = googleState(1, new Date(NOW.getTime() + 6 * HOUR));
    const freshGoogle = googleState(2, new Date(NOW.getTime() + 6 * 24 * HOUR));
    const dueOutlook = outlookState(3, new Date(NOW.getTime() + 2 * HOUR));
    const freshOutlook = outlookState(4, new Date(NOW.getTime() + 40 * HOUR));
    const expiredGoogle = googleState(5, new Date(NOW.getTime() - 2 * HOUR));

    dbMock.__selectResult.rows = [
      dueGoogle,
      freshGoogle,
      dueOutlook,
      freshOutlook,
      expiredGoogle,
    ];

    await service.renewDueSoon();

    expect(renewOne).toHaveBeenCalledTimes(3);
    const renewedChannelIds = (renewOne.mock.calls as CalendarSyncStateRow[][])
      .map((call) => call[0].channelId)
      .sort();
    expect(renewedChannelIds).toEqual([1, 3, 5]);
  });

  it('does nothing when nothing is close to expiry', async () => {
    dbMock.__selectResult.rows = [
      googleState(1, new Date(NOW.getTime() + 6 * 24 * HOUR)),
      outlookState(2, new Date(NOW.getTime() + 2 * 24 * HOUR)),
    ];

    await service.renewDueSoon();

    expect(renewOne).not.toHaveBeenCalled();
  });

  it('isolates a failing connection so the rest still renew', async () => {
    renewOne.mockImplementation((state: CalendarSyncStateRow) => {
      if (state.channelId === 1) return Promise.reject(new Error('token dead'));
      return Promise.resolve();
    });

    dbMock.__selectResult.rows = [
      googleState(1, new Date(NOW.getTime() + 1 * HOUR)),
      outlookState(2, new Date(NOW.getTime() + 1 * HOUR)),
    ];

    await expect(service.renewDueSoon()).resolves.toBeUndefined();
    expect(renewOne).toHaveBeenCalledTimes(2);
  });
});
