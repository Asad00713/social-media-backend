import { HttpException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import {
  decryptStrict,
  encryptTotpSecret,
} from '../../common/utils/totp-secret.util';
import { mfaCodeInvalid } from './mfa-errors';
import { requireOneFactor } from './second-factor.service';
import { REAUTH_WINDOW_MS, TwoFactorService } from './two-factor.service';

jest.mock('bcrypt', () => ({ compare: jest.fn() }));

const USER_ID = '11111111-1111-4111-8111-111111111111';
const SID = '22222222-2222-4222-8222-222222222222';
const MIN = 60 * 1000;

interface Row {
  id: string;
  email: string;
  password: string | null;
  isEmailVerified: boolean;
  totpEnabledAt: Date | null;
  totpPendingSecretEnc: string | null;
}

function build(over: Partial<Row> = {}, opts: { promote?: boolean } = {}) {
  const row: Row = {
    id: USER_ID,
    email: 'a@b.co',
    password: '$2b$10$hash',
    isEmailVerified: true,
    totpEnabledAt: null,
    totpPendingSecretEnc: null,
    ...over,
  };
  const writes: Array<Record<string, unknown>> = [];
  const update = jest.fn(() => ({
    set: (values: Record<string, unknown>) => {
      writes.push(values);
      const where = () => {
        const done = Promise.resolve(undefined);
        return Object.assign(done, {
          returning: () =>
            Promise.resolve(opts.promote === false ? [] : [{ id: USER_ID }]),
        });
      };
      return { where };
    },
  }));
  const tx = { update, tx: true };
  const order: string[] = [];
  const db = {
    query: { users: { findFirst: jest.fn(() => Promise.resolve(row)) } },
    update,
    transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => {
      order.push('tx:start');
      const r = await fn(tx);
      order.push('tx:commit');
      return r;
    }),
  };
  const secondFactor = {
    // Like the real one: exactly one factor, else MFA_CODE_REQUIRED.
    check: jest.fn(
      (_u: string, input: { code?: string; backupCode?: string }) => {
        requireOneFactor(input);
        return Promise.resolve({ method: 'totp', backupCodesRemaining: 10 });
      },
    ),
    replaceBackupCodes: jest.fn(() => {
      order.push('replaceBackupCodes');
      return Promise.resolve(
        Array.from({ length: 10 }, (_, i) => `AAAA-AAA${i}`),
      );
    }),
    clear: jest.fn(() => {
      order.push('clear');
      return Promise.resolve();
    }),
    isEnabled: jest.fn(() => Promise.resolve(row.totpEnabledAt !== null)),
    status: jest.fn(() =>
      Promise.resolve({
        enabled: row.totpEnabledAt !== null,
        enabledAt: row.totpEnabledAt,
        backupCodesRemaining: 7,
      }),
    ),
  };
  const sessions = {
    createdAt: jest.fn(() => Promise.resolve(new Date())),
    revokeOthers: jest.fn(() => {
      order.push('revokeOthers');
      return Promise.resolve(2);
    }),
  };
  const issuer = {
    issue: jest.fn((_u: string, _q: unknown, res: { cookie: jest.Mock }) => {
      order.push('issue');
      res.cookie('refreshToken', 'r');
      return Promise.resolve({
        kind: 'session',
        accessToken: 'access',
        sid: SID,
      });
    }),
  };
  const notices = {
    enabled: jest.fn().mockResolvedValue(undefined),
    disabled: jest.fn().mockResolvedValue(undefined),
    regenerated: jest.fn().mockResolvedValue(undefined),
  };
  const service = new TwoFactorService(
    db as never,
    secondFactor as never,
    sessions as never,
    issuer as never,
    notices as never,
  );
  const res = { cookie: jest.fn() };
  const req = {
    headers: { 'user-agent': 'UA', 'x-real-ip': '203.0.113.9' },
  } as never;
  return {
    service,
    row,
    db,
    tx,
    writes,
    secondFactor,
    sessions,
    issuer,
    notices,
    res,
    req,
    order,
  };
}

const caller = (sid: string | null = SID) => ({ userId: USER_ID, sid });

async function codeOf(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    if (e instanceof HttpException) {
      const body = e.getResponse() as { code?: string };
      return { status: e.getStatus(), code: body.code };
    }
    throw e;
  }
  return { status: 200, code: 'ok' };
}

const compare = bcrypt.compare as unknown as jest.Mock;

beforeAll(() => {
  process.env.ENCRYPTION_KEY = 'a'.repeat(64);
});
beforeEach(() => {
  jest.useRealTimers();
  compare.mockReset();
  compare.mockImplementation((plain: string) =>
    Promise.resolve(plain === 'right'),
  );
});

describe('TwoFactorService.setup', () => {
  it('with a wrong password → 400 WRONG_PASSWORD, nothing stored', async () => {
    const b = build();
    expect(
      await codeOf(b.service.setup(caller(), { currentPassword: 'wrong' })),
    ).toEqual({ status: 400, code: 'WRONG_PASSWORD' });
    expect(b.writes).toEqual([]);
  });

  it('a password account without currentPassword → 400 WRONG_PASSWORD', async () => {
    const b = build();
    expect(await codeOf(b.service.setup(caller(), {}))).toEqual({
      status: 400,
      code: 'WRONG_PASSWORD',
    });
    expect(compare).not.toHaveBeenCalled();
  });

  it('stores an encrypted PENDING secret and shows it once (URL + grouped key)', async () => {
    const b = build();
    const r = await b.service.setup(caller(), { currentPassword: 'right' });
    expect(b.writes).toHaveLength(1);
    const stored = b.writes[0].totpPendingSecretEnc as string;
    const secret = decryptStrict(stored);
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(r.secretGrouped.replace(/ /g, '')).toBe(secret);
    expect(r.otpauthUrl).toContain(`secret=${secret}`);
    expect(decodeURIComponent(r.otpauthUrl)).toContain('a@b.co');
    // Never the active secret.
    expect(b.writes[0]).not.toHaveProperty('totpSecretEnc');
  });

  it('a Google-only account whose session started 11 min ago → 403 REAUTH_REQUIRED', async () => {
    const b = build({ password: null });
    b.sessions.createdAt.mockResolvedValue(new Date(Date.now() - 11 * MIN));
    expect(await codeOf(b.service.setup(caller(), {}))).toEqual({
      status: 403,
      code: 'REAUTH_REQUIRED',
    });
    expect(b.sessions.createdAt).toHaveBeenCalledWith(SID, USER_ID);
    expect(b.writes).toEqual([]);
  });

  it('a Google-only account with a 15-min-old token but a 9-min-old session passes (iat is not the sign-in time)', async () => {
    const b = build({ password: null });
    b.sessions.createdAt.mockResolvedValue(new Date(Date.now() - 9 * MIN));
    const result = await b.service.setup(
      { ...caller(), iat: Math.floor((Date.now() - 15 * MIN) / 1000) } as never,
      {},
    );
    expect(result.otpauthUrl).toMatch(/^otpauth:/);
    expect(REAUTH_WINDOW_MS).toBe(10 * MIN);
  });

  it('a Google-only account with no sid, or a session that is gone → 403 REAUTH_REQUIRED', async () => {
    const b = build({ password: null });
    expect((await codeOf(b.service.setup(caller(null), {}))).code).toBe(
      'REAUTH_REQUIRED',
    );
    b.sessions.createdAt.mockResolvedValue(null as never);
    expect((await codeOf(b.service.setup(caller(), {}))).code).toBe(
      'REAUTH_REQUIRED',
    );
  });

  it('when already on → 409 MFA_ALREADY_ENABLED', async () => {
    const b = build({ totpEnabledAt: new Date() });
    expect(
      await codeOf(b.service.setup(caller(), { currentPassword: 'right' })),
    ).toEqual({ status: 409, code: 'MFA_ALREADY_ENABLED' });
  });

  it('an unverified account → 403 EMAIL_NOT_VERIFIED, nothing stored (batch-2 ruling 2)', async () => {
    const b = build({ isEmailVerified: false });
    expect(
      await codeOf(b.service.setup(caller(), { currentPassword: 'right' })),
    ).toEqual({ status: 403, code: 'EMAIL_NOT_VERIFIED' });
    expect(b.writes).toEqual([]);
  });
});

describe('TwoFactorService.enable', () => {
  const PENDING = () => encryptTotpSecret('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP');

  it('with a wrong code → 400 MFA_CODE_INVALID: pending kept, nothing revoked, issuer not called, no cookie', async () => {
    const b = build({ totpPendingSecretEnc: PENDING() });
    b.secondFactor.check.mockRejectedValueOnce(mfaCodeInvalid());
    expect(
      await codeOf(b.service.enable(caller(), '000000', b.req, b.res as never)),
    ).toEqual({ status: 400, code: 'MFA_CODE_INVALID' });
    expect(b.db.transaction).not.toHaveBeenCalled();
    expect(b.writes).toEqual([]);
    expect(b.sessions.revokeOthers).not.toHaveBeenCalled();
    expect(b.issuer.issue).not.toHaveBeenCalled();
    expect(b.res.cookie).not.toHaveBeenCalled();
  });

  it('promotes, returns 10 codes, revokes other sessions, re-issues the same sid, emails', async () => {
    const pending = PENDING();
    const b = build({ totpPendingSecretEnc: pending });
    const r = await b.service.enable(caller(), '123456', b.req, b.res as never);

    expect(b.secondFactor.check).toHaveBeenCalledWith(
      USER_ID,
      { code: '123456' },
      { secret: 'pending' },
    );
    expect(b.writes[0]).toMatchObject({
      totpSecretEnc: pending,
      totpPendingSecretEnc: null,
    });
    expect(b.writes[0].totpEnabledAt).toBeInstanceOf(Date);
    expect(b.secondFactor.replaceBackupCodes).toHaveBeenCalledWith(
      USER_ID,
      b.tx,
    );
    expect(b.sessions.revokeOthers).toHaveBeenCalledWith(USER_ID, SID, b.tx);
    // All three inside the transaction, the re-issue after the commit.
    expect(b.order).toEqual([
      'tx:start',
      'replaceBackupCodes',
      'revokeOthers',
      'tx:commit',
      'issue',
    ]);
    expect(b.issuer.issue).toHaveBeenCalledWith(USER_ID, b.req, b.res, {
      via: 'two_factor_enable',
      sid: SID,
    });
    expect(r.backupCodes).toHaveLength(10);
    expect(r.accessToken).toBe('access');
    // The email's not_me_2fa link names the very enabledAt written (finding 1).
    expect(b.notices.enabled).toHaveBeenCalledWith(
      USER_ID,
      { ip: '203.0.113.9', userAgent: 'UA' },
      b.writes[0].totpEnabledAt,
    );
  });

  it('without setup → 400 MFA_SETUP_MISSING, the code is never checked', async () => {
    const b = build();
    expect(
      await codeOf(b.service.enable(caller(), '123456', b.req, b.res as never)),
    ).toEqual({ status: 400, code: 'MFA_SETUP_MISSING' });
    expect(b.secondFactor.check).not.toHaveBeenCalled();
  });

  it('a setup restarted in another tab since the check → 400 MFA_SETUP_MISSING, nothing re-issued', async () => {
    const b = build({ totpPendingSecretEnc: PENDING() }, { promote: false });
    expect(
      await codeOf(b.service.enable(caller(), '123456', b.req, b.res as never)),
    ).toEqual({ status: 400, code: 'MFA_SETUP_MISSING' });
    expect(b.secondFactor.replaceBackupCodes).not.toHaveBeenCalled();
    expect(b.issuer.issue).not.toHaveBeenCalled();
  });

  it('already on → 409 MFA_ALREADY_ENABLED', async () => {
    const b = build({
      totpEnabledAt: new Date(),
      totpPendingSecretEnc: PENDING(),
    });
    expect(
      (
        await codeOf(
          b.service.enable(caller(), '123456', b.req, b.res as never),
        )
      ).code,
    ).toBe('MFA_ALREADY_ENABLED');
  });

  it('a sid-less caller → 403 REAUTH_REQUIRED before anything is checked (ruling)', async () => {
    const b = build({ totpPendingSecretEnc: PENDING() });
    expect(
      await codeOf(
        b.service.enable(caller(null), '123456', b.req, b.res as never),
      ),
    ).toEqual({ status: 403, code: 'REAUTH_REQUIRED' });
    expect(b.secondFactor.check).not.toHaveBeenCalled();
  });
});

describe('TwoFactorService.regenerate', () => {
  it('checks the code, then replaces all codes and emails', async () => {
    const b = build({ totpEnabledAt: new Date() });
    const r = await b.service.regenerate(caller(), { code: '123456' }, b.req);
    expect(b.secondFactor.check).toHaveBeenCalledWith(USER_ID, {
      code: '123456',
      backupCode: undefined,
    });
    expect(b.secondFactor.check.mock.invocationCallOrder[0]).toBeLessThan(
      b.secondFactor.replaceBackupCodes.mock.invocationCallOrder[0],
    );
    expect(r.backupCodes).toHaveLength(10);
    expect(b.notices.regenerated).toHaveBeenCalled();
  });

  it('accepts {backupCode} and spends that code; {code, backupCode} together → 400 MFA_CODE_REQUIRED', async () => {
    const b = build({ totpEnabledAt: new Date() });
    await b.service.regenerate(caller(), { backupCode: 'abcd-efgh' }, b.req);
    expect(b.secondFactor.check).toHaveBeenCalledWith(USER_ID, {
      code: undefined,
      backupCode: 'abcd-efgh',
    });
    b.secondFactor.replaceBackupCodes.mockClear();
    expect(
      await codeOf(
        b.service.regenerate(
          caller(),
          { code: '123456', backupCode: 'abcd-efgh' },
          b.req,
        ),
      ),
    ).toEqual({ status: 400, code: 'MFA_CODE_REQUIRED' });
    expect(b.secondFactor.replaceBackupCodes).not.toHaveBeenCalled();
  });

  it('a wrong code replaces nothing', async () => {
    const b = build({ totpEnabledAt: new Date() });
    b.secondFactor.check.mockRejectedValueOnce(mfaCodeInvalid());
    expect(
      (await codeOf(b.service.regenerate(caller(), { code: '000000' }, b.req)))
        .code,
    ).toBe('MFA_CODE_INVALID');
    expect(b.secondFactor.replaceBackupCodes).not.toHaveBeenCalled();
  });
});

describe('TwoFactorService.disable', () => {
  it('clears secret, codes and trust and revokes other sessions, in one transaction; emails "you"', async () => {
    const b = build({ totpEnabledAt: new Date() });
    await b.service.disable(
      caller(),
      { code: '123456', currentPassword: 'right' },
      b.req,
    );
    // The password never reaches the second-factor check.
    expect(b.secondFactor.check).toHaveBeenCalledWith(USER_ID, {
      code: '123456',
      backupCode: undefined,
    });
    expect(b.secondFactor.clear).toHaveBeenCalledWith(USER_ID, b.tx);
    expect(b.sessions.revokeOthers).toHaveBeenCalledWith(USER_ID, SID, b.tx);
    expect(b.order).toEqual(['tx:start', 'clear', 'revokeOthers', 'tx:commit']);
    expect(b.notices.disabled).toHaveBeenCalledWith(
      USER_ID,
      { ip: '203.0.113.9', userAgent: 'UA' },
      'you',
    );
  });

  it('a wrong password → 400 WRONG_PASSWORD before any second-factor attempt is spent', async () => {
    const b = build({ totpEnabledAt: new Date() });
    expect(
      await codeOf(
        b.service.disable(
          caller(),
          { code: '123456', currentPassword: 'wrong' },
          b.req,
        ),
      ),
    ).toEqual({ status: 400, code: 'WRONG_PASSWORD' });
    expect(b.secondFactor.check).not.toHaveBeenCalled();
    expect(b.secondFactor.clear).not.toHaveBeenCalled();
  });

  it('a Google-only account needs no password, only the code', async () => {
    const b = build({ totpEnabledAt: new Date(), password: null });
    await b.service.disable(caller(), { backupCode: 'ABCD-EFGH' }, b.req);
    expect(compare).not.toHaveBeenCalled();
    expect(b.secondFactor.clear).toHaveBeenCalled();
  });

  it('a wrong code clears nothing', async () => {
    const b = build({ totpEnabledAt: new Date() });
    b.secondFactor.check.mockRejectedValueOnce(mfaCodeInvalid());
    await codeOf(
      b.service.disable(
        caller(),
        { code: '000000', currentPassword: 'right' },
        b.req,
      ),
    );
    expect(b.secondFactor.clear).not.toHaveBeenCalled();
    expect(b.sessions.revokeOthers).not.toHaveBeenCalled();
  });
});

describe('off → MFA_NOT_ENABLED', () => {
  it('disable and regenerate when off → 409 MFA_NOT_ENABLED', async () => {
    const b = build();
    expect(
      await codeOf(
        b.service.disable(
          caller(),
          { code: '123456', currentPassword: 'right' },
          b.req,
        ),
      ),
    ).toEqual({ status: 409, code: 'MFA_NOT_ENABLED' });
    expect(
      await codeOf(b.service.regenerate(caller(), { code: '123456' }, b.req)),
    ).toEqual({ status: 409, code: 'MFA_NOT_ENABLED' });
    expect(b.secondFactor.check).not.toHaveBeenCalled();
  });
});

describe('TwoFactorService.status', () => {
  it('answers {enabled, enabledAt (ISO), backupCodesRemaining}', async () => {
    const at = new Date('2026-11-20T10:00:00Z');
    const b = build({ totpEnabledAt: at });
    await expect(b.service.status(USER_ID)).resolves.toEqual({
      enabled: true,
      enabledAt: '2026-11-20T10:00:00.000Z',
      backupCodesRemaining: 7,
    });
    const off = build();
    await expect(off.service.status(USER_ID)).resolves.toMatchObject({
      enabled: false,
      enabledAt: null,
    });
  });
});
