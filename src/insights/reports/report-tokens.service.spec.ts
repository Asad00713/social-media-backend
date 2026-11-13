import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { ReportTokensService } from './report-tokens.service';
import { ReportsService } from './reports.service';

const SECRET = 'test-secret-not-real';
const RID = '5d0b6f0e-1111-4222-8333-944455556666';
const T = new Date('2026-11-13T10:00:00Z');

function build(secret: string | null = SECRET) {
  const jwt = new JwtService({});
  const config = {
    get: jest.fn((k: string) =>
      k === 'JWT_ACCESS_SECRET' ? (secret ?? undefined) : undefined,
    ),
  } as unknown as ConfigService;
  return { service: new ReportTokensService(jwt, config), jwt };
}

describe('ReportTokensService', () => {
  afterEach(() => jest.useRealTimers());

  it('round-trips a render token to the report id', () => {
    const { service } = build();
    expect(service.verifyRender(service.renderToken(RID))).toBe(RID);
  });

  it('round-trips an unsubscribe token to the report id and address', () => {
    const { service } = build();
    expect(
      service.verifyUnsubscribe(service.unsubscribeToken(RID, 'a@b.co')),
    ).toEqual({ reportId: RID, email: 'a@b.co' });
  });

  it('keeps the two kinds apart', () => {
    const { service } = build();
    expect(
      service.verifyRender(service.unsubscribeToken(RID, 'a@b.co')),
    ).toBeNull();
    expect(service.verifyUnsubscribe(service.renderToken(RID))).toBeNull();
  });

  it('refuses a login-style access token for either kind', () => {
    const { service, jwt } = build();
    const login = jwt.sign(
      { sub: 'u1', email: 'a@b.co', rid: RID },
      { secret: SECRET },
    );
    expect(service.verifyRender(login)).toBeNull();
    expect(service.verifyUnsubscribe(login)).toBeNull();
  });

  it('refuses a token signed with another secret', () => {
    const { service, jwt } = build();
    const forged = jwt.sign(
      { rid: RID },
      { secret: 'someone-else', audience: 'report-render', expiresIn: 300 },
    );
    expect(service.verifyRender(forged)).toBeNull();
  });

  it('refuses a token that is not signed (alg none)', () => {
    const { service } = build();
    const b64 = (o: object) =>
      Buffer.from(JSON.stringify(o)).toString('base64url');
    const none = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ rid: RID, aud: 'report-render' })}.`;
    expect(service.verifyRender(none)).toBeNull();
  });

  it('refuses a payload whose id is not a uuid or whose address is missing', () => {
    const { service, jwt } = build();
    const sign = (p: object, aud: string) =>
      jwt.sign(p, { secret: SECRET, audience: aud });
    expect(
      service.verifyRender(sign({ rid: 'not-a-uuid' }, 'report-render')),
    ).toBeNull();
    expect(service.verifyRender(sign({}, 'report-render'))).toBeNull();
    expect(
      service.verifyUnsubscribe(sign({ rid: RID }, 'report-unsubscribe')),
    ).toBeNull();
    expect(
      service.verifyUnsubscribe(
        sign({ rid: RID, email: 5 }, 'report-unsubscribe'),
      ),
    ).toBeNull();
  });

  it('expires a render token after five minutes', () => {
    jest.useFakeTimers({ now: T });
    const { service } = build();
    const token = service.renderToken(RID);
    jest.setSystemTime(new Date(T.getTime() + 299_000));
    expect(service.verifyRender(token)).toBe(RID);
    jest.setSystemTime(new Date(T.getTime() + 301_000));
    expect(service.verifyRender(token)).toBeNull();
  });

  it('never expires an unsubscribe token', () => {
    jest.useFakeTimers({ now: T });
    const { service } = build();
    const token = service.unsubscribeToken(RID, 'a@b.co');
    jest.setSystemTime(new Date(T.getTime() + 3 * 365 * 24 * 3600 * 1000));
    expect(service.verifyUnsubscribe(token)).toEqual({
      reportId: RID,
      email: 'a@b.co',
    });
  });

  it('mints nothing and verifies nothing without a secret', () => {
    const { service } = build(null);
    expect(() => service.renderToken(RID)).toThrow();
    expect(() => service.unsubscribeToken(RID, 'a@b.co')).toThrow();
    const minted = build().service.renderToken(RID);
    expect(service.verifyRender(minted)).toBeNull();
    expect(service.verifyUnsubscribe(minted)).toBeNull();
  });

  it('treats garbage as no token', () => {
    const { service } = build();
    expect(service.verifyRender('abc.def.ghi')).toBeNull();
    expect(service.verifyUnsubscribe('')).toBeNull();
  });

  describe('isShareToken', () => {
    it('accepts a minted share token', () => {
      expect(
        ReportTokensService.isShareToken(ReportsService.newShareToken()),
      ).toBe(true);
    });

    it('refuses a dotted token and one of the wrong length', () => {
      expect(ReportTokensService.isShareToken('abc.def.ghi')).toBe(false);
      expect(ReportTokensService.isShareToken('a'.repeat(42))).toBe(false);
      expect(ReportTokensService.isShareToken('a'.repeat(44))).toBe(false);
      expect(ReportTokensService.isShareToken('a'.repeat(43))).toBe(true);
    });
  });
});
