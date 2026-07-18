import { Test } from '@nestjs/testing';
import { YouTubeService } from './youtube.service';
import { QuotaTrackerService } from '../analytics/services/quota-tracker.service';

const tryConsume = jest.fn();
const quota = { tryConsume };

async function build() {
  const mod = await Test.createTestingModule({
    providers: [
      YouTubeService,
      { provide: QuotaTrackerService, useValue: quota },
    ],
  }).compile();
  return mod.get(YouTubeService);
}

describe('YouTubeService.checkAuthorization', () => {
  beforeEach(() => {
    tryConsume.mockReset().mockResolvedValue({ allowed: true, remaining: 100 });
  });

  afterEach(() => jest.restoreAllMocks());

  it('reports authorized when the API call succeeds', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '',
    }) as any;
    const svc = await build();

    const result = await svc.checkAuthorization('TKN');
    expect(result).toEqual({ authorized: true, reason: 'ok' });
  });

  // CRITICAL: this is the exact distinction Finding 1 is about. A genuine
  // 401/403 IS proof the token was revoked.
  it('reports "unauthorized" on a genuine 401', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => '{"error":"invalid_token"}',
    }) as any;
    const svc = await build();

    const result = await svc.checkAuthorization('TKN');
    expect(result.authorized).toBe(false);
    expect(result.reason).toBe('unauthorized');
  });

  it('reports "unauthorized" on a genuine 403', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => '{"error":"insufficient_scope"}',
    }) as any;
    const svc = await build();

    const result = await svc.checkAuthorization('TKN');
    expect(result.reason).toBe('unauthorized');
  });

  it('reports "unauthorized" when Google returns invalid_grant even under a different status', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => '{"error":"invalid_grant"}',
    }) as any;
    const svc = await build();

    const result = await svc.checkAuthorization('TKN');
    expect(result.reason).toBe('unauthorized');
  });

  // CRITICAL regression case: a Google 500 must NOT be mistaken for
  // revocation — otherwise a transient outage permanently bricks the channel.
  it('reports "error" (not "unauthorized") on a Google 500', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Internal error',
    }) as any;
    const svc = await build();

    const result = await svc.checkAuthorization('TKN');
    expect(result.authorized).toBe(false);
    expect(result.reason).toBe('error');
  });

  // CRITICAL regression case: a network blip must NOT be mistaken for
  // revocation.
  it('reports "error" on a network failure', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNRESET')) as any;
    const svc = await build();

    const result = await svc.checkAuthorization('TKN');
    expect(result.authorized).toBe(false);
    expect(result.reason).toBe('error');
    expect(result.message).toMatch(/ECONNRESET/);
  });

  // CRITICAL regression case: quota exhaustion must NOT be mistaken for
  // revocation. This is the exact bug from Finding 1 — getCurrentChannel (and
  // therefore verifyToken) reserves quota before calling Google and throws
  // when the publishing allowance is spent, which verifyToken then reported
  // as an indistinguishable `false`.
  it('reports "error" (not "unauthorized") when quota is exhausted, without calling Google', async () => {
    tryConsume.mockResolvedValue({ allowed: false, remaining: 0 });
    global.fetch = jest.fn();
    const svc = await build();

    const result = await svc.checkAuthorization('TKN');
    expect(result.authorized).toBe(false);
    expect(result.reason).toBe('error');
    expect(result.message).toMatch(/quota/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
