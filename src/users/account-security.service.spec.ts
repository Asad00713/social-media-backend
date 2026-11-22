import { BadRequestException, ConflictException, Logger } from '@nestjs/common';
import { PgDialect } from 'drizzle-orm/pg-core';
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
import type { SignInMethodChangedProps } from '../email/templates/security/sign-in-method-changed';
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
    /** What `update ... returning()` answers; defaults to the unlinked row. */
    updated?: unknown[];
    /** Rows SessionStore.revokeOthers reports. */
    revoked?: number;
  } = {},
) {
  const password =
    opts.password === undefined ? bcrypt.hashSync(OLD, 4) : opts.password;
  const findFirst = jest
    .fn()
    .mockResolvedValue(
      opts.user === undefined ? { id: 'u1', password } : opts.user,
    );
  const returning = jest.fn().mockResolvedValue(
    opts.updated ?? [
      {
        id: 'u1',
        email: 'u1@example.test',
        name: 'U',
        password,
        googleSub: null,
        passwordChangedAt: null,
      },
    ],
  );
  // Awaitable on its own (changePassword) and chainable into returning().
  const where = jest
    .fn()
    .mockImplementation(() =>
      Object.assign(Promise.resolve(undefined), { returning }),
    );
  const set = jest.fn().mockReturnValue({ where });
  const update = jest.fn().mockReturnValue({ set });
  // changePassword writes inside a transaction; `tx` is what it receives.
  const tx = { update };
  const transaction = jest.fn((fn: (t: typeof tx) => unknown) => fn(tx));
  const db = { query: { users: { findFirst } }, update, transaction };
  const sessions = {
    revokeOthers: jest.fn().mockResolvedValue(opts.revoked ?? 2),
    revokeAll: jest.fn().mockResolvedValue(3),
    clearTrust: jest.fn().mockResolvedValue(undefined),
  };

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
    sessions as never,
  );
  return {
    service,
    db,
    tx,
    sessions,
    set,
    where,
    returning,
    shouldSend,
    enqueue,
    tokens,
    emitter,
    geoip,
  };
}

/**
 * changePassword detaches the notice: resolves once the one it started has
 * finished, so its effects can be asserted.
 */
async function noticeSettled(spy: jest.SpyInstance): Promise<void> {
  expect(spy).toHaveBeenCalledTimes(1);
  await (spy.mock.results[0] as { value: Promise<void> }).value;
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

  it('success hashes, revokes the other sessions, enqueues password-changed (security footer), rings passwordChanged when security_alert app is on', async () => {
    const { service, set, sessions, tx, shouldSend, enqueue, tokens, emitter } =
      setup();
    const notice = jest.spyOn(service, 'sendPasswordChanged');

    const result = await service.changePassword(
      'u1',
      { currentPassword: OLD, newPassword: NEW },
      CTX,
      'sid-1',
    );
    await noticeSettled(notice);

    const written = firstArg<Record<string, unknown> & { password: string }>(
      set,
    );
    expect(written.password).not.toBe(NEW);
    await expect(bcrypt.compare(NEW, written.password)).resolves.toBe(true);
    // The floor is written by SessionStore only, never by this service.
    expect(written).not.toHaveProperty('sessionsRevokedAt');
    expect(sessions.revokeOthers).toHaveBeenCalledWith('u1', 'sid-1', tx);
    expect(result).toEqual({ revokedSessions: 2 });

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

  it('writes the password and revokes the other sessions in ONE transaction', async () => {
    const { service, db, tx, sessions, set } = setup();
    jest.spyOn(service, 'sendPasswordChanged').mockResolvedValue(undefined);

    await service.changePassword(
      'u1',
      { currentPassword: OLD, newPassword: NEW },
      CTX,
    );

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(db.update).toHaveBeenCalledTimes(1); // the tx.update (same mock)
    expect(sessions.revokeOthers).toHaveBeenCalledWith('u1', null, tx);
    expect(
      firstArg<{ passwordChangedAt: Date }>(set).passwordChangedAt,
    ).toBeInstanceOf(Date);
  });

  it('revokeOtherSessions: false keeps the other sessions: the password and its date are written, nothing is revoked, no revokedSessions', async () => {
    const { service, set, sessions } = setup();
    jest.spyOn(service, 'sendPasswordChanged').mockResolvedValue(undefined);

    const result = await service.changePassword(
      'u1',
      { currentPassword: OLD, newPassword: NEW, revokeOtherSessions: false },
      CTX,
    );

    const written = firstArg<Record<string, unknown>>(set);
    expect(written.password).toEqual(expect.any(String));
    expect(written.passwordChangedAt).toBeInstanceOf(Date);
    expect(written).not.toHaveProperty('sessionsRevokedAt');
    expect(sessions.revokeOthers).not.toHaveBeenCalled();
    expect(result).toEqual({});
  });

  it('revokeOtherSessions: false still clears every trusted device, in the password transaction (spec §7.2)', async () => {
    const { service, sessions, tx } = setup();
    jest.spyOn(service, 'sendPasswordChanged').mockResolvedValue(undefined);

    await service.changePassword(
      'u1',
      { currentPassword: OLD, newPassword: NEW, revokeOtherSessions: false },
      CTX,
    );

    expect(sessions.clearTrust).toHaveBeenCalledWith('u1', tx);
  });

  it('revokeOtherSessions: true revokes, like omitting it, and reports the count', async () => {
    const { service, set, sessions } = setup({ revoked: 5 });
    jest.spyOn(service, 'sendPasswordChanged').mockResolvedValue(undefined);

    const result = await service.changePassword(
      'u1',
      { currentPassword: OLD, newPassword: NEW, revokeOtherSessions: true },
      CTX,
      'sid-1',
    );

    expect(sessions.revokeOthers).toHaveBeenCalledWith(
      'u1',
      'sid-1',
      expect.anything(),
    );
    expect(result).toEqual({ revokedSessions: 5 });
    expect(
      firstArg<Record<string, unknown>>(set).passwordChangedAt,
    ).toBeInstanceOf(Date);
  });

  it('does not ring the bell when the security_alert app switch is off, and still emails', async () => {
    const { service, enqueue, emitter } = setup({ appAllowed: false });
    const notice = jest.spyOn(service, 'sendPasswordChanged');
    await service.changePassword(
      'u1',
      { currentPassword: OLD, newPassword: NEW },
      CTX,
    );
    await noticeSettled(notice);
    expect(emitter.passwordChanged).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('a failing notification never fails the password change', async () => {
    const { service, set, tokens } = setup();
    const notice = jest.spyOn(service, 'sendPasswordChanged');
    tokens.securityToken.mockImplementation(() => {
      throw new Error('JWT_ACCESS_SECRET is not configured');
    });
    await expect(
      service.changePassword(
        'u1',
        { currentPassword: OLD, newPassword: NEW },
        CTX,
      ),
    ).resolves.toEqual({ revokedSessions: 2 });
    await noticeSettled(notice);
    expect(set).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
  });

  it('answers without waiting for a slow GeoIP lookup or notify, after the sessions are revoked', async () => {
    const { service, set, where, enqueue, emitter, geoip } = setup();
    // It never resolves: an awaited notice would hang the response.
    geoip.lookup.mockReturnValue(new Promise<never>(() => undefined));
    const notice = jest.spyOn(service, 'sendPasswordChanged');

    await expect(
      service.changePassword(
        'u1',
        { currentPassword: OLD, newPassword: NEW },
        CTX,
      ),
    ).resolves.toEqual({ revokedSessions: 2 });

    // Revoke first, then answer: the one write landed before the notice ran.
    expect(set).toHaveBeenCalledTimes(1);
    expect(where).toHaveBeenCalledTimes(1);
    expect(notice).toHaveBeenCalledTimes(1);
    expect(where.mock.invocationCallOrder[0]).toBeLessThan(
      notice.mock.invocationCallOrder[0],
    );
    expect(enqueue).not.toHaveBeenCalled();
    expect(emitter.passwordChanged).not.toHaveBeenCalled();
  });

  it('answers without waiting for a notify that hangs', async () => {
    const { service, shouldSend } = setup();
    shouldSend.mockReturnValue(new Promise<never>(() => undefined));

    await expect(
      service.changePassword(
        'u1',
        { currentPassword: OLD, newPassword: NEW },
        CTX,
      ),
    ).resolves.toEqual({ revokedSessions: 2 });
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

  it('cuts the device label to the 120-char column, like the sign-in email', async () => {
    const { service, enqueue } = setup();
    const name = 'Z'.repeat(200);

    await service.sendPasswordChanged(
      'u1',
      { ip: null, userAgent: `${name}/1.0 (Windows NT 10.0; Win64)` },
      'settings',
    );

    const job = firstArg<EnqueueEmail<PasswordChangedProps>>(enqueue);
    expect(job.props.device).toHaveLength(120);
  });
});

describe('AccountSecurityService.revokeSessions', () => {
  it('ends every session through SessionStore.revokeAll (rows and the floor)', async () => {
    const { service, sessions, set } = setup();
    await service.revokeSessions('u1');
    expect(sessions.revokeAll).toHaveBeenCalledWith('u1');
    expect(set).not.toHaveBeenCalled();
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

describe('AccountSecurityService.disconnectGoogle', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  const linked = (password: string | null = bcrypt.hashSync(OLD, 4)) => ({
    id: 'u1',
    password,
    googleSub: 'google-sub-1',
  });

  async function conflictOf(p: Promise<unknown>): Promise<unknown> {
    try {
      await p;
    } catch (e) {
      expect(e).toBeInstanceOf(ConflictException);
      return (e as ConflictException).getResponse();
    }
    throw new Error('expected a ConflictException');
  }

  it('a Google-only account (no password) → 409 NO_PASSWORD and nothing is written', async () => {
    const { service, db, enqueue } = setup({ user: linked(null) });
    const body = await conflictOf(service.disconnectGoogle('u1', OLD, CTX));
    expect(body).toMatchObject({
      statusCode: 409,
      error: 'Conflict',
      code: 'NO_PASSWORD',
    });
    expect(db.update).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('Google is not linked → 409 GOOGLE_NOT_CONNECTED and nothing is written', async () => {
    const { service, db, enqueue } = setup({
      user: { id: 'u1', password: bcrypt.hashSync(OLD, 4), googleSub: null },
    });
    const body = await conflictOf(service.disconnectGoogle('u1', OLD, CTX));
    expect(body).toMatchObject({
      statusCode: 409,
      error: 'Conflict',
      code: 'GOOGLE_NOT_CONNECTED',
    });
    expect(db.update).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('an unknown user is a 404', async () => {
    const { service } = setup({ user: null });
    await expect(
      service.disconnectGoogle('u1', OLD, CTX),
    ).rejects.toMatchObject({ status: 404 });
  });

  it.each([['Wrong999'], [''], ['   ']])(
    'wrong password %p → 400 WRONG_PASSWORD (never 401), nothing written, no email',
    async (attempt) => {
      const { service, db, enqueue } = setup({ user: linked() });
      const body = await bodyOf(service.disconnectGoogle('u1', attempt, CTX));
      expect(body).toEqual({
        statusCode: 400,
        error: 'Bad Request',
        code: 'WRONG_PASSWORD',
        message: "That password isn't right.",
      });
      expect(db.update).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
    },
  );

  it('success clears googleSub, keeps the password and sessions, and returns hasGoogle: false', async () => {
    const { service, set } = setup({ user: linked() });
    jest.spyOn(service, 'sendSignInMethodChanged').mockResolvedValue();

    const result = await service.disconnectGoogle('u1', OLD, CTX);

    const written = firstArg<Record<string, unknown>>(set);
    expect(written.googleSub).toBeNull();
    expect(written.updatedAt).toBeInstanceOf(Date);
    // Only the link goes: no password change, no session revocation.
    expect(written).not.toHaveProperty('password');
    expect(written).not.toHaveProperty('sessionsRevokedAt');
    expect(result).toMatchObject({
      id: 'u1',
      email: 'u1@example.test',
      hasGoogle: false,
      hasPassword: true,
    });
    expect(result).not.toHaveProperty('password');
    expect(result).not.toHaveProperty('googleSub');
  });

  it('the write only matches a row that is still linked, so two clicks cannot both succeed', async () => {
    const { service, where } = setup({ user: linked() });
    jest.spyOn(service, 'sendSignInMethodChanged').mockResolvedValue();

    await service.disconnectGoogle('u1', OLD, CTX);

    const query = new PgDialect().sqlToQuery(
      firstArg<Parameters<PgDialect['sqlToQuery']>[0]>(where),
    );
    expect(query.sql).toContain('"users"."id" = $1');
    expect(query.sql).toContain('"users"."google_sub" is not null');
    expect(query.params).toEqual(['u1']);
  });

  it('lost the race (the write matched no row) → 409 GOOGLE_NOT_CONNECTED, no email', async () => {
    const { service, enqueue } = setup({ user: linked(), updated: [] });
    const body = await conflictOf(service.disconnectGoogle('u1', OLD, CTX));
    expect(body).toMatchObject({ code: 'GOOGLE_NOT_CONNECTED' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('queues the sign-in-method-changed email on the security footer, with no bell', async () => {
    const { service, enqueue, tokens, shouldSend, emitter } = setup({
      user: linked(),
    });
    const notice = jest.spyOn(service, 'sendSignInMethodChanged');

    await service.disconnectGoogle('u1', OLD, CTX);
    await noticeSettled(notice);

    expect(tokens.securityToken).toHaveBeenCalledWith({
      uid: 'u1',
      act: 'not_me',
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
    const job = firstArg<EnqueueEmail<SignInMethodChangedProps>>(enqueue);
    expect(job.template.id).toBe('sign-in-method-changed');
    expect(job.template.footer).toBe('security');
    expect(job.template.event).toBeNull();
    expect(job.to).toEqual({ email: 'u1@example.test', userId: 'u1' });
    expect(job.workspaceId).toBeNull();
    expect(job.idempotencyKey).toMatch(/^sign-in-method-changed\.u1\.\d+$/);
    expect(job.props.when).toMatch(/^[A-Z][a-z]{2} \d+, \d{4} at /);
    expect(job.props).toEqual({
      when: job.props.when,
      device: 'Chrome on Windows',
      location: 'Pakistan',
      method: 'google',
      change: 'disconnected',
      resetUrl: 'https://api.test/email/security/sec-token',
    });
    // The security_alert event is mandatory mail with no in-app bell here.
    expect(shouldSend).not.toHaveBeenCalled();
    expect(emitter.passwordChanged).not.toHaveBeenCalled();
  });

  it('no country and no user agent: location is null and the device is generic', async () => {
    const { service, enqueue } = setup({ user: linked(), geo: null });
    await service.sendSignInMethodChanged('u1', { ip: null, userAgent: null });
    const job = firstArg<EnqueueEmail<SignInMethodChangedProps>>(enqueue);
    expect(job.props).toMatchObject({
      device: 'Unknown browser',
      location: null,
    });
  });

  it('a notify failure (outbox down) does not fail the disconnect', async () => {
    const { service, enqueue, set } = setup({ user: linked() });
    const notice = jest.spyOn(service, 'sendSignInMethodChanged');
    enqueue.mockRejectedValue(new Error('redis is down'));

    const result = await service.disconnectGoogle('u1', OLD, CTX);
    await noticeSettled(notice);

    expect(result.hasGoogle).toBe(false);
    expect(set).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
  });

  it('a token-signing failure does not fail the disconnect either', async () => {
    const { service, tokens } = setup({ user: linked() });
    const notice = jest.spyOn(service, 'sendSignInMethodChanged');
    tokens.securityToken.mockImplementation(() => {
      throw new Error('JWT_ACCESS_SECRET is not configured');
    });

    await expect(
      service.disconnectGoogle('u1', OLD, CTX),
    ).resolves.toMatchObject({ hasGoogle: false });
    await noticeSettled(notice);
    expect(warn).toHaveBeenCalled();
  });

  it('answers without waiting for a slow GeoIP lookup, after the write landed', async () => {
    const { service, where, enqueue, geoip } = setup({ user: linked() });
    geoip.lookup.mockReturnValue(new Promise<never>(() => undefined));
    const notice = jest.spyOn(service, 'sendSignInMethodChanged');

    await expect(
      service.disconnectGoogle('u1', OLD, CTX),
    ).resolves.toMatchObject({ hasGoogle: false });

    expect(where).toHaveBeenCalledTimes(1);
    expect(where.mock.invocationCallOrder[0]).toBeLessThan(
      notice.mock.invocationCallOrder[0],
    );
    expect(enqueue).not.toHaveBeenCalled();
  });
});
