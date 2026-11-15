import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { JwtService } from '@nestjs/jwt';
import type { DbType } from '../drizzle/db';
import type { EmailOutboxService } from '../email/queue/email-outbox.service';
import { adminLoginCodeTemplate } from '../email/templates/security/admin-login-code';
import { AdminChallengeService } from './admin-challenge.service';

const CHALLENGE_ID = '3f2b8c1e-5a47-4d0e-9f11-0c1d2e3f4a5b';
const ADMIN = {
  id: 'u-admin',
  email: 'owner@schedura.test',
  role: 'SUPER_ADMIN',
  isActive: true,
};

function make(
  options: {
    user?: object | undefined;
    recent?: object | undefined;
    sendNow?: jest.Mock;
  } = {},
) {
  const user = 'user' in options ? options.user : ADMIN;
  const returning = jest.fn().mockResolvedValue([{ id: CHALLENGE_ID }]);
  const values = jest.fn(() => ({ returning }));
  const db = {
    query: {
      users: { findFirst: jest.fn().mockResolvedValue(user) },
      adminLoginChallenges: {
        findFirst: jest.fn().mockResolvedValue(options.recent),
      },
    },
    insert: jest.fn(() => ({ values })),
  };
  const sendNow =
    options.sendNow ?? jest.fn().mockResolvedValue({ success: true });
  const service = new AdminChallengeService(
    db as unknown as DbType,
    {} as JwtService,
    { get: () => 'production' } as unknown as ConfigService,
    { sendNow } as unknown as EmailOutboxService,
  );
  return { service, db, values, sendNow };
}

describe('AdminChallengeService.requestChallenge', () => {
  let logged: string[];

  beforeEach(() => {
    logged = [];
    const capture = (message: unknown) => {
      logged.push(String(message));
    };
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(capture);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(capture);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(capture);
  });

  afterEach(() => jest.restoreAllMocks());

  it('sends the code inline, never through the queue, keyed by the challenge', async () => {
    const { service, sendNow, values } = make();

    await service.requestChallenge('Owner@Schedura.test', '203.0.113.9');

    expect(sendNow).toHaveBeenCalledTimes(1);
    const sent = (sendNow.mock.calls as unknown[][])[0][0] as {
      template: unknown;
      props: { code: string; ip: string | null };
      to: { email: string; userId: string | null };
      idempotencyKey: string;
    };
    expect(sent.template).toBe(adminLoginCodeTemplate);
    expect(sent.to).toEqual({ email: ADMIN.email, userId: ADMIN.id });
    expect(sent.idempotencyKey).toBe(`admin-code.${CHALLENGE_ID}`);
    expect(sent.idempotencyKey).toMatch(/^[A-Za-z0-9._-]{1,200}$/);
    expect(sent.props.ip).toBe('203.0.113.9');
    // The emailed code is the one whose hash was stored.
    expect(sent.props.code).toMatch(/^\d{6}$/);
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ userId: ADMIN.id, requestIp: '203.0.113.9' }),
    );
  });

  it('passes a null ip when the request address is unknown', async () => {
    const { service, sendNow } = make();

    await service.requestChallenge(ADMIN.email);

    const sent = (
      sendNow.mock.calls as { props: { ip: string | null } }[][]
    )[0][0];
    expect(sent.props.ip).toBeNull();
  });

  it('answers the same way and logs the failure, never the code, when the send fails', async () => {
    const { service } = make({
      sendNow: jest
        .fn()
        .mockResolvedValue({ success: false, error: 'Resend is down' }),
    });

    await expect(
      service.requestChallenge(ADMIN.email),
    ).resolves.toBeUndefined();

    expect(logged.join('\n')).toContain('Resend is down');
    expect(logged.join('\n')).not.toMatch(/\b\d{6}\b/);
  });

  it('sends nothing for an address that is not an active super admin', async () => {
    for (const user of [
      undefined,
      { ...ADMIN, role: 'USER' },
      { ...ADMIN, isActive: false },
    ]) {
      const { service, sendNow, db } = make({ user });
      await service.requestChallenge('someone@else.test');
      expect(sendNow).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    }
  });
});
