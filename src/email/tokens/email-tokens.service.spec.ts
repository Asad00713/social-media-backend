import { createHmac } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { ReportTokensService } from '../../insights/reports/report-tokens.service';
import { EmailTokensService } from './email-tokens.service';

const SECRET = 'test-secret-not-real';
const UID = '5d0b6f0e-1111-4222-8333-944455556666';
const WS = '11111111-1111-4111-8111-111111111111';
const derive = (label: string) =>
  createHmac('sha256', SECRET).update(label).digest('base64url');
const PREFS_KEY = derive('email-prefs-tokens');
const SECURITY_KEY = derive('email-security-tokens');

function build(secret: string | null = SECRET) {
  const jwt = new JwtService({});
  const config = {
    get: jest.fn((k: string) =>
      k === 'JWT_ACCESS_SECRET' ? (secret ?? undefined) : undefined,
    ),
  } as unknown as ConfigService;
  return {
    service: new EmailTokensService(jwt, config),
    reports: new ReportTokensService(jwt, config),
    jwt,
  };
}

describe('EmailTokensService', () => {
  afterEach(() => jest.useRealTimers());

  describe('unsubscribe tokens', () => {
    const claims = { uid: UID, ws: WS, ev: 'post_failed' } as const;

    it('unsubscribe token round-trips and a login access token (no audience) does not verify', () => {
      const { service, jwt } = build();
      expect(
        service.verifyUnsubscribe(service.unsubscribeToken(claims)),
      ).toEqual(claims);
      const login = jwt.sign({ sub: UID, ...claims }, { secret: SECRET });
      expect(service.verifyUnsubscribe(login)).toBeNull();
    });

    it('round-trips an account-level token with a null workspace', () => {
      const { service } = build();
      const account = {
        uid: UID,
        ws: null,
        ev: 'inactivity_reminder',
      } as const;
      expect(
        service.verifyUnsubscribe(service.unsubscribeToken(account)),
      ).toEqual(account);
    });

    it('is deterministic: the same claims always give the same token, with no iat', () => {
      const { service, jwt } = build();
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
      const first = service.unsubscribeToken(claims);
      jest.setSystemTime(Date.now() + 10_000);
      expect(service.unsubscribeToken(claims)).toBe(first);
      expect(jwt.decode(first)).not.toHaveProperty('iat');
      expect(service.verifyUnsubscribe(first)).toEqual(claims);
    });

    it('never expires', () => {
      const { service, jwt } = build();
      const token = service.unsubscribeToken(claims);
      expect(jwt.decode(token)).not.toHaveProperty('exp');
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
      jest.setSystemTime(new Date(Date.now() + 5 * 365 * 24 * 3600 * 1000));
      expect(service.verifyUnsubscribe(token)).toEqual(claims);
    });

    it('a report-unsubscribe token does not verify as an email-unsubscribe token', () => {
      const { service, reports } = build();
      const reportToken = reports.unsubscribeToken(UID, 'a@b.co');
      expect(service.verifyUnsubscribe(reportToken)).toBeNull();
      expect(
        reports.verifyUnsubscribe(service.unsubscribeToken(claims)),
      ).toBeNull();
    });

    it('does not verify as a security token, nor the other way round', () => {
      const { service } = build();
      expect(
        service.verifySecurity(service.unsubscribeToken(claims)),
      ).toBeNull();
      expect(
        service.verifyUnsubscribe(
          service.securityToken({ uid: UID, act: 'not_me' }),
        ),
      ).toBeNull();
    });

    it('refuses a token signed with another secret, another algorithm or another audience', () => {
      const { service, jwt } = build();
      const forged = jwt.sign(claims, {
        secret: 'someone-else',
        audience: 'email-unsubscribe',
      });
      const hs512 = jwt.sign(claims, {
        secret: PREFS_KEY,
        algorithm: 'HS512',
        audience: 'email-unsubscribe',
      });
      const wrongAudience = jwt.sign(claims, {
        secret: PREFS_KEY,
        audience: 'email-security',
      });
      for (const t of [forged, hs512, wrongAudience, 'abc.def.ghi', '']) {
        expect(service.verifyUnsubscribe(t)).toBeNull();
      }
    });

    it('refuses a token whose claims are not a user, a workspace and a known event', () => {
      const { service, jwt } = build();
      const sign = (payload: Record<string, unknown>) =>
        jwt.sign(payload, {
          secret: PREFS_KEY,
          audience: 'email-unsubscribe',
        });
      const bad = [
        { ...claims, uid: 'nope' },
        { ...claims, ws: 'nope' },
        { ...claims, ws: undefined },
        { ...claims, ev: 'not_an_event' },
        { ...claims, ev: '__proto__' },
        { ...claims, ev: 'constructor' },
        { ws: WS, ev: 'post_failed' },
      ];
      for (const payload of bad) {
        expect(service.verifyUnsubscribe(sign(payload))).toBeNull();
      }
    });

    it('refuses to mint, and verifies nothing, when JWT_ACCESS_SECRET is unset', () => {
      const { service } = build(null);
      expect(() => service.unsubscribeToken(claims)).toThrow(
        /JWT_ACCESS_SECRET/,
      );
      const minted = build().service.unsubscribeToken(claims);
      expect(service.verifyUnsubscribe(minted)).toBeNull();
    });
  });

  describe('security tokens', () => {
    it('round-trips with and without the addresses', () => {
      const { service } = build();
      const full = {
        uid: UID,
        act: 'revert_email',
        from: 'old@acme.com',
        to: 'new@acme.com',
      } as const;
      expect(service.verifySecurity(service.securityToken(full))).toEqual(full);
      const bare = { uid: UID, act: 'not_me' } as const;
      expect(service.verifySecurity(service.securityToken(bare))).toEqual(bare);
    });

    it('keeps iat and exp: it is never a header of queued mail', () => {
      const { service, jwt } = build();
      const decoded: unknown = jwt.decode(
        service.securityToken({ uid: UID, act: 'not_me' }),
      );
      expect(decoded).toHaveProperty('iat');
      expect(decoded).toHaveProperty('exp');
    });

    it('security token expires after 7 days', () => {
      const { service } = build();
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
      const token = service.securityToken({ uid: UID, act: 'not_me' });
      jest.setSystemTime(new Date(Date.now() + 7 * 24 * 3600 * 1000 - 60_000));
      expect(service.verifySecurity(token)).not.toBeNull();
      jest.setSystemTime(new Date(Date.now() + 2 * 60_000));
      expect(service.verifySecurity(token)).toBeNull();
    });

    it('refuses a token that was already expired when it was signed', () => {
      const { service, jwt } = build();
      const expired = jwt.sign(
        { uid: UID, act: 'not_me' },
        { secret: SECURITY_KEY, audience: 'email-security', expiresIn: -10 },
      );
      expect(service.verifySecurity(expired)).toBeNull();
    });

    it('refuses an unknown action, a bad user, a bad address and a login token', () => {
      const { service, jwt } = build();
      const sign = (payload: Record<string, unknown>) =>
        jwt.sign(payload, {
          secret: SECURITY_KEY,
          audience: 'email-security',
          expiresIn: 60,
        });
      expect(
        service.verifySecurity(sign({ uid: UID, act: 'delete' })),
      ).toBeNull();
      expect(
        service.verifySecurity(sign({ uid: 'x', act: 'not_me' })),
      ).toBeNull();
      expect(
        service.verifySecurity(sign({ uid: UID, act: 'not_me', to: 5 })),
      ).toBeNull();
      const login = jwt.sign(
        { sub: UID, uid: UID, act: 'not_me' },
        { secret: SECRET },
      );
      expect(service.verifySecurity(login)).toBeNull();
    });
  });
});
