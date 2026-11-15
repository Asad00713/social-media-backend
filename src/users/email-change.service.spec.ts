import { createHash } from 'crypto';
import { HttpException, Logger } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import type { GeoipService } from '../auth/services/geoip.service';
import { AppLinks } from '../email/links/app-links';
import type { EnqueueEmail } from '../email/queue/email-job';
import type { EmailOutboxService } from '../email/queue/email-outbox.service';
import type { ChangeEmailCodeProps } from '../email/templates/security/change-email-code';
import type { EmailChangedProps } from '../email/templates/security/email-changed';
import type { EmailTokensService } from '../email/tokens/email-tokens.service';
import type { RecipientsService } from '../notifications/recipients.service';
import { AccountSecurityService } from './account-security.service';
import { EmailChangeService } from './email-change.service';

const PASSWORD = 'OldPass123';
const OLD_EMAIL = 'rehman@lumierecafe.pk';
const NEW_EMAIL = 'rehman@lumiere.cafe';
const CHROME_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const CTX = { ip: '39.48.12.201', userAgent: CHROME_WINDOWS };

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

interface Row {
  id: string;
  email: string;
  password: string | null;
  isEmailVerified: boolean;
  pendingEmail: string | null;
  pendingEmailCodeHash: string | null;
  pendingEmailExpiresAt: Date | null;
  pendingEmailAttempts: number;
  [column: string]: unknown;
}

/**
 * A one-row users table. Every `update().set()` is recorded and applied to the
 * row; `select…for('update')` reads the row, `select…limit(1)` is the "does
 * another account use this address" check. The transaction runs its callback
 * on the same object (rollback is the DB spec's job).
 */
function fakeDb(
  row: Row,
  opts: { taken?: boolean; uniqueViolation?: boolean },
) {
  const writes: Record<string, unknown>[] = [];
  const select = jest.fn(() => {
    const b = {
      from: () => b,
      where: () => b,
      for: () => Promise.resolve([{ ...row }]),
      limit: () => Promise.resolve(opts.taken ? [{ id: 'someone-else' }] : []),
    };
    return b;
  });
  const update = jest.fn(() => ({
    set: (values: Record<string, unknown>) => ({
      where: () => {
        const apply = () => {
          writes.push(values);
          Object.assign(row, values);
        };
        return {
          returning: () => {
            if (opts.uniqueViolation) {
              return Promise.reject(
                Object.assign(new Error('Failed query'), {
                  cause: { code: '23505' },
                }),
              );
            }
            apply();
            return Promise.resolve([{ ...row }]);
          },
          then: (resolve: (v: undefined) => unknown) => {
            apply();
            return Promise.resolve(undefined).then(resolve);
          },
        };
      },
    }),
  }));
  const db = {
    query: {
      users: {
        findFirst: jest.fn(() =>
          Promise.resolve({
            id: row.id,
            email: row.email,
            password: row.password,
          }),
        ),
      },
    },
    select,
    update,
    transaction: jest.fn(),
  };
  db.transaction.mockImplementation((fn: (tx: typeof db) => Promise<unknown>) =>
    fn(db),
  );
  return { db, writes };
}

function userRow(over: Partial<Row> = {}): Row {
  return {
    id: 'u1',
    email: OLD_EMAIL,
    password: bcrypt.hashSync(PASSWORD, 4),
    name: 'Rehman',
    role: 'USER',
    isEmailVerified: false,
    lastAccessedWorkspaceId: null,
    onboardingCompletedAt: null,
    maestroTone: 'professional',
    useCase: null,
    avatarUrl: null,
    avatarColor: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    pendingEmail: null,
    pendingEmailCodeHash: null,
    pendingEmailExpiresAt: null,
    pendingEmailAttempts: 0,
    ...over,
  };
}

/** A row with a change to NEW_EMAIL waiting for `code`. */
function pendingRow(code = '305771', over: Partial<Row> = {}): Row {
  return userRow({
    pendingEmail: NEW_EMAIL,
    pendingEmailCodeHash: sha256(code),
    pendingEmailExpiresAt: new Date(Date.now() + 5 * 60_000),
    ...over,
  });
}

function setup(
  row: Row,
  opts: {
    taken?: boolean;
    uniqueViolation?: boolean;
    sendFails?: boolean;
  } = {},
) {
  const { db, writes } = fakeDb(row, opts);
  const sendNow = jest
    .fn()
    .mockResolvedValue(
      opts.sendFails
        ? { success: false, error: 'Resend 500' }
        : { success: true, messageId: 'm1' },
    );
  const enqueue = jest.fn().mockResolvedValue(undefined);
  const tokens = { securityToken: jest.fn().mockReturnValue('sec-token') };
  const links = new AppLinks({
    get: (key: string) =>
      key === 'API_PUBLIC_URL' ? 'https://api.test' : undefined,
  } as never);
  const geoip = {
    lookup: jest
      .fn()
      .mockResolvedValue({ country: 'Pakistan', countryCode: 'PK' }),
  };
  const recipients = {
    userTimezone: jest.fn().mockResolvedValue('Asia/Karachi'),
  };
  // verifyCurrentPassword and deviceLabel use none of the service's deps.
  const none = null as never;
  const security = new AccountSecurityService(
    none,
    none,
    none,
    none,
    none,
    none,
    none,
  );
  const service = new EmailChangeService(
    db as never,
    security,
    { sendNow, enqueue } as unknown as EmailOutboxService,
    tokens as unknown as EmailTokensService,
    links,
    geoip as unknown as GeoipService,
    recipients as unknown as RecipientsService,
  );
  return { service, db, writes, sendNow, enqueue, tokens, row };
}

/** The error body a request answers with, or fails the test. */
async function refusal(
  p: Promise<unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  try {
    await p;
  } catch (e) {
    if (e instanceof HttpException) {
      return {
        status: e.getStatus(),
        body: e.getResponse() as Record<string, unknown>,
      };
    }
    throw e;
  }
  throw new Error('expected a refusal');
}

function firstArg<T>(mock: jest.Mock): T {
  return (mock.mock.calls as unknown[][])[0][0] as T;
}

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('EmailChangeService.request', () => {
  it('request: password user without current password → CURRENT_PASSWORD_REQUIRED', async () => {
    const { service, writes, sendNow } = setup(userRow());

    const { status, body } = await refusal(
      service.request('u1', { newEmail: NEW_EMAIL }),
    );

    expect(status).toBe(400);
    expect(body).toMatchObject({
      code: 'CURRENT_PASSWORD_REQUIRED',
      message: 'Enter your current password.',
    });
    expect(writes).toEqual([]);
    expect(sendNow).not.toHaveBeenCalled();
  });

  it('a wrong current password → CURRENT_PASSWORD_INCORRECT, still a 400', async () => {
    const { service, writes } = setup(userRow());

    const { status, body } = await refusal(
      service.request('u1', { newEmail: NEW_EMAIL, currentPassword: 'nope' }),
    );

    expect(status).toBe(400);
    expect(body.code).toBe('CURRENT_PASSWORD_INCORRECT');
    expect(writes).toEqual([]);
  });

  it('a Google-only account (no password) needs no current password', async () => {
    const { service, sendNow } = setup(userRow({ password: null }));

    await service.request('u1', { newEmail: NEW_EMAIL });

    expect(sendNow).toHaveBeenCalledTimes(1);
  });

  it('request: same address (after normalisation, e.g. "Me@X.com " vs "me@x.com") → EMAIL_UNCHANGED', async () => {
    const { service, writes, sendNow } = setup(userRow({ email: 'me@x.com' }));

    const { status, body } = await refusal(
      service.request('u1', {
        newEmail: 'Me@X.com ',
        currentPassword: PASSWORD,
      }),
    );

    expect(status).toBe(400);
    expect(body).toMatchObject({
      code: 'EMAIL_UNCHANGED',
      message: "That's already your email.",
    });
    expect(writes).toEqual([]);
    expect(sendNow).not.toHaveBeenCalled();
  });

  it('request: address of another user → 409 EMAIL_TAKEN', async () => {
    const { service, writes, sendNow } = setup(userRow(), { taken: true });

    const { status, body } = await refusal(
      service.request('u1', { newEmail: NEW_EMAIL, currentPassword: PASSWORD }),
    );

    expect(status).toBe(409);
    expect(body).toMatchObject({
      code: 'EMAIL_TAKEN',
      message: 'Another account already uses that email.',
    });
    expect(writes).toEqual([]);
    expect(sendNow).not.toHaveBeenCalled();
  });

  it('request: sends A3 inline to the NEW address only, stores sha256 not the code', async () => {
    const { service, writes, sendNow, enqueue, row } = setup(userRow());
    const before = Date.now();

    const result = await service.request('u1', {
      newEmail: '  Rehman@Lumiere.CAFE ',
      currentPassword: PASSWORD,
    });

    expect(enqueue).not.toHaveBeenCalled();
    expect(sendNow).toHaveBeenCalledTimes(1);
    const mail = firstArg<EnqueueEmail<ChangeEmailCodeProps>>(sendNow);
    expect(mail.template.id).toBe('change-email-code');
    expect(mail.to).toEqual({ email: NEW_EMAIL, userId: 'u1' });
    expect(mail.props.newEmail).toBe(NEW_EMAIL);
    expect(mail.props.code).toMatch(/^\d{6}$/);
    expect(mail.idempotencyKey).toMatch(/^change-email-code\.u1\.\d+$/);

    expect(writes).toHaveLength(1);
    const stored = writes[0];
    expect(stored.pendingEmail).toBe(NEW_EMAIL);
    expect(stored.pendingEmailCodeHash).toBe(sha256(mail.props.code));
    expect(stored.pendingEmailAttempts).toBe(0);
    expect(Object.values(stored)).not.toContain(mail.props.code);
    // The account keeps its address until the code comes back.
    expect(row.email).toBe(OLD_EMAIL);

    const expiresAt = new Date(result.expiresAt).getTime();
    expect(expiresAt - before).toBeGreaterThanOrEqual(10 * 60_000 - 50);
    expect(expiresAt - before).toBeLessThanOrEqual(10 * 60_000 + 1000);
    expect(result.pendingEmail).toBe(NEW_EMAIL);
  });

  it('re-requesting replaces the pending code and resets the wrong guesses', async () => {
    const { service, row } = setup(
      pendingRow('111111', { pendingEmailAttempts: 3 }),
    );

    await service.request('u1', {
      newEmail: NEW_EMAIL,
      currentPassword: PASSWORD,
    });

    expect(row.pendingEmailCodeHash).not.toBe(sha256('111111'));
    expect(row.pendingEmailAttempts).toBe(0);
  });

  it('a send failure clears the pending columns and answers 503 EMAIL_SEND_FAILED', async () => {
    const { service, row } = setup(userRow(), { sendFails: true });

    const { status, body } = await refusal(
      service.request('u1', { newEmail: NEW_EMAIL, currentPassword: PASSWORD }),
    );

    expect(status).toBe(503);
    expect(body).toMatchObject({
      code: 'EMAIL_SEND_FAILED',
      message: "We couldn't send the code. Try again in a minute.",
    });
    expect(row).toMatchObject({
      pendingEmail: null,
      pendingEmailCodeHash: null,
      pendingEmailExpiresAt: null,
      pendingEmailAttempts: 0,
    });
  });
});

describe('EmailChangeService.confirm', () => {
  it('no change started → EMAIL_CHANGE_NOT_STARTED', async () => {
    const { service } = setup(userRow());

    const { status, body } = await refusal(
      service.confirm('u1', '305771', CTX),
    );

    expect(status).toBe(400);
    expect(body).toMatchObject({
      code: 'EMAIL_CHANGE_NOT_STARTED',
      message: 'Start the email change again.',
    });
  });

  it('confirm: wrong code → CODE_INVALID with attemptsLeft 4; 5th wrong → CODE_LOCKED and pending cleared', async () => {
    const { service, row, enqueue } = setup(pendingRow('305771'));

    const first = await refusal(service.confirm('u1', '000000', CTX));
    expect(first.status).toBe(400);
    expect(first.body).toMatchObject({
      code: 'CODE_INVALID',
      message: "That code isn't right.",
      attemptsLeft: 4,
    });
    expect(row.pendingEmailAttempts).toBe(1);

    for (const left of [3, 2, 1]) {
      const r = await refusal(service.confirm('u1', '000000', CTX));
      expect(r.body.attemptsLeft).toBe(left);
    }

    const fifth = await refusal(service.confirm('u1', '000000', CTX));
    expect(fifth.status).toBe(400);
    expect(fifth.body).toMatchObject({
      code: 'CODE_LOCKED',
      message: 'Too many wrong codes. Start the email change again.',
    });
    expect(row).toMatchObject({
      email: OLD_EMAIL,
      pendingEmail: null,
      pendingEmailCodeHash: null,
      pendingEmailExpiresAt: null,
      pendingEmailAttempts: 0,
    });

    // Locked means gone: even the right code no longer works.
    const after = await refusal(service.confirm('u1', '305771', CTX));
    expect(after.body.code).toBe('EMAIL_CHANGE_NOT_STARTED');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('confirm: expired → CODE_EXPIRED', async () => {
    const { service, row } = setup(
      pendingRow('305771', { pendingEmailExpiresAt: new Date(Date.now() - 1) }),
    );

    const { status, body } = await refusal(
      service.confirm('u1', '305771', CTX),
    );

    expect(status).toBe(400);
    expect(body).toMatchObject({
      code: 'CODE_EXPIRED',
      message: 'That code has expired. Send a new one.',
    });
    expect(row.email).toBe(OLD_EMAIL);
  });

  it('confirm: "305 771" with a space is accepted', async () => {
    const { service, row } = setup(pendingRow('305771'));

    const user = await service.confirm('u1', '305 771', CTX);

    expect(user.email).toBe(NEW_EMAIL);
    expect(row.email).toBe(NEW_EMAIL);
  });

  it('confirm: success switches email, verifies it, enqueues A4 to the OLD address with a revert link', async () => {
    const { service, row, enqueue, tokens } = setup(pendingRow('305771'));

    const user = await service.confirm('u1', '305771', CTX);

    expect(row).toMatchObject({
      email: NEW_EMAIL,
      isEmailVerified: true,
      pendingEmail: null,
      pendingEmailCodeHash: null,
      pendingEmailExpiresAt: null,
      pendingEmailAttempts: 0,
    });
    expect(user).toMatchObject({
      id: 'u1',
      email: NEW_EMAIL,
      isEmailVerified: true,
      hasPassword: true,
    });
    // The public user carries no pending column and no hash.
    expect(Object.keys(user)).not.toEqual(
      expect.arrayContaining(['password', 'pendingEmailCodeHash']),
    );

    expect(tokens.securityToken).toHaveBeenCalledWith({
      uid: 'u1',
      act: 'revert_email',
      from: OLD_EMAIL,
      to: NEW_EMAIL,
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
    const mail = firstArg<EnqueueEmail<EmailChangedProps>>(enqueue);
    expect(mail.template.id).toBe('email-changed');
    expect(mail.to).toEqual({ email: OLD_EMAIL, userId: 'u1' });
    expect(mail.idempotencyKey).toMatch(/^email-changed\.u1\.\d+$/);
    expect(mail.props).toMatchObject({
      from: OLD_EMAIL,
      to: NEW_EMAIL,
      device: 'Chrome on Windows · Pakistan',
      secureUrl: 'https://api.test/email/security/sec-token',
    });
    expect(mail.props.when).toMatch(/2026|20\d\d/);
  });

  it('confirm: the address registered since the request → 409 EMAIL_TAKEN, nothing written', async () => {
    const { service, row, writes, enqueue } = setup(pendingRow('305771'), {
      taken: true,
    });

    const { status, body } = await refusal(
      service.confirm('u1', '305771', CTX),
    );

    expect(status).toBe(409);
    expect(body.code).toBe('EMAIL_TAKEN');
    expect(writes).toEqual([]);
    expect(row.email).toBe(OLD_EMAIL);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('confirm: a unique violation at the write (a signup won the race) → 409 EMAIL_TAKEN, not a 500', async () => {
    const { service, enqueue } = setup(pendingRow('305771'), {
      uniqueViolation: true,
    });

    const { status, body } = await refusal(
      service.confirm('u1', '305771', CTX),
    );

    expect(status).toBe(409);
    expect(body.code).toBe('EMAIL_TAKEN');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('a failed A4 never fails the change', async () => {
    const { service, enqueue } = setup(pendingRow('305771'));
    enqueue.mockRejectedValueOnce(new Error('Redis down'));

    const user = await service.confirm('u1', '305771', CTX);

    expect(user.email).toBe(NEW_EMAIL);
  });
});
