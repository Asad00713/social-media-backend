import { BadRequestException, Logger } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import type { GeoLocation, GeoipService } from '../auth/services/geoip.service';
import { AppLinks } from '../email/links/app-links';
import type { EmailOutboxService } from '../email/queue/email-outbox.service';
import type { EmailTokensService } from '../email/tokens/email-tokens.service';
import type { NotificationPreferencesService } from '../notification-preferences/notification-preferences.service';
import type { NotificationEmitterService } from '../notifications/notification-emitter.service';
import { NotifyService } from '../notifications/notify.service';
import type { RecipientsService } from '../notifications/recipients.service';
import type { EnqueueEmail } from '../email/queue/email-job';
import type { PasswordChangedProps } from '../email/templates/security/password-changed';
import { AccountSecurityService } from './account-security.service';

const OLD = 'OldPass123';
const NEW = 'NewPass456';
const CHROME_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const CTX = { ip: '39.48.12.201', userAgent: CHROME_WINDOWS };

/** The first argument of a mock's first call, typed (mock.calls is any[][]). */
function firstArg<T>(mock: jest.Mock): T {
  return (mock.mock.calls as unknown[][])[0][0] as T;
}

function setup(
  opts: {
    password?: string | null;
    appAllowed?: boolean;
    user?: unknown;
    geo?: GeoLocation | null;
  } = {},
) {
  const password =
    opts.password === undefined ? bcrypt.hashSync(OLD, 4) : opts.password;
  const findFirst = jest
    .fn()
    .mockResolvedValue(
      opts.user === undefined ? { id: 'u1', password } : opts.user,
    );
  const where = jest.fn().mockResolvedValue(undefined);
  const set = jest.fn().mockReturnValue({ where });
  const update = jest.fn().mockReturnValue({ set });
  const db = { query: { users: { findFirst } }, update };

  const shouldSend = jest.fn().mockResolvedValue(opts.appAllowed ?? true);
  const enqueue = jest.fn().mockResolvedValue(undefined);
  const recipients = {
    user: jest
      .fn()
      .mockResolvedValue({ id: 'u1', email: 'u1@example.test', name: 'U' }),
    userTimezone: jest.fn().mockResolvedValue('Asia/Karachi'),
  };
  const notify = new NotifyService(
    { shouldSend } as unknown as NotificationPreferencesService,
    { enqueue } as unknown as EmailOutboxService,
    recipients as unknown as RecipientsService,
  );
  const tokens = { securityToken: jest.fn().mockReturnValue('sec-token') };
  const links = new AppLinks({
    get: (key: string) =>
      key === 'API_PUBLIC_URL' ? 'https://api.test' : undefined,
  } as never);
  const geoip = {
    lookup: jest
      .fn()
      .mockResolvedValue(
        opts.geo === undefined
          ? { country: 'Pakistan', countryCode: 'PK' }
          : opts.geo,
      ),
  };
  const emitter = { passwordChanged: jest.fn().mockResolvedValue(undefined) };

  const service = new AccountSecurityService(
    db as never,
    notify,
    recipients as unknown as RecipientsService,
    tokens as unknown as EmailTokensService,
    links,
    geoip as unknown as GeoipService,
    emitter as unknown as NotificationEmitterService,
  );
  return { service, db, set, where, shouldSend, enqueue, tokens, emitter };
}

async function bodyOf(p: Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(BadRequestException);
    return (e as BadRequestException).getResponse() as Record<string, unknown>;
  }
  throw new Error('expected a BadRequestException');
}

describe('AccountSecurityService.changePassword', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('password user: missing current → CURRENT_PASSWORD_REQUIRED (400, not 401)', async () => {
    const { service, db } = setup();
    const body = await bodyOf(
      service.changePassword('u1', { newPassword: NEW }, CTX),
    );
    expect(body).toEqual({
      statusCode: 400,
      error: 'Bad Request',
      code: 'CURRENT_PASSWORD_REQUIRED',
      message: 'Enter your current password.',
    });
    expect(db.update).not.toHaveBeenCalled();
  });

  it('password user: wrong current → CURRENT_PASSWORD_INCORRECT', async () => {
    const { service, db } = setup();
    const body = await bodyOf(
      service.changePassword(
        'u1',
        { currentPassword: 'Wrong999', newPassword: NEW },
        CTX,
      ),
    );
    expect(body).toMatchObject({
      statusCode: 400,
      code: 'CURRENT_PASSWORD_INCORRECT',
      message: "That password isn't right.",
    });
    expect(db.update).not.toHaveBeenCalled();
  });

  it('same new password → PASSWORD_UNCHANGED', async () => {
    const { service, db } = setup();
    const body = await bodyOf(
      service.changePassword(
        'u1',
        { currentPassword: OLD, newPassword: OLD },
        CTX,
      ),
    );
    expect(body).toMatchObject({
      statusCode: 400,
      code: 'PASSWORD_UNCHANGED',
      message: "Choose a password you haven't used here.",
    });
    expect(db.update).not.toHaveBeenCalled();
  });

  it('google-only user (password null) → PASSWORD_NOT_SET and nothing is written', async () => {
    const { service, db, enqueue, emitter } = setup({ password: null });
    const body = await bodyOf(
      service.changePassword(
        'u1',
        { currentPassword: 'anything', newPassword: NEW },
        CTX,
      ),
    );
    expect(body).toMatchObject({
      statusCode: 400,
      code: 'PASSWORD_NOT_SET',
      message:
        'Your account signs in with Google. Use "Forgot password" to set a password.',
    });
    expect(db.update).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(emitter.passwordChanged).not.toHaveBeenCalled();
  });

  it('success hashes, sets sessions_revoked_at, enqueues password-changed (security footer), rings passwordChanged when security_alert app is on', async () => {
    const { service, set, shouldSend, enqueue, tokens, emitter } = setup();
    const before = Date.now();

    await service.changePassword(
      'u1',
      { currentPassword: OLD, newPassword: NEW },
      CTX,
    );

    const written = firstArg<{ password: string; sessionsRevokedAt: Date }>(
      set,
    );
    expect(written.password).not.toBe(NEW);
    await expect(bcrypt.compare(NEW, written.password)).resolves.toBe(true);
    expect(written.sessionsRevokedAt).toBeInstanceOf(Date);
    expect(written.sessionsRevokedAt.getTime()).toBeGreaterThanOrEqual(before);

    expect(tokens.securityToken).toHaveBeenCalledWith({
      uid: 'u1',
      act: 'not_me',
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
    const job = firstArg<EnqueueEmail<PasswordChangedProps>>(enqueue);
    expect(job.template.id).toBe('password-changed');
    expect(job.template.footer).toBe('security');
    expect(job.template.event).toBeNull();
    expect(job.to).toEqual({ email: 'u1@example.test', userId: 'u1' });
    expect(job.workspaceId).toBeNull();
    expect(job.idempotencyKey).toMatch(/^password-changed\.u1\.\d+$/);
    expect(job.props.when).toMatch(/^[A-Z][a-z]{2} \d+, \d{4} at /);
    expect(job.props).toMatchObject({
      device: 'Chrome on Windows',
      location: 'Pakistan',
      via: 'settings',
      resetUrl: 'https://api.test/email/security/sec-token',
    });

    expect(shouldSend).toHaveBeenCalledWith(
      'u1',
      null,
      'security_alert',
      'app',
    );
    expect(emitter.passwordChanged).toHaveBeenCalledWith('u1');
  });

  it('does not ring the bell when the security_alert app switch is off, and still emails', async () => {
    const { service, enqueue, emitter } = setup({ appAllowed: false });
    await service.changePassword(
      'u1',
      { currentPassword: OLD, newPassword: NEW },
      CTX,
    );
    expect(emitter.passwordChanged).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('a failing notification never fails the password change', async () => {
    const { service, set, tokens } = setup();
    tokens.securityToken.mockImplementation(() => {
      throw new Error('JWT_ACCESS_SECRET is not configured');
    });
    await expect(
      service.changePassword(
        'u1',
        { currentPassword: OLD, newPassword: NEW },
        CTX,
      ),
    ).resolves.toBeUndefined();
    expect(set).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
  });
});

describe('AccountSecurityService.sendPasswordChanged', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation());
  afterEach(() => jest.restoreAllMocks());

  it('via reset, with no country and no user agent', async () => {
    const { service, enqueue } = setup({ geo: null });

    await service.sendPasswordChanged(
      'u1',
      { ip: null, userAgent: null },
      'reset',
    );

    const job = firstArg<EnqueueEmail<PasswordChangedProps>>(enqueue);
    expect(job.props).toMatchObject({
      via: 'reset',
      device: 'Unknown browser',
      location: null,
    });
  });
});

describe('AccountSecurityService.revokeSessions', () => {
  it('stamps sessions_revoked_at', async () => {
    const { service, set } = setup();
    await service.revokeSessions('u1');
    expect(
      firstArg<{ sessionsRevokedAt: Date }>(set).sessionsRevokedAt,
    ).toBeInstanceOf(Date);
  });
});

describe('AccountSecurityService.verifyCurrentPassword', () => {
  it('accepts the right password and skips an account with none', async () => {
    const { service } = setup();
    const hash = bcrypt.hashSync(OLD, 4);
    await expect(
      service.verifyCurrentPassword({ password: hash }, OLD),
    ).resolves.toBeUndefined();
    await expect(
      service.verifyCurrentPassword({ password: null }, undefined),
    ).resolves.toBeUndefined();
  });

  it('treats an empty string as missing', async () => {
    const { service } = setup();
    const body = await bodyOf(
      service.verifyCurrentPassword({ password: bcrypt.hashSync(OLD, 4) }, ''),
    );
    expect(body.code).toBe('CURRENT_PASSWORD_REQUIRED');
  });
});

describe('AccountSecurityService.deviceLabel', () => {
  const { service } = setup();

  it.each([
    [CHROME_WINDOWS, 'Chrome on Windows'],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
      'Safari on macOS',
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
      'Safari on iOS',
    ],
    [null, 'Unknown browser'],
    ['', 'Unknown browser'],
    ['curl-like garbage ###', 'Unknown browser'],
  ])('%p → %p', (ua, label) => {
    expect(service.deviceLabel(ua)).toBe(label);
  });
});
