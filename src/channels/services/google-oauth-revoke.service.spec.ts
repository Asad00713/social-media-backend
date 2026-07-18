import { Test } from '@nestjs/testing';
import { GoogleOauthRevokeService } from './google-oauth-revoke.service';
import { DRIZZLE } from '../../drizzle/drizzle.module';

const execute = jest.fn();
const fakeDb = { execute };

async function build() {
  const mod = await Test.createTestingModule({
    providers: [
      GoogleOauthRevokeService,
      { provide: DRIZZLE, useValue: fakeDb },
    ],
  }).compile();
  return mod.get(GoogleOauthRevokeService);
}

/** Make the "other Google channels in this workspace" count return `n`. */
function otherGoogleChannels(n: number) {
  execute.mockResolvedValue({ rows: [{ count: String(n) }] });
}

describe('GoogleOauthRevokeService', () => {
  beforeEach(() => {
    execute.mockReset();
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' }) as any;
  });

  afterEach(() => jest.restoreAllMocks());

  it('revokes when this is the last Google channel', async () => {
    otherGoogleChannels(0);
    const svc = await build();
    const result = await svc.revokeIfLastGoogleChannel(1, 'ws', 'youtube', 'TKN');

    expect(result.revoked).toBe(true);
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://oauth2.googleapis.com/revoke');
    expect(init.body).toContain('TKN');
  });

  // Drive/Photos/Calendar share the YouTube OAuth app, and Google revokes the
  // WHOLE combined authorization — so revoking here would silently kill the
  // user's Drive. This is the single most important behavior in this service.
  it('does NOT revoke while another Google channel is still connected', async () => {
    otherGoogleChannels(1);
    const svc = await build();
    const result = await svc.revokeIfLastGoogleChannel(1, 'ws', 'youtube', 'TKN');

    expect(result.revoked).toBe(false);
    expect(result.reason).toMatch(/other google/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('does nothing for a non-Google platform', async () => {
    const svc = await build();
    const result = await svc.revokeIfLastGoogleChannel(1, 'ws', 'twitter', 'TKN');

    expect(result.revoked).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
    // No point querying the DB for a platform that was never a Google grant.
    expect(execute).not.toHaveBeenCalled();
  });

  // The user asked to disconnect. Whatever Google says, that must succeed.
  it('reports failure without throwing when Google rejects the revoke', async () => {
    otherGoogleChannels(0);
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 400, text: async () => 'invalid_token' }) as any;
    const svc = await build();

    const result = await svc.revokeIfLastGoogleChannel(1, 'ws', 'youtube', 'TKN');
    expect(result.revoked).toBe(false);
    expect(result.reason).toMatch(/400/);
  });

  it('reports failure without throwing when the network is down', async () => {
    otherGoogleChannels(0);
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as any;
    const svc = await build();

    const result = await svc.revokeIfLastGoogleChannel(1, 'ws', 'youtube', 'TKN');
    expect(result.revoked).toBe(false);
    expect(result.reason).toMatch(/ECONNREFUSED/);
  });

  it('excludes the channel being disconnected from the other-channel count', async () => {
    otherGoogleChannels(0);
    const svc = await build();
    await svc.revokeIfLastGoogleChannel(42, 'ws', 'youtube', 'TKN');

    // The query must say "other Google channels EXCEPT id 42" — otherwise the
    // channel being disconnected counts itself and revoke never fires.
    expect(JSON.stringify(execute.mock.calls[0][0])).toContain('42');
  });
});
