import { Logger } from '@nestjs/common';
import type { EnqueueEmail } from '../email/queue/email-job';
import type { EmailOutboxService } from '../email/queue/email-outbox.service';
import type { EmailTemplateDef } from '../email/templates/types';
import type { NotificationPreferencesService } from '../notification-preferences/notification-preferences.service';
import { NotifyService, type NotifyInput } from './notify.service';
import type { Recipient, RecipientsService } from './recipients.service';

interface Props {
  title: string;
}

const TEMPLATE = { id: 'fake-template' } as unknown as EmailTemplateDef<Props>;
const USER: Recipient = { id: 'u1', email: 'u1@example.test', name: 'U One' };

function setup(opts: { appAllowed?: boolean; user?: Recipient | null } = {}) {
  const shouldSend = jest.fn().mockResolvedValue(opts.appAllowed ?? true);
  const enqueue = jest.fn().mockResolvedValue(undefined);
  const user = jest
    .fn()
    .mockResolvedValue(opts.user === undefined ? USER : opts.user);
  const service = new NotifyService(
    { shouldSend } as unknown as NotificationPreferencesService,
    { enqueue } as unknown as EmailOutboxService,
    { user } as unknown as RecipientsService,
  );
  return { service, shouldSend, enqueue, user };
}

function email(
  extra: Partial<NonNullable<NotifyInput<Props>['email']>> = {},
): NonNullable<NotifyInput<Props>['email']> {
  return {
    template: TEMPLATE,
    props: { title: 'Hi' },
    idempotencyKey: 'key-1',
    ...extra,
  };
}

describe('NotifyService.notify', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('rings the bell when the app preference allows it', async () => {
    const { service, shouldSend } = setup();
    const bell = jest.fn().mockResolvedValue(undefined);

    await service.notify({
      userId: 'u1',
      workspaceId: 'w1',
      event: 'member_activity',
      bell,
    });

    expect(shouldSend).toHaveBeenCalledWith(
      'u1',
      'w1',
      'member_activity',
      'app',
    );
    expect(bell).toHaveBeenCalledTimes(1);
  });

  it('skips the bell when the app preference is off, still enqueues the email', async () => {
    const { service, enqueue } = setup({ appAllowed: false });
    const bell = jest.fn();

    await service.notify({
      userId: 'u1',
      workspaceId: 'w1',
      event: 'member_activity',
      bell,
      email: email(),
    });

    expect(bell).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('mandatory (event null) always rings the bell, without a preference lookup', async () => {
    const { service, shouldSend } = setup({ appAllowed: false });
    const bell = jest.fn().mockResolvedValue(undefined);

    await service.notify({
      userId: 'u1',
      workspaceId: null,
      event: null,
      bell,
    });

    expect(shouldSend).not.toHaveBeenCalled();
    expect(bell).toHaveBeenCalledTimes(1);
  });

  it('a throwing bell does not stop the email, and notify resolves', async () => {
    const { service, enqueue } = setup();

    await expect(
      service.notify({
        userId: 'u1',
        workspaceId: 'w1',
        event: 'member_activity',
        bell: () => Promise.reject(new Error('bell down')),
        email: email(),
      }),
    ).resolves.toBeUndefined();

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('bell down'));
  });

  it('a throwing preference lookup is swallowed and the email still goes', async () => {
    const { service, shouldSend, enqueue } = setup();
    shouldSend.mockRejectedValue(new Error('db down'));
    const bell = jest.fn();

    await expect(
      service.notify({
        userId: 'u1',
        workspaceId: 'w1',
        event: 'member_activity',
        bell,
        email: email(),
      }),
    ).resolves.toBeUndefined();

    expect(bell).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('enqueues to the user own address with the workspace and user id', async () => {
    const { service, enqueue, user } = setup();

    await service.notify({
      userId: 'u1',
      workspaceId: 'w1',
      event: 'member_activity',
      email: email({ replyTo: 'support@example.test', delayMs: 5000 }),
    });

    expect(user).toHaveBeenCalledWith('u1');
    expect(enqueue).toHaveBeenCalledWith({
      template: TEMPLATE,
      props: { title: 'Hi' },
      idempotencyKey: 'key-1',
      replyTo: 'support@example.test',
      delayMs: 5000,
      to: { email: 'u1@example.test', userId: 'u1' },
      workspaceId: 'w1',
    } satisfies EnqueueEmail<Props>);
  });

  it('an explicit `to` wins and skips the user lookup', async () => {
    const { service, enqueue, user } = setup();

    await service.notify({
      userId: 'u1',
      workspaceId: null,
      event: null,
      email: email({ to: 'new-address@example.test' }),
    });

    expect(user).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        to: { email: 'new-address@example.test', userId: 'u1' },
        workspaceId: null,
      }),
    );
  });

  it('a throwing enqueue is swallowed and logged', async () => {
    const { service, enqueue } = setup();
    enqueue.mockRejectedValue(new Error('redis down'));

    await expect(
      service.notify({
        userId: 'u1',
        workspaceId: 'w1',
        event: 'member_activity',
        email: email(),
      }),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('redis down'));
  });

  it('a user that no longer exists sends nothing and does not throw', async () => {
    const { service, enqueue } = setup({ user: null });

    await expect(
      service.notify({
        userId: 'gone',
        workspaceId: 'w1',
        event: 'member_activity',
        email: email(),
      }),
    ).resolves.toBeUndefined();

    expect(enqueue).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('gone'));
  });

  it('does nothing when given neither a bell nor an email', async () => {
    const { service, shouldSend, enqueue } = setup();

    await service.notify({ userId: 'u1', workspaceId: 'w1', event: null });

    expect(shouldSend).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
});
