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

    // The count query (the second SELECT — the first looks up the owner) must
    // say "other Google channels EXCEPT id 42" — otherwise the channel being
    // disconnected counts itself and revoke never fires.
    const countQuery = execute.mock.calls[execute.mock.calls.length - 1][0];
    expect(JSON.stringify(countQuery)).toContain('42');
  });

  // Finding 6: a Google grant belongs to a Google ACCOUNT, not a workspace.
  // Agency scenario: one Google account has YouTube in workspace A and Drive
  // in workspace B. Disconnecting YouTube in A must see Drive in B (same
  // connected_by_user_id) and skip the revoke, not just look inside A.
  describe('cross-workspace scoping by connected_by_user_id (Finding 6)', () => {
    it('counts other Google channels across every workspace when the same user connected them', async () => {
      execute
        .mockResolvedValueOnce({ rows: [{ connected_by_user_id: 'user-1' }] }) // owner lookup
        .mockResolvedValueOnce({ rows: [{ count: '1' }] }); // cross-workspace count
      const svc = await build();

      const result = await svc.revokeIfLastGoogleChannel(1, 'ws-a', 'youtube', 'TKN');

      expect(result.revoked).toBe(false);
      expect(global.fetch).not.toHaveBeenCalled();
      const countQuery = JSON.stringify(execute.mock.calls[1][0]);
      expect(countQuery).toContain('user-1');
      // The cross-user-scoped query must NOT restrict by workspace, or it
      // degenerates back into the workspace-scoped bug this fix addresses.
      expect(countQuery).not.toContain('ws-a');
    });

    it('revokes when no other Google channel exists for that user, anywhere', async () => {
      execute
        .mockResolvedValueOnce({ rows: [{ connected_by_user_id: 'user-1' }] })
        .mockResolvedValueOnce({ rows: [{ count: '0' }] });
      const svc = await build();

      const result = await svc.revokeIfLastGoogleChannel(1, 'ws-a', 'youtube', 'TKN');

      expect(result.revoked).toBe(true);
    });

    // The NULL fallback: grouping every NULL-owner channel together as if
    // they shared one Google account would be wrong, so this must fall back
    // to the old workspace-scoped behavior instead.
    it('falls back to workspace-scoped counting when connected_by_user_id is NULL', async () => {
      execute
        .mockResolvedValueOnce({ rows: [{ connected_by_user_id: null }] })
        .mockResolvedValueOnce({ rows: [{ count: '0' }] });
      const svc = await build();

      const result = await svc.revokeIfLastGoogleChannel(1, 'ws-a', 'youtube', 'TKN');

      expect(result.revoked).toBe(true);
      const countQuery = JSON.stringify(execute.mock.calls[1][0]);
      expect(countQuery).toContain('ws-a');
    });
  });
});
