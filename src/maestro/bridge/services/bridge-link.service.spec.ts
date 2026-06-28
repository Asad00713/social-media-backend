import { ConfigService } from '@nestjs/config';
import { BridgeLinkService } from './bridge-link.service';

function svc(): BridgeLinkService {
  const config = {
    get: (k: string) =>
      k === 'MAESTRO_LINK_SECRET' ? 'test-secret-please-change' : '',
  } as unknown as ConfigService;
  return new BridgeLinkService(config);
}

const USER = '11111111-1111-4111-8111-111111111111';
const WS = '22222222-2222-4222-8222-222222222222';

describe('BridgeLinkService link tokens', () => {
  it('round-trips a valid token', () => {
    const s = svc();
    const token = s.issueLinkToken(USER, WS);
    expect(s.verifyLinkToken(token)).toEqual({
      userId: USER,
      workspaceId: WS,
    });
  });

  it('stays within Telegram start-param limits (<=64 chars, [A-Za-z0-9_-])', () => {
    const token = svc().issueLinkToken(USER, WS);
    expect(token.length).toBeLessThanOrEqual(64);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('rejects a tampered token', () => {
    const s = svc();
    const token = s.issueLinkToken(USER, WS);
    const tampered =
      token.slice(0, -2) + (token.endsWith('aa') ? 'bb' : 'aa');
    expect(s.verifyLinkToken(tampered)).toBeNull();
  });

  it('rejects an expired token', () => {
    const s = svc();
    const realNow = Date.now;
    Date.now = () => realNow() - 11 * 60 * 1000; // issued 11 min ago
    const token = s.issueLinkToken(USER, WS);
    Date.now = realNow;
    expect(s.verifyLinkToken(token)).toBeNull();
  });

  it('rejects garbage', () => {
    expect(svc().verifyLinkToken('not-a-token')).toBeNull();
  });

  it('rejects a token signed with a different secret', () => {
    const a = svc();
    const other = {
      get: (k: string) =>
        k === 'MAESTRO_LINK_SECRET' ? 'a-totally-different-secret' : '',
    } as unknown as ConfigService;
    const b = new BridgeLinkService(other);
    const token = b.issueLinkToken(USER, WS);
    expect(a.verifyLinkToken(token)).toBeNull();
  });
});
