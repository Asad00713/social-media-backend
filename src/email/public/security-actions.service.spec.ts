import type { AuthService } from '../../auth/auth.service';
import type { SecondFactorService } from '../../auth/two-factor/second-factor.service';
import type { AccountSecurityService } from '../../users/account-security.service';
import { AppLinks } from '../links/app-links';
import type {
  EmailTokensService,
  SecurityClaims,
} from '../tokens/email-tokens.service';
import { maskEmail, SecurityActionsService } from './security-actions.service';

const UID = '11111111-1111-4111-8111-111111111111';
const OLD = 'rehman@lumierecafe.pk';
const NEW = 'rehman@lumiere.cafe';

interface Row {
  id: string;
  email: string;
  [column: string]: unknown;
}

/**
 * One users row plus "is this address taken by someone else". Writes are
 * recorded and applied. `select…for('update')` reads the row; `select…limit(1)`
 * is the taken check. The transaction runs its callback on the same object.
 */
function fakeDb(
  row: Row | null,
  opts: {
    taken?: boolean;
    holder?: Holder;
    holderHasData?: boolean;
    uniqueViolation?: boolean;
    refs?: { tbl: string; col: string }[];
  } = {},
) {
  // `taken` is someone's real account: verified, older than the link.
  const holder: Holder | null =
    opts.holder ??
    (opts.taken
      ? { id: 'someone-else', isEmailVerified: true, createdAfterLink: false }
      : null);
  const writes: Record<string, unknown>[] = [];
  const deleted: string[] = [];
  const select = jest.fn(() => {
    const b = {
      from: () => b,
      where: () => b,
      for: () =>
        Promise.resolve(
          row
            ? [{ email: row.email, pendingEmail: row.pendingEmail ?? null }]
            : [],
        ),
      limit: () => ({
        for: () => Promise.resolve(holder ? [holder] : []),
      }),
    };
    return b;
  });
  const update = jest.fn(() => ({
    set: (values: Record<string, unknown>) => ({
      where: () => {
        if (opts.uniqueViolation && 'email' in values) {
          return Promise.reject(
            Object.assign(new Error('Failed query'), {
              cause: { code: '23505' },
            }),
          );
        }
        writes.push(values);
        if (row) Object.assign(row, values);
        return Promise.resolve(undefined);
      },
    }),
  }));
  const db = {
    query: {
      users: {
        findFirst: jest.fn(() =>
          Promise.resolve(row ? { id: row.id, email: row.email } : undefined),
        ),
      },
    },
    select,
    update,
    delete: jest.fn(() => ({
      where: () => {
        deleted.push(holder?.id ?? '');
        return Promise.resolve(undefined);
      },
    })),
    // holdsNothing: the catalogue lists one referencing table, then the probe
    // finds a row only when the holder has data.
    execute: jest
      .fn()
      .mockResolvedValueOnce({
        rows: opts.refs ?? [{ tbl: 'workspace', col: 'owner_id' }],
      })
      .mockResolvedValueOnce({
        rows: opts.holderHasData ? [{ '?column?': 1 }] : [],
      }),
    transaction: jest.fn(),
  };
  db.transaction.mockImplementation((fn: (tx: typeof db) => Promise<unknown>) =>
    fn(db),
  );
  return { db, writes, update, deleted };
}

interface Holder {
  id: string;
  isEmailVerified: boolean;
  createdAfterLink: boolean;
}

function setup(
  claims: SecurityClaims | null,
  row: Row | null,
  opts: {
    taken?: boolean;
    holder?: Holder;
    holderHasData?: boolean;
    uniqueViolation?: boolean;
    resetSent?: boolean;
    refs?: { tbl: string; col: string }[];
    cleared?: boolean;
  } = {},
) {
  const { db, writes, update, deleted } = fakeDb(row, opts);
  const tokens = { verifySecurity: jest.fn(() => claims) };
  const security = { revokeSessions: jest.fn().mockResolvedValue(undefined) };
  const auth = {
    issuePasswordReset: jest.fn().mockResolvedValue(opts.resetSent ?? true),
  };
  const links = new AppLinks({
    get: (key: string) =>
      key === 'SUPPORT_EMAIL' ? 'help@schedura.test' : undefined,
  } as never);
  // The conditional 2FA clear itself is proven on a real database
  // (not-me-two-factor.db.spec.ts); here only who asks for it.
  const secondFactor = {
    clearIfEnabledAt: jest.fn().mockResolvedValue(opts.cleared ?? false),
  };
  const service = new SecurityActionsService(
    db as never,
    tokens as unknown as EmailTokensService,
    security as unknown as AccountSecurityService,
    auth as unknown as AuthService,
    links,
    secondFactor as unknown as SecondFactorService,
  );
  return {
    service,
    db,
    writes,
    update,
    deleted,
    security,
    auth,
    tokens,
    secondFactor,
  };
}

const NOT_ME: SecurityClaims = { uid: UID, act: 'not_me' };
const REVERT: SecurityClaims = {
  uid: UID,
  act: 'revert_email',
  from: OLD,
  to: NEW,
};

describe('maskEmail', () => {
  it('keeps the first character and the domain', () => {
    expect(maskEmail(OLD)).toBe('r•••@lumierecafe.pk');
  });

  it('never shows more of an odd address', () => {
    expect(maskEmail('@x.com')).toBe('•••');
    expect(maskEmail('nobody')).toBe('•••');
  });
});

describe('SecurityActionsService.describe (GET)', () => {
  it('GET security link changes nothing; POST not_me revokes sessions and sends A2', async () => {
    const row = { id: UID, email: NEW };
    const { service, update, security, auth } = setup(NOT_ME, row);

    // GET: the confirm page, and not a single write.
    await expect(service.describe('tok')).resolves.toEqual({
      title: 'Secure your account?',
      body: "We'll sign you out everywhere and send a password reset link to r•••@lumiere.cafe.",
      button: 'Secure my account',
    });
    expect(update).not.toHaveBeenCalled();
    expect(security.revokeSessions).not.toHaveBeenCalled();
    expect(auth.issuePasswordReset).not.toHaveBeenCalled();

    // POST: signs out everywhere, then a reset link to the account's address.
    await expect(service.perform('tok')).resolves.toEqual({
      title: 'Your account is secured',
      body: 'We signed you out everywhere and sent a reset link to r•••@lumiere.cafe.',
    });
    expect(security.revokeSessions).toHaveBeenCalledWith(UID);
    expect(auth.issuePasswordReset).toHaveBeenCalledWith({
      id: UID,
      email: NEW,
    });
  });

  it('POST not_me never touches two-step sign-in', async () => {
    const { service, secondFactor } = setup(NOT_ME, { id: UID, email: NEW });
    await service.perform('tok');
    expect(secondFactor.clearIfEnabledAt).not.toHaveBeenCalled();
  });

  it('POST not_me_2fa asks for the clear of exactly the enable it names, then secures like not_me', async () => {
    const at = Date.UTC(2026, 10, 21, 9, 30, 15, 123);
    const { service, secondFactor, security, auth } = setup(
      { uid: UID, act: 'not_me_2fa', enabledAt: at },
      { id: UID, email: NEW },
      { cleared: true },
    );
    await expect(service.perform('tok')).resolves.toEqual({
      title: 'Your account is secured',
      body: 'We turned off two-step sign-in, signed you out everywhere and sent a reset link to r•••@lumiere.cafe.',
    });
    expect(secondFactor.clearIfEnabledAt).toHaveBeenCalledWith(
      UID,
      new Date(at),
      expect.anything(),
    );
    expect(security.revokeSessions).toHaveBeenCalledWith(UID);
    expect(auth.issuePasswordReset).toHaveBeenCalledWith({
      id: UID,
      email: NEW,
    });
  });

  it('POST not_me_2fa whose enable is gone secures and says nothing about two-step', async () => {
    const { service, security } = setup(
      { uid: UID, act: 'not_me_2fa', enabledAt: 1 },
      { id: UID, email: NEW },
      { cleared: false },
    );
    await expect(service.perform('tok')).resolves.toEqual({
      title: 'Your account is secured',
      body: 'We signed you out everywhere and sent a reset link to r•••@lumiere.cafe.',
    });
    expect(security.revokeSessions).toHaveBeenCalledWith(UID);
  });

  it('a revert link asks before switching back, naming the old address', async () => {
    const { service, update } = setup(REVERT, { id: UID, email: NEW });

    await expect(service.describe('tok')).resolves.toEqual({
      title: 'Switch your email back?',
      body: `Your sign-in email will go back to ${OLD}, we'll sign you out everywhere, and we'll send a reset link there.`,
      button: 'Secure my account',
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('a bad, expired or tampered token, or a deleted account, is null', async () => {
    await expect(
      setup(null, { id: UID, email: NEW }).service.describe('x'),
    ).resolves.toBeNull();
    await expect(setup(NOT_ME, null).service.describe('x')).resolves.toBeNull();
    // A revert claim without its addresses cannot be acted on.
    await expect(
      setup(
        { uid: UID, act: 'revert_email' },
        { id: UID, email: NEW },
      ).service.describe('x'),
    ).resolves.toBeNull();
  });
});

describe('SecurityActionsService.perform (POST)', () => {
  it('not_me also cancels an email change still waiting for its code', async () => {
    const row = { id: UID, email: NEW, pendingEmail: 'attacker@evil.test' };
    const { service } = setup(NOT_ME, row);

    await service.perform('tok');

    expect(row).toMatchObject({
      pendingEmail: null,
      pendingEmailCodeHash: null,
      pendingEmailExpiresAt: null,
      pendingEmailAttempts: 0,
    });
  });

  it('not_me works for any link that names only the account (A5, A6)', async () => {
    const { service, security } = setup(
      { uid: UID, act: 'not_me' },
      { id: UID, email: OLD },
    );

    const done = await service.perform('tok');

    expect(done?.title).toBe('Your account is secured');
    expect(security.revokeSessions).toHaveBeenCalledTimes(1);
  });

  it('says so when the reset link could not be sent, after still signing out everywhere', async () => {
    const { service, security } = setup(
      NOT_ME,
      { id: UID, email: NEW },
      { resetSent: false },
    );

    const done = await service.perform('tok');

    expect(security.revokeSessions).toHaveBeenCalledWith(UID);
    expect(done).toEqual({
      title: 'Your account is secured',
      body: 'We signed you out everywhere, but we couldn\'t send the reset link. Choose a new password with "Forgot password" on the sign-in page.',
    });
  });

  it('is null for a bad token or a deleted account, and writes nothing', async () => {
    const bad = setup(null, { id: UID, email: NEW });
    await expect(bad.service.perform('x')).resolves.toBeNull();
    expect(bad.update).not.toHaveBeenCalled();

    const gone = setup(NOT_ME, null);
    await expect(gone.service.perform('x')).resolves.toBeNull();
    expect(gone.security.revokeSessions).not.toHaveBeenCalled();

    const goneRevert = setup(REVERT, null);
    await expect(goneRevert.service.perform('x')).resolves.toBeNull();
    expect(goneRevert.security.revokeSessions).not.toHaveBeenCalled();
  });

  it('revert_email switches the email back, verified, then secures the account at the old address', async () => {
    const row: Row = { id: UID, email: NEW };
    const { service, security, auth } = setup(REVERT, row);

    const done = await service.perform('tok');

    expect(row).toMatchObject({ email: OLD, isEmailVerified: true });
    // The revert starts a new 7-day lock on email changes.
    expect(row.emailChangedAt).toBeInstanceOf(Date);
    expect(security.revokeSessions).toHaveBeenCalledWith(UID);
    expect(auth.issuePasswordReset).toHaveBeenCalledWith({
      id: UID,
      email: OLD,
    });
    expect(done).toEqual({
      title: 'Your account is secured',
      body: `Your sign-in email is ${OLD} again. We signed you out everywhere and sent a reset link there.`,
    });
  });

  it('chained change (victim → a1 → a2): the victim’s link refuses but still signs out everywhere and cancels a pending change', async () => {
    // The link was minted for victim → a1; the attacker has moved on to a2.
    const row: Row = {
      id: UID,
      email: 'a2@evil.test',
      pendingEmail: 'a3@evil.test',
    };
    const chained: SecurityClaims = {
      uid: UID,
      act: 'revert_email',
      from: OLD,
      to: 'a1@evil.test',
    };
    const { service, writes, security, auth } = setup(chained, row);

    const done = await service.perform('tok');

    // The page copy is unchanged.
    expect(done).toEqual({
      title: "Your email wasn't switched back",
      body: "We couldn't switch your email back. Write to help@schedura.test and we'll help.",
    });
    expect(security.revokeSessions).toHaveBeenCalledWith(UID);
    expect(row).toMatchObject({
      email: 'a2@evil.test',
      pendingEmail: null,
      pendingEmailCodeHash: null,
      pendingEmailExpiresAt: null,
      pendingEmailAttempts: 0,
    });
    expect(writes.some((w) => 'email' in w)).toBe(false);
    // A reset link would go to the attacker's address.
    expect(auth.issuePasswordReset).not.toHaveBeenCalled();
  });

  it('refuses when another real account holds the old address, but still signs out and cancels a pending change', async () => {
    const row: Row = { id: UID, email: NEW, pendingEmail: 'x@evil.test' };
    const { service, writes, security, auth, deleted } = setup(REVERT, row, {
      taken: true,
    });

    const done = await service.perform('tok');

    expect(done?.title).toBe("Your email wasn't switched back");
    expect(writes.some((w) => 'email' in w)).toBe(false);
    expect(row.pendingEmail).toBeNull();
    expect(security.revokeSessions).toHaveBeenCalledWith(UID);
    expect(auth.issuePasswordReset).not.toHaveBeenCalled();
    expect(deleted).toEqual([]);
  });

  it('a unique violation at the write (the old address registered meanwhile) refuses, not a 500, and signs out', async () => {
    const row = { id: UID, email: NEW };
    const { service, security } = setup(REVERT, row, { uniqueViolation: true });

    const done = await service.perform('tok');

    expect(done?.title).toBe("Your email wasn't switched back");
    expect(row.email).toBe(NEW);
    expect(security.revokeSessions).toHaveBeenCalledWith(UID);
  });

  it('a squatter (unverified, registered after the link, holding nothing) is removed and the revert goes through', async () => {
    const row = { id: UID, email: NEW };
    const { service, security, auth, deleted } = setup(REVERT, row, {
      holder: {
        id: 'squatter',
        isEmailVerified: false,
        createdAfterLink: true,
      },
    });

    const done = await service.perform('tok');

    expect(deleted).toEqual(['squatter']);
    expect(row.email).toBe(OLD);
    expect(done?.title).toBe('Your account is secured');
    expect(security.revokeSessions).toHaveBeenCalledWith(UID);
    expect(auth.issuePasswordReset).toHaveBeenCalledWith({
      id: UID,
      email: OLD,
    });
  });

  it('a squatter who only signed in (sessions + challenges) still holds nothing', async () => {
    const row = { id: UID, email: NEW };
    // Every row the squatter has is a sign-in trace. If any of these tables
    // were probed, the probe would answer "has data" and refuse.
    const { service, db, deleted } = setup(REVERT, row, {
      holder: {
        id: 'squatter',
        isEmailVerified: false,
        createdAfterLink: true,
      },
      holderHasData: true,
      refs: [
        { tbl: 'known_devices', col: 'user_id' },
        { tbl: 'user_sessions', col: 'user_id' },
        { tbl: 'login_challenges', col: 'user_id' },
      ],
    });

    const done = await service.perform('tok');

    expect(deleted).toEqual(['squatter']);
    expect(row.email).toBe(OLD);
    expect(done?.title).toBe('Your account is secured');
    // The catalogue read only: no probe ran.
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['verified', { isEmailVerified: true, createdAfterLink: true }, false],
    [
      'created before the link',
      { isEmailVerified: false, createdAfterLink: false },
      false,
    ],
    ['holding data', { isEmailVerified: false, createdAfterLink: true }, true],
  ])(
    'a holder that is %s blocks the revert: refused, signed out, never deleted',
    async (_label, flags, holderHasData) => {
      const row = { id: UID, email: NEW };
      const { service, security, deleted } = setup(REVERT, row, {
        holder: { id: 'holder', ...flags },
        holderHasData,
      });

      const done = await service.perform('tok');

      expect(done?.title).toBe("Your email wasn't switched back");
      expect(row.email).toBe(NEW);
      expect(deleted).toEqual([]);
      expect(security.revokeSessions).toHaveBeenCalledWith(UID);
    },
  );

  it('a second POST of a used revert link says it is already done: no sign-out, no reset email, no write', async () => {
    const row = { id: UID, email: NEW };
    const { service, writes, security, auth } = setup(REVERT, row);

    await service.perform('tok');
    expect(security.revokeSessions).toHaveBeenCalledTimes(1);
    expect(auth.issuePasswordReset).toHaveBeenCalledTimes(1);
    writes.length = 0;

    const again = await service.perform('tok');

    expect(again).toEqual({
      title: 'This is already done',
      body: 'Your sign-in email is already back to r•••@lumierecafe.pk.',
    });
    expect(writes).toEqual([]);
    expect(row.email).toBe(OLD);
    expect(security.revokeSessions).toHaveBeenCalledTimes(1);
    expect(auth.issuePasswordReset).toHaveBeenCalledTimes(1);
  });

  it('back at the old address but with a new change pending since: secures again, which cancels it', async () => {
    const row: Row = {
      id: UID,
      email: OLD,
      pendingEmail: 'attacker@evil.test',
    };
    const { service, writes, security, auth } = setup(REVERT, row);

    const done = await service.perform('tok');

    expect(done?.title).toBe('Your account is secured');
    expect(writes.some((w) => 'email' in w)).toBe(false);
    expect(row.pendingEmail).toBeNull();
    expect(security.revokeSessions).toHaveBeenCalledWith(UID);
    expect(auth.issuePasswordReset).toHaveBeenCalledWith({
      id: UID,
      email: OLD,
    });
  });

  it('compares addresses case-insensitively (older rows were stored as typed)', async () => {
    const row = { id: UID, email: 'Rehman@Lumiere.Cafe' };
    const { service } = setup(REVERT, row);

    await service.perform('tok');

    expect(row.email).toBe(OLD);
  });
});
