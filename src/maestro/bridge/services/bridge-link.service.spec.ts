import { ConfigService } from '@nestjs/config';
import { BridgeLinkService } from './bridge-link.service';

function svc(): BridgeLinkService {
  const config = {
    get: (k: string) =>
      k === 'MAESTRO_LINK_SECRET' ? 'test-secret-please-change' : '',
  } as unknown as ConfigService;
  return new BridgeLinkService(config);
}

describe('BridgeLinkService link tokens', () => {
  it('round-trips a valid token', () => {
    const s = svc();
    const token = s.issueLinkToken('user-1', 'ws-1');
    expect(s.verifyLinkToken(token)).toEqual({
      userId: 'user-1',
      workspaceId: 'ws-1',
    });
  });

  it('rejects a tampered token', () => {
    const s = svc();
    const token = s.issueLinkToken('user-1', 'ws-1');
    const tampered =
      token.slice(0, -2) + (token.endsWith('aa') ? 'bb' : 'aa');
    expect(s.verifyLinkToken(tampered)).toBeNull();
  });

  it('rejects an expired token', () => {
    const s = svc();
    const realNow = Date.now;
    Date.now = () => realNow() - 11 * 60 * 1000; // issued 11 min ago
    const token = s.issueLinkToken('user-1', 'ws-1');
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
    const token = b.issueLinkToken('user-1', 'ws-1');
    expect(a.verifyLinkToken(token)).toBeNull();
  });
});
