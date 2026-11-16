import { BadRequestException } from '@nestjs/common';
import type { WorkspaceRoleService } from '../workspace-members/workspace-role.service';
import {
  NOTIFICATION_EVENT_KEYS,
  type PreferenceChannel,
} from './notification-events';
import type {
  NotificationPreferencesRepository,
  PreferenceOverride,
} from './notification-preferences.repository';
import { NotificationPreferencesService } from './notification-preferences.service';
import type { EmailOutboxService } from '../email/queue/email-outbox.service';
import type { RecipientsService } from '../notifications/recipients.service';
import { NotifyService } from '../notifications/notify.service';

const USER = 'user-1';
const WS = '11111111-1111-4111-8111-111111111111';

/** An in-memory repository: rows keyed by workspace id ('' for account-level). */
class FakeRepo {
  rows = new Map<string, PreferenceOverride[]>();
  findForUser = jest.fn((_userId: string, workspaceId: string | null) =>
    Promise.resolve([...(this.rows.get(workspaceId ?? '') ?? [])]),
  );
  upsert = jest.fn(
    (
      _userId: string,
      workspaceId: string | null,
      event: string,
      channel: PreferenceChannel,
      enabled: boolean,
    ) => {
      const key = workspaceId ?? '';
      const rows = (this.rows.get(key) ?? []).filter(
        (r) => !(r.event === event && r.channel === channel),
      );
      rows.push({ event, channel, enabled });
      this.rows.set(key, rows);
      return Promise.resolve();
    },
  );
  seed(workspaceId: string | null, row: PreferenceOverride) {
    const key = workspaceId ?? '';
    this.rows.set(key, [...(this.rows.get(key) ?? []), row]);
  }
}

function setup(role: string | null = 'MEMBER') {
  const repo = new FakeRepo();
  const roles = { getRole: jest.fn().mockResolvedValue(role) };
  const service = new NotificationPreferencesService(
    repo as unknown as NotificationPreferencesRepository,
    roles as unknown as WorkspaceRoleService,
  );
  return { repo, roles, service };
}

async function rejectionOf(p: Promise<unknown>): Promise<BadRequestException> {
  try {
    await p;
  } catch (e) {
    return e as BadRequestException;
  }
  throw new Error('expected a rejection');
}

describe('NotificationPreferencesService.shouldSend', () => {
  it('locked channel is always true even with an off row', async () => {
    const { service, repo } = setup();
    repo.seed(WS, { event: 'post_failed', channel: 'app', enabled: false });
    expect(await service.shouldSend(USER, WS, 'post_failed', 'app')).toBe(true);
  });

  it('unavailable channel is false', async () => {
    const { service } = setup();
    expect(await service.shouldSend(USER, WS, 'draft_ready', 'email')).toBe(
      false,
    );
    expect(await service.shouldSend(USER, WS, 'drip_review', 'app')).toBe(
      false,
    );
  });

  it('non-member gets false (removed after enqueue)', async () => {
    const { service, roles, repo } = setup(null);
    expect(
      await service.shouldSend(USER, WS, 'approval_request', 'email'),
    ).toBe(false);
    expect(roles.getRole).toHaveBeenCalledWith(WS, USER);
    expect(repo.findForUser).not.toHaveBeenCalled();
  });

  it('override row wins over default', async () => {
    const { service, repo } = setup();
    repo.seed(WS, {
      event: 'member_activity',
      channel: 'email',
      enabled: true,
    });
    repo.seed(WS, {
      event: 'approval_request',
      channel: 'email',
      enabled: false,
    });
    expect(await service.shouldSend(USER, WS, 'member_activity', 'email')).toBe(
      true,
    );
    expect(
      await service.shouldSend(USER, WS, 'approval_request', 'email'),
    ).toBe(false);
  });

  it('ignores an override for the other channel', async () => {
    const { service, repo } = setup();
    repo.seed(WS, { event: 'member_activity', channel: 'app', enabled: false });
    expect(await service.shouldSend(USER, WS, 'member_activity', 'email')).toBe(
      false,
    );
    expect(await service.shouldSend(USER, WS, 'member_activity', 'app')).toBe(
      false,
    );
  });

  it('default when no row', async () => {
    const { service } = setup();
    expect(
      await service.shouldSend(USER, WS, 'approval_request', 'email'),
    ).toBe(true);
    expect(await service.shouldSend(USER, WS, 'member_activity', 'email')).toBe(
      false,
    );
  });

  it('account-scope event ignores workspace membership', async () => {
    const { service, roles } = setup(null);
    expect(
      await service.shouldSend(USER, null, 'inactivity_reminder', 'email'),
    ).toBe(true);
    expect(roles.getRole).not.toHaveBeenCalled();
  });

  it('account-scope event honours an unsubscribe override', async () => {
    const { service, repo } = setup();
    repo.seed(null, {
      event: 'inactivity_reminder',
      channel: 'email',
      enabled: false,
    });
    expect(
      await service.shouldSend(USER, null, 'inactivity_reminder', 'email'),
    ).toBe(false);
  });
});

describe('NotificationPreferencesService.update', () => {
  it('rejects a locked channel with NOTIFICATION_CHANNEL_LOCKED', async () => {
    const { service, repo } = setup();
    const err = await rejectionOf(
      service.update(USER, WS, [
        { event: 'approval_request', channel: 'email', enabled: false },
        { event: 'post_failed', channel: 'app', enabled: false },
      ]),
    );
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toEqual({
      statusCode: 400,
      error: 'Bad Request',
      code: 'NOTIFICATION_CHANNEL_LOCKED',
      message: "Post failed in-app notifications can't be turned off.",
    });
    // A rejected batch writes nothing, not even its valid first change.
    expect(repo.upsert).not.toHaveBeenCalled();
  });

  it('words the locked email message with "email"', async () => {
    const { service } = setup();
    const err = await rejectionOf(
      service.update(USER, WS, [
        { event: 'security_alert', channel: 'email', enabled: false },
      ]),
    );
    expect(err.getResponse()).toMatchObject({
      message: "Security email notifications can't be turned off.",
    });
  });

  it('rejects an unavailable channel with NOTIFICATION_CHANNEL_UNAVAILABLE', async () => {
    const { service, repo } = setup();
    const email = await rejectionOf(
      service.update(USER, WS, [
        { event: 'draft_ready', channel: 'email', enabled: true },
      ]),
    );
    expect(email.getResponse()).toEqual({
      statusCode: 400,
      error: 'Bad Request',
      code: 'NOTIFICATION_CHANNEL_UNAVAILABLE',
      message: 'Draft ready has no email notifications.',
    });
    const app = await rejectionOf(
      service.update(USER, WS, [
        { event: 'drip_review', channel: 'app', enabled: true },
      ]),
    );
    expect(app.getResponse()).toMatchObject({
      code: 'NOTIFICATION_CHANNEL_UNAVAILABLE',
      message: 'Drip post to review has no in-app notifications.',
    });
    expect(repo.upsert).not.toHaveBeenCalled();
  });

  it('stores the changes and returns the full updated list', async () => {
    const { service, repo } = setup();
    const res = await service.update(USER, WS, [
      { event: 'member_activity', channel: 'email', enabled: true },
      { event: 'inbox_mention', channel: 'app', enabled: false },
    ]);
    expect(repo.upsert).toHaveBeenCalledTimes(2);
    expect(repo.upsert).toHaveBeenCalledWith(
      USER,
      WS,
      'member_activity',
      'email',
      true,
    );
    expect(res.workspaceId).toBe(WS);
    expect(res.events).toHaveLength(12);
    const byEvent = Object.fromEntries(res.events.map((e) => [e.event, e]));
    expect(byEvent.member_activity.email).toEqual({
      enabled: true,
      locked: false,
    });
    expect(byEvent.inbox_mention.app).toEqual({
      enabled: false,
      locked: false,
    });
  });
});

describe('NotificationPreferencesService.list', () => {
  it('returns every workspace-scope event in catalogue order, with nulls for unavailable channels', async () => {
    const { service } = setup();
    const res = await service.list(USER, WS);
    expect(res.events.map((e) => e.event)).toEqual([
      ...NOTIFICATION_EVENT_KEYS,
    ]);
    expect(res.events).toHaveLength(12);
    expect(res.events.map((e) => e.event)).not.toContain('inactivity_reminder');
    const byEvent = Object.fromEntries(res.events.map((e) => [e.event, e]));
    expect(byEvent.drip_review.app).toBeNull();
    expect(byEvent.draft_ready.email).toBeNull();
    expect(byEvent.post_failed).toEqual({
      event: 'post_failed',
      email: { enabled: true, locked: false },
      app: { enabled: true, locked: true },
    });
    expect(byEvent.member_activity.email).toEqual({
      enabled: false,
      locked: false,
    });
  });

  it('reports a locked channel as on even when an off row exists', async () => {
    const { service, repo } = setup();
    repo.seed(WS, {
      event: 'security_alert',
      channel: 'email',
      enabled: false,
    });
    const res = await service.list(USER, WS);
    expect(res.events.find((e) => e.event === 'security_alert')?.email).toEqual(
      { enabled: true, locked: true },
    );
  });
});

describe('NotificationPreferencesService.disableEmail', () => {
  it('writes an email-off override', async () => {
    const { service, repo } = setup();
    await service.disableEmail(USER, null, 'inactivity_reminder');
    expect(repo.upsert).toHaveBeenCalledWith(
      USER,
      null,
      'inactivity_reminder',
      'email',
      false,
    );
    expect(
      await service.shouldSend(USER, null, 'inactivity_reminder', 'email'),
    ).toBe(false);
  });

  it('leaves a locked email and a missing email alone', async () => {
    const { service, repo } = setup();
    await service.disableEmail(USER, WS, 'security_alert');
    await service.disableEmail(USER, WS, 'draft_ready');
    expect(repo.upsert).not.toHaveBeenCalled();
  });
});

describe('security events are account-level', () => {
  const OTHER_WS = '22222222-2222-4222-8222-222222222222';

  it('a workspace PUT turning the Security in-app switch off silences the A5 and A6 bells', async () => {
    const { service, repo } = setup();
    // The settings page saves the Security group with a workspace id.
    await service.update(USER, WS, [
      { event: 'security_alert', channel: 'app', enabled: false },
    ]);
    expect(repo.upsert).toHaveBeenCalledWith(
      USER,
      null,
      'security_alert',
      'app',
      false,
    );

    // A5 and A6 ring through NotifyService with workspaceId null.
    const notify = new NotifyService(
      service,
      { enqueue: jest.fn() } as unknown as EmailOutboxService,
      {} as unknown as RecipientsService,
    );
    const passwordChanged = jest.fn();
    const newLogin = jest.fn();
    await notify.notify({
      userId: USER,
      workspaceId: null,
      event: 'security_alert',
      bell: passwordChanged,
    });
    await notify.notify({
      userId: USER,
      workspaceId: null,
      event: 'security_alert',
      bell: newLogin,
    });
    expect(passwordChanged).not.toHaveBeenCalled();
    expect(newLogin).not.toHaveBeenCalled();
  });

  it('every workspace GET shows the account-level Security switch; other events stay per workspace', async () => {
    const { service } = setup();
    await service.update(USER, WS, [
      { event: 'security_alert', channel: 'app', enabled: false },
      { event: 'post_approved', channel: 'app', enabled: false },
    ]);

    const other = await service.list(USER, OTHER_WS);
    const pick = (event: string) =>
      other.events.find((e) => e.event === event)?.app;
    expect(pick('security_alert')).toEqual({ enabled: false, locked: false });
    expect(pick('post_approved')).toEqual({ enabled: true, locked: false });
    // The same workspace still reads its own post_approved row.
    const same = await service.list(USER, WS);
    expect(
      same.events.find((e) => e.event === 'post_approved')?.app?.enabled,
    ).toBe(false);
  });

  it('a security event checked with a workspace id still reads the account-level row', async () => {
    const { service, repo } = setup();
    repo.seed(null, {
      event: 'security_alert',
      channel: 'app',
      enabled: false,
    });
    expect(await service.shouldSend(USER, WS, 'security_alert', 'app')).toBe(
      false,
    );
  });
});
