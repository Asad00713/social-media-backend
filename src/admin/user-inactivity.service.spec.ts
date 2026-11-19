import { Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AppLinks } from '../email/links/app-links';
import type { EnqueueEmail } from '../email/queue/email-job';
import { UserInactivityService } from './user-inactivity.service';

const DAY_MS = 86_400_000;
const NOW = new Date('2026-11-15T10:00:00Z');
const LAST_LOGIN = new Date(NOW.getTime() - 25 * DAY_MS);
const WS = '9a1b2c3d-0000-4000-8000-000000000001';

interface FakeUser {
  id: string;
  email: string;
  name: string | null;
  lastLoginAt: Date | null;
  createdAt: Date;
  lastAccessedWorkspaceId: string | null;
}

function user(over: Partial<FakeUser> = {}): FakeUser {
  return {
    id: 'u1',
    email: 'rehman@acme.test',
    name: 'Rehman',
    lastLoginAt: LAST_LOGIN,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    lastAccessedWorkspaceId: WS,
    ...over,
  };
}

/**
 * Drizzle's chain, answered in call order: each `select()` resolves to the
 * next entry of `selects`, each `update()` is recorded.
 */
function fakeDb(selects: unknown[][]) {
  const queue = [...selects];
  const updates: Record<string, unknown>[] = [];
  return {
    updates,
    select: jest.fn(() => ({
      from: () => ({ where: () => Promise.resolve(queue.shift() ?? []) }),
    })),
    update: jest.fn(() => ({
      set: (values: Record<string, unknown>) => {
        updates.push(values);
        return { where: () => Promise.resolve() };
      },
    })),
    delete: jest.fn(() => ({ where: () => Promise.resolve() })),
  };
}

function make(
  selects: unknown[][],
  over: { enqueue?: jest.Mock; workspace?: unknown } = {},
) {
  jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] });
  const db = fakeDb(selects);
  const enqueue = over.enqueue ?? jest.fn().mockResolvedValue(true);
  const recipients = {
    workspace: jest
      .fn()
      .mockResolvedValue(
        'workspace' in over
          ? over.workspace
          : { id: WS, name: 'Rehman Workspace', timezone: 'Asia/Karachi' },
      ),
    userTimezone: jest.fn().mockResolvedValue('Asia/Karachi'),
  };
  const notifications = { notifyUsers: jest.fn().mockResolvedValue(undefined) };
  const links = new AppLinks({
    get: (key: string) =>
      ({
        FRONTEND_URL: 'https://app.test',
        SUPPORT_EMAIL: 'help@custom.example',
      })[key],
  } as never);
  const service = new UserInactivityService(
    db as never,
    notifications as never,
    { enqueue } as never,
    recipients as never,
    links,
  );
  return { service, db, enqueue, recipients, notifications };
}

function job<P>(enqueue: jest.Mock, n = 0): EnqueueEmail<P> {
  return (enqueue.mock.calls as unknown[][])[n][0] as EnqueueEmail<P>;
}

const ADMINS = [{ id: 'admin-1' }];

describe('UserInactivityService', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('the policy stays disabled', () => {
    it('runManualCheck still refuses and touches nothing', async () => {
      const { service, db, enqueue } = make([]);
      jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const result = await service.runManualCheck();
      expect(result.success).toBe(false);
      expect(db.select).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('no method of the service is scheduled', () => {
      const scheduleKeys = (fn: object) =>
        Reflect.getMetadataKeys(fn).filter((k: unknown) =>
          /^SCHEDUL/.test(String(k)),
        );

      // Positive control: this is how a @Cron shows up.
      class Probe {
        @Cron('0 2 * * *')
        tick() {}
      }
      expect(scheduleKeys(Probe.prototype.tick)).not.toEqual([]);

      const proto = UserInactivityService.prototype as unknown as Record<
        string,
        unknown
      >;
      for (const name of Object.getOwnPropertyNames(proto)) {
        const member = proto[name];
        if (typeof member === 'function') {
          expect({ name, keys: scheduleKeys(member) }).toEqual({
            name,
            keys: [],
          });
        }
      }
    });
  });

  describe('F2 inactive-reminder (15 days)', () => {
    it('enqueues the reminder with the counts of the last opened workspace', async () => {
      const { service, db, enqueue, recipients } = make([
        [user()],
        [{ count: 8 }],
        [{ count: 3 }],
        [{ count: 0 }],
        ADMINS,
      ]);
      await service['process15DayInactiveUsers']();

      expect(recipients.workspace).toHaveBeenCalledWith(WS);
      expect(enqueue).toHaveBeenCalledTimes(1);
      const sent = job<Record<string, unknown>>(enqueue);
      expect(sent.template.id).toBe('inactive-reminder');
      expect(sent.props).toEqual({
        workspaceName: 'Rehman Workspace',
        channels: 8,
        drafts: 3,
        scheduledThisWeek: 0,
        openUrl: 'https://app.test/',
      });
      expect(sent.to).toEqual({ email: 'rehman@acme.test', userId: 'u1' });
      expect(sent.workspaceId).toBeNull();
      expect(sent.idempotencyKey).toBe(
        `inactive-reminder.u1.${LAST_LOGIN.getTime()}`,
      );
      expect(sent.idempotencyKey).toMatch(/^[A-Za-z0-9._-]{1,200}$/);
      expect(db.updates).toEqual([
        expect.objectContaining({ inactivityEmail15DaysSentAt: NOW }),
      ]);
    });

    it('falls back to the signup time when the person never logged in', async () => {
      const never = user({ lastLoginAt: null });
      const { service, enqueue } = make([
        [never],
        [{ count: 1 }],
        [{ count: 0 }],
        [{ count: 0 }],
        ADMINS,
      ]);
      await service['process15DayInactiveUsers']();
      expect(job(enqueue).idempotencyKey).toBe(
        `inactive-reminder.u1.${never.createdAt.getTime()}`,
      );
    });

    it('skips, and does not mark, a person with no last-opened workspace', async () => {
      jest.spyOn(Logger.prototype, 'log').mockImplementation();
      const { service, db, enqueue } = make([
        [user({ lastAccessedWorkspaceId: null })],
      ]);
      await service['process15DayInactiveUsers']();
      expect(enqueue).not.toHaveBeenCalled();
      expect(db.updates).toEqual([]);
    });

    it('does not mark the person as reminded when the enqueue fails', async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation();
      const { service, db } = make(
        [[user()], [{ count: 1 }], [{ count: 1 }], [{ count: 1 }]],
        { enqueue: jest.fn().mockRejectedValue(new Error('redis down')) },
      );
      await service['process15DayInactiveUsers']();
      expect(db.updates).toEqual([]);
    });

    it('does not mark the person as reminded when Redis times out ("not queued")', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
      const { service, db } = make(
        [[user()], [{ count: 1 }], [{ count: 1 }], [{ count: 1 }]],
        { enqueue: jest.fn().mockResolvedValue(false) },
      );
      await service['process15DayInactiveUsers']();
      expect(db.updates).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('not queued'));
      const logged = log.mock.calls.map((c) => String(c[0])).join(' ');
      expect(logged).not.toContain('Queued 15-day');
    });
  });

  describe('F3 pausing-soon (25 days)', () => {
    it('enqueues the pause date, five days out from the 30-day mark', async () => {
      const { service, db, enqueue } = make([[user()], ADMINS]);
      await service['process25DayInactiveUsers']();

      const sent = job<Record<string, unknown>>(enqueue);
      expect(sent.template.id).toBe('pausing-soon');
      // 25 days ago + 30 days = 5 days from now, in Karachi.
      expect(sent.props).toEqual({
        pauseDate: 'Nov 20',
        signInUrl: 'https://app.test/login',
      });
      expect(sent.idempotencyKey).toBe(
        `pausing-soon.u1.${LAST_LOGIN.getTime()}`,
      );
      expect(db.updates).toEqual([
        expect.objectContaining({ inactivityEmail25DaysSentAt: NOW }),
      ]);
    });

    it('does not mark the person when Redis times out ("not queued")', async () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const { service, db } = make([[user()], ADMINS], {
        enqueue: jest.fn().mockResolvedValue(false),
      });
      await service['process25DayInactiveUsers']();
      expect(db.updates).toEqual([]);
    });
  });

  describe('F4 account-paused (30 days)', () => {
    it('enqueues the notice with both dates and the support address, then suspends', async () => {
      const { service, db, enqueue } = make([[user()], ADMINS]);
      await service['process30DayInactiveUsers']();

      const sent = job<Record<string, unknown>>(enqueue);
      expect(sent.template.id).toBe('account-paused');
      expect(sent.props).toEqual({
        pausedSince: 'Nov 15, 2026',
        deleteOn: 'Nov 15, 2027',
        signInUrl: 'https://app.test/login',
        supportEmail: 'help@custom.example',
      });
      expect(sent.idempotencyKey).toBe(
        `account-paused.u1.${LAST_LOGIN.getTime()}`,
      );
      expect(db.updates).toEqual([
        expect.objectContaining({
          isActive: false,
          suspendedReason: 'inactivity',
        }),
      ]);
    });

    it('still suspends when the notice cannot be queued, as before', async () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const { service, db } = make([[user()], ADMINS], {
        enqueue: jest.fn().mockRejectedValue(new Error('redis down')),
      });
      await service['process30DayInactiveUsers']();
      expect(db.updates).toEqual([
        expect.objectContaining({ isActive: false }),
      ]);
    });

    it('says "notice not queued" when Redis times out, and still suspends', async () => {
      const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
      const { service, db } = make([[user()], ADMINS], {
        enqueue: jest.fn().mockResolvedValue(false),
      });
      await service['process30DayInactiveUsers']();
      expect(db.updates).toEqual([
        expect.objectContaining({ isActive: false }),
      ]);
      const logged = log.mock.calls.map((c) => String(c[0])).join(' ');
      expect(logged).toContain('notice not queued');
      expect(logged).not.toContain('(notice queued)');
    });
  });

  describe('365-day purge', () => {
    it('skips workspace owners (0093 makes owner_id RESTRICT) and deletes the rest', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      jest.spyOn(Logger.prototype, 'log').mockImplementation();
      const owner = { id: 'u-owner', email: 'owner@acme.test', name: 'O' };
      const other = { id: 'u-other', email: 'other@acme.test', name: 'X' };
      const { service, db, notifications } = make([
        [], // approaching deletion
        [owner, other], // due for deletion
        [{ ownerId: 'u-owner' }, { ownerId: 'u-owner' }], // owners among them
        ADMINS,
      ]);
      await service['process365DayInactiveUsers']();

      expect(db.delete).toHaveBeenCalledTimes(1);
      const skipped = warn.mock.calls.map((c) => String(c[0]));
      expect(skipped).toHaveLength(1);
      expect(skipped[0]).toContain('u-owner');
      expect(skipped[0]).not.toContain('owner@acme.test');
      const [, payload] = notifications.notifyUsers.mock.calls[0] as [
        unknown,
        { message: string },
      ];
      expect(payload.message).toContain('other@acme.test');
      expect(payload.message).not.toContain('owner@acme.test');
    });

    it('deletes nobody and does not look up owners when nobody is due', async () => {
      const { service, db } = make([[], []]);
      await service['process365DayInactiveUsers']();
      expect(db.select).toHaveBeenCalledTimes(2);
      expect(db.delete).not.toHaveBeenCalled();
    });
  });

  it('logs ids, not addresses, for the queued reminders', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const { service } = make([
      [user()],
      [{ count: 1 }],
      [{ count: 1 }],
      [{ count: 1 }],
      ADMINS,
    ]);
    await service['process15DayInactiveUsers']();
    const lines = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(lines).toContain('u1');
    expect(lines).not.toContain('rehman@acme.test');
  });
});
