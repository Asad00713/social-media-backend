import { createHash } from 'crypto';
import { Logger } from '@nestjs/common';
import type { EmailOutboxService } from '../../email/queue/email-outbox.service';
import { renderEmail } from '../../email/render/render-email';
import { NEW_SIGN_IN } from '../../email/templates/security/new-sign-in';
import type { RenderContext } from '../../email/templates/types';
import type { NotificationPreferencesService } from '../../notification-preferences/notification-preferences.service';
import { NotifyService } from '../../notifications/notify.service';
import type { RecipientsService } from '../../notifications/recipients.service';
import { deviceLabel, KnownDevicesService } from './known-devices.service';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const DEVICE_ID = 'D'.repeat(43);
const HASH = createHash('sha256').update(DEVICE_ID).digest('hex');
const CHROME_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const CTX = { ip: '39.48.12.201', userAgent: CHROME_WINDOWS };

type Chain = Record<string, jest.Mock> & PromiseLike<unknown>;

/** A drizzle query-builder stand-in: every step chains, the end resolves. */
function chain(result: unknown): Chain {
  const c = {} as Chain;
  for (const step of [
    'set',
    'where',
    'from',
    'limit',
    'values',
    'onConflictDoNothing',
  ]) {
    c[step] = jest.fn(() => c);
  }
  c.returning = jest.fn(() => Promise.resolve(result));
  (c as { then: PromiseLike<unknown>['then'] }).then = (ok, fail) =>
    Promise.resolve(result).then(ok, fail);
  return c;
}

interface SetupOpts {
  /** The device's row already exists (the UPDATE touches it). */
  known?: boolean;
  /** The person already has some other device. */
  hasOther?: boolean;
  /** A parallel request inserted the same device first. */
  lostRace?: boolean;
  country?: string | null;
}

function setup(opts: SetupOpts = {}) {
  const updated = chain(opts.known ? [{ userId: USER_ID }] : []);
  const selected = chain(opts.hasOther ? [{ userId: USER_ID }] : []);
  const inserted = chain(opts.lostRace ? [] : [{ userId: USER_ID }]);
  const db = {
    update: jest.fn(() => updated),
    select: jest.fn(() => selected),
    insert: jest.fn(() => inserted),
  };
  const geoip = {
    lookup: jest
      .fn()
      .mockResolvedValue(
        opts.country === null
          ? null
          : { country: opts.country ?? 'Pakistan', countryCode: 'PK' },
      ),
  };
  const enqueue = jest
    .fn<Promise<void>, [unknown]>()
    .mockResolvedValue(undefined);
  const recipients = {
    user: jest.fn().mockResolvedValue({
      id: USER_ID,
      email: 'sana@example.test',
      name: 'Sana',
    }),
    userTimezone: jest.fn().mockResolvedValue('Asia/Karachi'),
  };
  const notify = new NotifyService(
    {
      shouldSend: jest.fn().mockResolvedValue(true),
    } as unknown as NotificationPreferencesService,
    { enqueue } as unknown as EmailOutboxService,
    recipients as unknown as RecipientsService,
  );
  const emitter = { newLogin: jest.fn().mockResolvedValue(undefined) };
  const tokens = { securityToken: jest.fn().mockReturnValue('SEC.TOKEN') };
  const links = { api: (path: string) => `https://api.test${path}` };
  const service = new KnownDevicesService(
    db as never,
    geoip as never,
    notify,
    recipients as never,
    emitter as never,
    tokens as never,
    links as never,
  );
  return {
    service,
    db,
    updated,
    inserted,
    geoip,
    enqueue,
    emitter,
    tokens,
    recipients,
  };
}

describe('KnownDevicesService.seen', () => {
  beforeEach(() => {
    // Only Date is faked: no timer or tick is held, so nothing can keep the
    // worker alive.
    jest.useFakeTimers({
      now: new Date('2026-10-26T16:58:00Z'),
      doNotFake: [
        'hrtime',
        'nextTick',
        'performance',
        'queueMicrotask',
        'requestAnimationFrame',
        'cancelAnimationFrame',
        'requestIdleCallback',
        'cancelIdleCallback',
        'setImmediate',
        'clearImmediate',
        'setInterval',
        'clearInterval',
        'setTimeout',
        'clearTimeout',
      ],
    });
  });
  afterEach(() => jest.useRealTimers());

  it('first device for a user is recorded silently (no email)', async () => {
    const s = setup();
    await expect(s.service.seen(USER_ID, DEVICE_ID, CTX)).resolves.toBe(
      'first',
    );
    expect(s.db.insert).toHaveBeenCalledTimes(1);
    expect(s.inserted.values).toHaveBeenCalledWith({
      userId: USER_ID,
      deviceHash: HASH,
      label: 'Chrome on Windows',
      country: 'Pakistan',
    });
    expect(s.inserted.onConflictDoNothing).toHaveBeenCalled();
    expect(s.enqueue).not.toHaveBeenCalled();
    expect(s.emitter.newLogin).not.toHaveBeenCalled();
  });

  it('unknown device for a user with a known device sends A6 and rings newLogin', async () => {
    const s = setup({ hasOther: true });
    await expect(s.service.seen(USER_ID, DEVICE_ID, CTX)).resolves.toBe('new');

    expect(s.tokens.securityToken).toHaveBeenCalledWith({
      uid: USER_ID,
      act: 'not_me',
    });
    expect(s.enqueue).toHaveBeenCalledTimes(1);
    expect(s.enqueue).toHaveBeenCalledWith({
      template: NEW_SIGN_IN,
      props: {
        when: 'Oct 26, 2026 at 9:58 PM GMT+5',
        device: 'Chrome on Windows',
        location: 'Pakistan',
        ip: '39.48.12.201',
        notMeUrl: 'https://api.test/email/security/SEC.TOKEN',
      },
      idempotencyKey: `new-sign-in.${USER_ID}.${HASH.slice(0, 16)}`,
      to: { email: 'sana@example.test', userId: USER_ID },
      workspaceId: null,
    });
    expect(s.emitter.newLogin).toHaveBeenCalledWith(
      USER_ID,
      'Chrome on Windows',
      'Pakistan',
    );
  });

  it('known device updates last_seen_at and sends nothing', async () => {
    const s = setup({ known: true, hasOther: true });
    await expect(s.service.seen(USER_ID, DEVICE_ID, CTX)).resolves.toBe(
      'known',
    );
    expect(s.updated.set).toHaveBeenCalledWith({
      lastSeenAt: new Date('2026-10-26T16:58:00Z'),
    });
    expect(s.db.insert).not.toHaveBeenCalled();
    expect(s.geoip.lookup).not.toHaveBeenCalled();
    expect(s.enqueue).not.toHaveBeenCalled();
    expect(s.emitter.newLogin).not.toHaveBeenCalled();
  });

  it('silent (register, Google create) records without an email even with other devices', async () => {
    const s = setup({ hasOther: true });
    await expect(
      s.service.seen(USER_ID, DEVICE_ID, CTX, { silent: true }),
    ).resolves.toBe('first');
    expect(s.db.insert).toHaveBeenCalledTimes(1);
    expect(s.enqueue).not.toHaveBeenCalled();
    expect(s.emitter.newLogin).not.toHaveBeenCalled();
  });

  it('a parallel sign-in that inserted the device first leaves this one silent', async () => {
    const s = setup({ hasOther: true, lostRace: true });
    await expect(s.service.seen(USER_ID, DEVICE_ID, CTX)).resolves.toBe(
      'known',
    );
    expect(s.enqueue).not.toHaveBeenCalled();
  });

  it('keeps the first address of a proxy list and unmaps IPv4-in-IPv6', async () => {
    const s = setup({ hasOther: true });
    await s.service.seen(USER_ID, DEVICE_ID, {
      ip: '::ffff:39.48.12.201, 10.0.0.1',
      userAgent: CHROME_WINDOWS,
    });
    expect(s.geoip.lookup).toHaveBeenCalledWith('39.48.12.201');
    const { props } = s.enqueue.mock.calls[0][0] as { props: { ip: string } };
    expect(props.ip).toBe('39.48.12.201');
  });

  it('no country and no IP: location and ip are null', async () => {
    const s = setup({ hasOther: true, country: null });
    await s.service.seen(USER_ID, DEVICE_ID, { ip: null, userAgent: null });
    expect(s.inserted.values).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'Unknown browser', country: null }),
    );
    const { props } = s.enqueue.mock.calls[0][0] as {
      props: { ip: string | null; location: string | null };
    };
    expect(props).toEqual(
      expect.objectContaining({
        ip: null,
        location: null,
        device: 'Unknown browser',
      }),
    );
    expect(s.emitter.newLogin).toHaveBeenCalledWith(
      USER_ID,
      'Unknown browser',
      undefined,
    );
  });

  it.each([
    ['the time zone lookup', 'timezone'],
    ['minting the "not me" token', 'token'],
  ])(
    'a failure in %s leaves no row, so the next sign-in alerts again',
    async (_name, failing) => {
      const s = setup({ hasOther: true });
      if (failing === 'timezone') {
        s.recipients.userTimezone.mockRejectedValue(new Error('db down'));
      } else {
        s.tokens.securityToken.mockImplementation(() => {
          throw new Error('JWT_ACCESS_SECRET is not configured');
        });
      }
      await expect(s.service.seen(USER_ID, DEVICE_ID, CTX)).rejects.toThrow();
      expect(s.db.insert).not.toHaveBeenCalled();
      expect(s.enqueue).not.toHaveBeenCalled();
    },
  );

  it('silent and first-device sign-ins need no time zone or token', async () => {
    const s = setup();
    s.tokens.securityToken.mockImplementation(() => {
      throw new Error('unused');
    });
    await expect(s.service.seen(USER_ID, DEVICE_ID, CTX)).resolves.toBe(
      'first',
    );
    expect(s.recipients.userTimezone).not.toHaveBeenCalled();
  });

  it('logs no IP address or user agent when the alert fails', async () => {
    const s = setup({ hasOther: true });
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    s.enqueue.mockRejectedValue(new Error('redis down'));
    await expect(s.service.seen(USER_ID, DEVICE_ID, CTX)).resolves.toBe('new');
    const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).not.toContain('39.48.12.201');
    expect(logged).not.toContain('Mozilla');
    warn.mockRestore();
  });
});

describe('KnownDevicesService.track', () => {
  it('runs seen detached and logs a failure without the IP or user agent', async () => {
    const s = setup();
    s.db.update.mockImplementation(() => {
      throw new Error('relation "known_devices" does not exist');
    });
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    expect(s.service.track(USER_ID, DEVICE_ID, CTX)).toBeUndefined();
    await new Promise((resolve) => setImmediate(resolve));

    expect(warn).toHaveBeenCalledWith(
      `Device tracking failed for user ${USER_ID}: relation "known_devices" does not exist`,
    );
    const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).not.toContain('39.48.12.201');
    expect(logged).not.toContain('Mozilla');
    warn.mockRestore();
  });
});

describe('deviceLabel', () => {
  it('bowser label: Chrome on Windows; empty UA → Unknown browser', () => {
    expect(deviceLabel(CHROME_WINDOWS)).toBe('Chrome on Windows');
    expect(deviceLabel('')).toBe('Unknown browser');
    expect(deviceLabel(null)).toBe('Unknown browser');
    expect(deviceLabel('curl/8.0')).toBe('Unknown browser');
  });

  it('names Safari on iOS and Edge on Windows', () => {
    expect(
      deviceLabel(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      ),
    ).toBe('Safari on iOS');
    expect(deviceLabel(`${CHROME_WINDOWS} Edg/130.0.0.0`)).toBe(
      'Microsoft Edge on Windows',
    );
  });

  it('cuts a long browser name to the 120-char label column', () => {
    // bowser's generic parser names the browser after the product token.
    const name = 'Z'.repeat(200);
    const label = deviceLabel(`${name}/1.0 (Windows NT 10.0; Win64)`);
    expect(label).toHaveLength(120);
    expect(label).toBe(`${name} on Windows`.slice(0, 120));
  });
});

describe('A6 new-sign-in template', () => {
  const ctx: RenderContext = {
    assetBaseUrl: 'https://app.test/email',
    footer: {
      reason: "Security emails can't be turned off.",
      links: [{ label: 'Privacy', href: 'https://s.test/privacy' }],
    },
  };
  const props = NEW_SIGN_IN.fixture;

  it('is mandatory security mail with the security footer', () => {
    expect(NEW_SIGN_IN.id).toBe('new-sign-in');
    expect(NEW_SIGN_IN.category).toBe('security');
    expect(NEW_SIGN_IN.event).toBeNull();
    expect(NEW_SIGN_IN.footer).toBe('security');
  });

  it('subject and preheader follow the Figma inbox preview', () => {
    expect(NEW_SIGN_IN.subject(props)).toBe(
      'New sign-in to Schedura from Chrome on Windows',
    );
    expect(NEW_SIGN_IN.preheader(props)).toBe('Pakistan · Oct 26 at 9:58 PM');
    expect(NEW_SIGN_IN.preheader({ ...props, location: null })).toBe(
      'Unknown location · Oct 26 at 9:58 PM',
    );
  });

  it('renders the four rows and the "This wasn\'t me" outline button', async () => {
    const r = await renderEmail(NEW_SIGN_IN, props, ctx);
    expect(r.text).toContain('New sign-in to your account');
    expect(r.text).toContain('IP address 39.48.12.201');
    expect(r.text).toContain('Location Pakistan (approximate)');
    expect(r.text).toContain('Time Oct 26, 2026 at 9:58 PM GMT+5');
    expect(r.text).toContain('Device Chrome on Windows');
    expect(r.html).toContain('data-email-button="secondary"');
    expect(r.html).toContain(props.notMeUrl);
  });

  it('A6 omits the IP row when ip is null', async () => {
    const r = await renderEmail(NEW_SIGN_IN, { ...props, ip: null }, ctx);
    expect(r.text).not.toContain('IP address');
    expect(r.text).toContain('Device Chrome on Windows');
  });

  it('omits the Location row when there is no country', async () => {
    const r = await renderEmail(NEW_SIGN_IN, { ...props, location: null }, ctx);
    expect(r.text).not.toContain('Location');
    expect(r.text).toContain('IP address 39.48.12.201');
  });

  it('escapes a hostile device label', async () => {
    const r = await renderEmail(
      NEW_SIGN_IN,
      { ...props, device: '<script>x</script>' },
      ctx,
    );
    expect(r.html).not.toContain('<script>x</script>');
    expect(r.html).toContain('&lt;script&gt;');
  });
});
