import { Logger } from '@nestjs/common';
import { TwoFactorNotices } from './two-factor-notices.service';

const CTX = {
  ip: '203.0.113.7',
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
};

interface Call {
  userId: string;
  event: string;
  email: {
    template: { id: string };
    props: Record<string, unknown>;
    idempotencyKey: string;
  };
}

function build(over: { notifyError?: Error; geoError?: Error } = {}) {
  const notify = {
    notify: over.notifyError
      ? jest.fn().mockRejectedValue(over.notifyError)
      : jest.fn().mockResolvedValue(undefined),
  };
  const recipients = { userTimezone: jest.fn().mockResolvedValue('UTC') };
  const tokens = { securityToken: jest.fn().mockReturnValue('tok') };
  const links = { api: (p: string) => `https://api.test${p}` };
  const geoip = {
    lookup: over.geoError
      ? jest.fn().mockRejectedValue(over.geoError)
      : jest.fn().mockResolvedValue({ country: 'Pakistan' }),
  };
  const notices = new TwoFactorNotices(
    notify as never,
    recipients as never,
    tokens as never,
    links as never,
    geoip as never,
  );
  const call = (i = 0) => (notify.notify.mock.calls as Call[][])[i][0];
  return { notices, notify, tokens, call };
}

describe('TwoFactorNotices', () => {
  beforeEach(() =>
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined),
  );
  afterEach(() => jest.restoreAllMocks());

  it('failed() twice with one cid uses the same idempotency key (one email per challenge)', async () => {
    const { notices, call } = build();
    await notices.failed('u1', CTX, 'cid-1');
    await notices.failed('u1', CTX, 'cid-1');
    expect(call(0).email.idempotencyKey).toBe('two-step-failed.cid-1');
    expect(call(1).email.idempotencyKey).toBe('two-step-failed.cid-1');
    expect(call(0).email.template.id).toBe('two-step-failed');
  });

  it('disabledBySupport(): two-step-disabled by support, naming support as the device, no location', async () => {
    const { notices, call } = build();
    await notices.disabledBySupport('u1');
    const c = call();
    expect(c.userId).toBe('u1');
    expect(c.event).toBe('security_alert');
    expect(c.email.template.id).toBe('two-step-disabled');
    expect(c.email.props).toMatchObject({
      by: 'support',
      device: 'Schedura support',
      location: null,
      notMeUrl: 'https://api.test/email/security/tok',
    });
    expect(c.email.idempotencyKey).toMatch(/^two-step-disabled\.u1\.\d+$/);
  });

  it('builds the shared props: time, device, country and the not-me link', async () => {
    const { notices, tokens, call } = build();
    await notices.regenerated('u1', CTX);
    const c = call();
    expect(c.userId).toBe('u1');
    expect(c.event).toBe('security_alert');
    expect(c.email.template.id).toBe('backup-codes-regenerated');
    expect(c.email.props).toMatchObject({
      device: 'Chrome on Windows',
      location: 'Pakistan',
      notMeUrl: 'https://api.test/email/security/tok',
    });
    expect(String(c.email.props.when)).toMatch(/\d{4} at /);
    expect(tokens.securityToken).toHaveBeenCalledWith({
      uid: 'u1',
      act: 'not_me',
    });
  });

  it('enabled(): its not-me link is not_me_2fa naming the enable to the millisecond (finding 1)', async () => {
    const { notices, tokens, call } = build();
    const enabledAt = new Date(Date.UTC(2026, 10, 21, 9, 30, 15, 123));
    await notices.enabled('u1', CTX, enabledAt);
    expect(call().email.template.id).toBe('two-step-enabled');
    expect(call().email.props).toMatchObject({
      notMeUrl: 'https://api.test/email/security/tok',
    });
    expect(tokens.securityToken).toHaveBeenCalledWith({
      uid: 'u1',
      act: 'not_me_2fa',
      enabledAt: enabledAt.getTime(),
    });
  });

  it('every other notice keeps the plain not_me link', async () => {
    const { notices, tokens } = build();
    await notices.disabled('u1', CTX, 'you');
    await notices.disabledBySupport('u1');
    await notices.backupCodeUsed('u1', CTX, 3);
    await notices.failed('u1', CTX, 'c');
    await notices.regenerated('u1', CTX);
    for (const [claims] of tokens.securityToken.mock.calls as [unknown][]) {
      expect(claims).toEqual({ uid: 'u1', act: 'not_me' });
    }
    expect(tokens.securityToken).toHaveBeenCalledTimes(5);
  });

  it.each([
    [
      'disabled',
      (n: TwoFactorNotices) => n.disabled('u1', CTX, 'support'),
      'two-step-disabled',
      { by: 'support' },
    ],
    [
      'backupCodeUsed',
      (n: TwoFactorNotices) => n.backupCodeUsed('u1', CTX, 2),
      'backup-code-used',
      { remaining: 2 },
    ],
    [
      'regenerated',
      (n: TwoFactorNotices) => n.regenerated('u1', CTX),
      'backup-codes-regenerated',
      {},
    ],
  ] as const)(
    '%s sends its template with its own props',
    async (_n, run, id, extra) => {
      const { notices, call } = build();
      await run(notices);
      expect(call().email.template.id).toBe(id);
      expect(call().email.props).toMatchObject(extra);
      expect(call().email.idempotencyKey).toMatch(
        new RegExp(`^${id}\\.u1\\.\\d+$`),
      );
    },
  );

  it('a throwing notify does not reject', async () => {
    const { notices } = build({ notifyError: new Error('outbox down') });
    await expect(notices.failed('u1', CTX, 'c')).resolves.toBeUndefined();
    await expect(
      notices.enabled('u1', CTX, new Date()),
    ).resolves.toBeUndefined();
  });

  it('a throwing GeoIP lookup does not reject either', async () => {
    const { notices, notify } = build({ geoError: new Error('ip-api down') });
    await expect(notices.regenerated('u1', CTX)).resolves.toBeUndefined();
    expect(notify.notify).not.toHaveBeenCalled();
  });
});
