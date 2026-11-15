import { Logger } from '@nestjs/common';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  channelReconnect,
  type ChannelReconnectProps,
} from '../../email/templates/publishing/channel-reconnect';
import { AppLinks } from '../../email/links/app-links';
import { IDEMPOTENCY_KEY_RE } from '../../email/queue/email-job';
import { NOTIFICATION_EVENTS } from '../../notification-preferences/notification-events';
import { ChannelHealthNotifier } from './channel-health-notifier.service';

const WS = '0b0c1d2e-0000-4000-8000-000000000001';
const OWNER = { id: 'u-owner', email: 'owner@x.test', name: 'Owner' };
const ADMIN = { id: 'u-admin', email: 'admin@x.test', name: null };
const CHANNEL = {
  id: 5,
  workspaceId: WS,
  platform: 'instagram',
  accountName: 'Lumiere Cafe',
  accountType: 'business_account',
};
const DAY = 24 * 60 * 60 * 1000;
const NEXT = new Date('2026-11-20T13:00:00.000Z');
const AT = new Date('2026-11-15T04:12:00.000Z');

interface SentNotice {
  userId: string;
  workspaceId: string;
  event: string;
  bell?: () => Promise<unknown>;
  email: {
    template: unknown;
    props: ChannelReconnectProps;
    idempotencyKey: string;
  };
}

function setup(opts: { n?: number; next?: Date | null } = {}) {
  const n = opts.n ?? 0;
  const where = jest
    .fn<Promise<unknown[]>, [SQL]>()
    .mockResolvedValue([{ n, next: n > 0 ? (opts.next ?? NEXT) : null }]);
  const db = { select: () => ({ from: () => ({ where }) }) };
  const notify = {
    notify: jest.fn<Promise<void>, [SentNotice]>().mockResolvedValue(undefined),
  };
  const recipients = {
    admins: jest.fn().mockResolvedValue([OWNER, ADMIN]),
    workspace: jest
      .fn()
      .mockResolvedValue({ id: WS, name: 'Rehman', timezone: 'Asia/Karachi' }),
  };
  const taken = new Set<string>();
  const once = {
    claim: jest.fn((key: string) => {
      if (taken.has(key)) return Promise.resolve(false);
      taken.add(key);
      return Promise.resolve(true);
    }),
  };
  const emitter = { tokenExpired: jest.fn().mockResolvedValue(undefined) };
  const links = new AppLinks({ get: () => undefined } as never);
  const notifier = new ChannelHealthNotifier(
    db as never,
    notify as never,
    recipients as never,
    once as never,
    links,
    emitter as never,
  );
  return { notifier, notify, recipients, once, emitter, where };
}

describe('ChannelHealthNotifier.expired', () => {
  it('emails the owner and admins and rings their bell', async () => {
    const { notifier, notify, recipients, emitter } = setup({ n: 3 });
    await notifier.expired(CHANNEL, AT);

    expect(recipients.admins).toHaveBeenCalledWith(WS);
    expect(notify.notify).toHaveBeenCalledTimes(2);
    const call = notify.notify.mock.calls[0][0];
    expect(call.userId).toBe(OWNER.id);
    expect(call.workspaceId).toBe(WS);
    expect(call.event).toBe('channel_health');
    expect(call.email.template).toBe(channelReconnect);
    expect(call.email.props).toMatchObject({
      kind: 'expired',
      platform: 'instagram',
      platformName: 'Instagram',
      handle: 'Lumiere Cafe',
      accountType: 'Business account',
      statusLine: 'Instagram · disconnected today, 9:12 AM',
      waiting: 3,
      nextWhen: 'Nov 20, 2026 at 6:00 PM GMT+5',
      reconnectUrl: `http://localhost:3001/w/${WS}/channels`,
    });
    await call.bell?.();
    expect(emitter.tokenExpired).toHaveBeenCalledWith(
      OWNER.id,
      'Instagram',
      'Lumiere Cafe',
    );
  });

  it('gives each recipient their own valid idempotency key', async () => {
    const { notifier, notify } = setup();
    await notifier.expired(CHANNEL, AT);
    const keys = notify.notify.mock.calls.map((c) => c[0].email.idempotencyKey);
    expect(keys).toEqual([
      `channel-expired.5.${AT.getTime()}.u-owner`,
      `channel-expired.5.${AT.getTime()}.u-admin`,
    ]);
    keys.forEach((k) => {
      expect(k).toMatch(IDEMPOTENCY_KEY_RE);
      expect(k).not.toMatch(/^\d+$/);
    });
  });

  it('claims the incident for 7 days, so the same incident sends once', async () => {
    const { notifier, notify, once } = setup();
    await notifier.expired(CHANNEL, AT);
    await notifier.expired(CHANNEL, AT);
    await notifier.expired(CHANNEL, new Date(AT.getTime() + 60_000));
    expect(once.claim).toHaveBeenCalledWith(
      'channel-expired.5.2026-11-15',
      7 * 24 * 3600,
    );
    expect(notify.notify).toHaveBeenCalledTimes(2);
  });

  it('sends again when the channel expires again on a later day', async () => {
    const { notifier, notify } = setup();
    await notifier.expired(CHANNEL, AT);
    await notifier.expired(CHANNEL, new Date(AT.getTime() + 2 * DAY));
    expect(notify.notify).toHaveBeenCalledTimes(4);
  });

  it('does not share a claim across channels', async () => {
    const { notifier, notify } = setup();
    await notifier.expired(CHANNEL, AT);
    await notifier.expired({ ...CHANNEL, id: 6 }, AT);
    expect(notify.notify).toHaveBeenCalledTimes(4);
  });

  it('reports no waiting posts as 0 and no time', async () => {
    const { notifier, notify } = setup({ n: 0 });
    await notifier.expired(CHANNEL, AT);
    expect(notify.notify.mock.calls[0][0].email.props).toMatchObject({
      waiting: 0,
      nextWhen: null,
    });
  });

  it('counts scheduled posts that target the channel by string id', async () => {
    const { notifier, where } = setup({ n: 1 });
    await notifier.expired(CHANNEL, AT);
    const q = new PgDialect().sqlToQuery(where.mock.calls[0][0]);
    expect(q.sql).toContain('@>');
    expect(q.params).toContain(JSON.stringify([{ channelId: '5' }]));
    expect(q.params).toContain(WS);
    expect(q.params).toContain('scheduled');
  });

  it('never throws and logs no address when a lookup fails', async () => {
    const { notifier, recipients } = setup();
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    recipients.admins.mockRejectedValue(new Error('db down'));
    await expect(notifier.expired(CHANNEL, AT)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('channel 5');
    warn.mockRestore();
  });

  it('is a notification-footer template on an unlocked email event', () => {
    expect(channelReconnect.footer).toBe('notification');
    expect(channelReconnect.event).toBe('channel_health');
    expect(NOTIFICATION_EVENTS.channel_health.email?.locked).toBe(false);
  });
});

describe('ChannelHealthNotifier.expiring', () => {
  const ISSUED = new Date('2026-09-22T00:00:00.000Z');
  const ENDS = new Date(Date.now() + 6.5 * DAY);
  const channel = { ...CHANNEL, refreshTokenIssuedAt: ISSUED };
  const TTL = 30 * 24 * 3600;

  it('emails only, with no bell, and the expiring props', async () => {
    const { notifier, notify } = setup({ n: 2 });
    await notifier.expiring(channel, 6, ENDS);
    expect(notify.notify).toHaveBeenCalledTimes(2);
    const call = notify.notify.mock.calls[0][0];
    expect(call.bell).toBeUndefined();
    expect(call.event).toBe('channel_health');
    expect(call.email.props).toMatchObject({ kind: 'expiring', waiting: 2 });
    expect(call.email.props.endsOn).toMatch(/^[A-Z][a-z]{2} \d+, 20\d\d$/);
    expect(call.email.props.statusLine).toBe(
      `Instagram · access ends ${call.email.props.endsOn as string}`,
    );
  });

  it('claims stage 7 at 6 days left and stage 1 at 1 day left, 30 days each', async () => {
    const { notifier, once, notify } = setup();
    await notifier.expiring(channel, 6, ENDS);
    await notifier.expiring(channel, 1, ENDS);
    const t = ISSUED.getTime();
    expect(once.claim).toHaveBeenNthCalledWith(
      1,
      `channel-expiring.5.${t}.7`,
      TTL,
    );
    expect(once.claim).toHaveBeenNthCalledWith(
      2,
      `channel-expiring.5.${t}.1`,
      TTL,
    );
    expect(notify.notify).toHaveBeenCalledTimes(4);
    const keys = notify.notify.mock.calls.map((c) => c[0].email.idempotencyKey);
    expect(keys[0]).toBe(`channel-expiring.5.${t}.7.u-owner`);
    expect(keys[2]).toBe(`channel-expiring.5.${t}.1.u-owner`);
    keys.forEach((k) => expect(k).toMatch(IDEMPOTENCY_KEY_RE));
  });

  it('uses stage 1 at 0 days left and stage 7 at 7', async () => {
    const { notifier, once } = setup();
    await notifier.expiring(channel, 0, ENDS);
    await notifier.expiring(channel, 7, ENDS);
    const t = ISSUED.getTime();
    expect(once.claim).toHaveBeenNthCalledWith(
      1,
      `channel-expiring.5.${t}.1`,
      TTL,
    );
    expect(once.claim).toHaveBeenNthCalledWith(
      2,
      `channel-expiring.5.${t}.7`,
      TTL,
    );
  });

  it('sends once per stage however often the scan repeats', async () => {
    const { notifier, notify } = setup();
    for (let i = 0; i < 3; i++) await notifier.expiring(channel, 5, ENDS);
    for (let i = 0; i < 3; i++) await notifier.expiring(channel, 1, ENDS);
    expect(notify.notify).toHaveBeenCalledTimes(4);
  });

  it('sends the same stage again after a reconnect issued a new token', async () => {
    const { notifier, notify } = setup();
    await notifier.expiring(channel, 6, ENDS);
    await notifier.expiring(
      {
        ...channel,
        refreshTokenIssuedAt: new Date(ISSUED.getTime() + 55 * DAY),
      },
      6,
      ENDS,
    );
    expect(notify.notify).toHaveBeenCalledTimes(4);
  });

  it('stays silent once access has already ended', async () => {
    const { notifier, notify, once } = setup();
    await notifier.expiring(channel, -1, new Date(Date.now() - 1000));
    expect(once.claim).not.toHaveBeenCalled();
    expect(notify.notify).not.toHaveBeenCalled();
  });

  it('never throws when the claim fails', async () => {
    const { notifier, once } = setup();
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    once.claim.mockRejectedValue(new Error('boom'));
    await expect(notifier.expiring(channel, 6, ENDS)).resolves.toBeUndefined();
    warn.mockRestore();
  });
});
