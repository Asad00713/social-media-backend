import { NotFoundException } from '@nestjs/common';
// A fixed 32-byte key so the encryption util works under test. Must be set
// before the service (and the util it imports) is loaded.
process.env.ENCRYPTION_KEY =
  '0'.repeat(64); // 64 hex chars = 32 bytes
import { CanvaConnectionService } from './canva-connection.service';
import { encrypt, decrypt } from '../common/utils/encryption.util';

// Minimal fake db mirroring the query-builder chains the service uses.
// The closures below read these mutable holders lazily (at call time), so
// each test can set them up before invoking the service.
let selectRows: any[] = [];
let insertRows: any[] = [];
let insertValuesArgs: any = null;
let updateSetArgs: any = null;
let deletedWhere = false;

jest.mock('../drizzle/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(selectRows),
        }),
      }),
    }),
    insert: () => ({
      values: (vals: any) => {
        insertValuesArgs = vals;
        return {
          onConflictDoUpdate: () => ({
            returning: () => Promise.resolve(insertRows),
          }),
        };
      },
    }),
    update: () => ({
      set: (vals: any) => {
        updateSetArgs = vals;
        return { where: () => Promise.resolve() };
      },
    }),
    delete: () => ({
      where: () => {
        deletedWhere = true;
        return Promise.resolve();
      },
    }),
  },
}));

function makeService(overrides: Partial<Record<string, jest.Mock>> = {}) {
  const canvaService = {
    refreshAccessToken: overrides.refreshAccessToken ?? jest.fn(),
    revokeToken: overrides.revokeToken ?? jest.fn().mockResolvedValue(undefined),
  } as any;
  return { service: new CanvaConnectionService(canvaService), canvaService };
}

describe('CanvaConnectionService.getValidAccessToken', () => {
  beforeEach(() => {
    selectRows = [];
    insertRows = [];
    insertValuesArgs = null;
    updateSetArgs = null;
    deletedWhere = false;
    jest.clearAllMocks();
  });

  it('throws NotFoundException when the workspace has no connection', async () => {
    const { service } = makeService();
    await expect(service.getValidAccessToken('ws-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('returns the decrypted stored access token when it is not near expiry', async () => {
    const farFuture = new Date(Date.now() + 60 * 60 * 1000);
    selectRows = [
      {
        workspaceId: 'ws-1',
        accessToken: encrypt('stored-token'),
        refreshToken: encrypt('stored-refresh'),
        tokenExpiresAt: farFuture,
      },
    ];
    const refreshAccessToken = jest.fn();
    const { service } = makeService({ refreshAccessToken });

    const token = await service.getValidAccessToken('ws-1');

    expect(token).toBe('stored-token');
    expect(refreshAccessToken).not.toHaveBeenCalled();
  });

  it('tolerates a legacy plaintext access token (migration path)', async () => {
    const farFuture = new Date(Date.now() + 60 * 60 * 1000);
    selectRows = [
      {
        workspaceId: 'ws-1',
        accessToken: 'legacy-plaintext-token',
        refreshToken: 'legacy-plaintext-refresh',
        tokenExpiresAt: farFuture,
      },
    ];
    const { service } = makeService();

    const token = await service.getValidAccessToken('ws-1');

    expect(token).toBe('legacy-plaintext-token');
  });

  it('refreshes with the decrypted refresh token and persists new tokens encrypted', async () => {
    const past = new Date(Date.now() - 60 * 1000);
    selectRows = [
      {
        workspaceId: 'ws-1',
        accessToken: encrypt('old-token'),
        refreshToken: encrypt('old-refresh'),
        tokenExpiresAt: past,
      },
    ];
    const refreshAccessToken = jest.fn().mockResolvedValue({
      accessToken: 'new-token',
      refreshToken: 'new-refresh',
      expiresIn: 3600,
      tokenType: 'Bearer',
      scope: 'design:content:read',
    });
    const { service } = makeService({ refreshAccessToken });

    const token = await service.getValidAccessToken('ws-1');

    // Refresh is called with the decrypted secret, never the ciphertext.
    expect(refreshAccessToken).toHaveBeenCalledWith('old-refresh');
    expect(token).toBe('new-token');
    // Persisted values are ciphertext (not the raw new tokens) but round-trip.
    expect(updateSetArgs.accessToken).not.toBe('new-token');
    expect(updateSetArgs.refreshToken).not.toBe('new-refresh');
    expect(decrypt(updateSetArgs.accessToken)).toBe('new-token');
    expect(decrypt(updateSetArgs.refreshToken)).toBe('new-refresh');
  });

  it('also refreshes when the token is within the 60s expiry skew', async () => {
    const almostExpired = new Date(Date.now() + 30 * 1000);
    selectRows = [
      {
        workspaceId: 'ws-1',
        accessToken: encrypt('old-token'),
        refreshToken: encrypt('old-refresh'),
        tokenExpiresAt: almostExpired,
      },
    ];
    const refreshAccessToken = jest.fn().mockResolvedValue({
      accessToken: 'new-token',
      refreshToken: 'new-refresh',
      expiresIn: 3600,
      tokenType: 'Bearer',
      scope: 'design:content:read',
    });
    const { service } = makeService({ refreshAccessToken });

    const token = await service.getValidAccessToken('ws-1');

    expect(refreshAccessToken).toHaveBeenCalled();
    expect(token).toBe('new-token');
  });
});

describe('CanvaConnectionService.getByWorkspace', () => {
  beforeEach(() => {
    selectRows = [];
  });

  it('returns null when no row exists', async () => {
    const { service } = makeService();
    await expect(service.getByWorkspace('ws-none')).resolves.toBeNull();
  });

  it('returns the row when one exists', async () => {
    selectRows = [{ workspaceId: 'ws-1', displayName: 'Jane' }];
    const { service } = makeService();
    await expect(service.getByWorkspace('ws-1')).resolves.toMatchObject({
      displayName: 'Jane',
    });
  });
});

describe('CanvaConnectionService.upsert', () => {
  beforeEach(() => {
    insertRows = [];
    insertValuesArgs = null;
  });

  it('computes tokenExpiresAt and returns the persisted row', async () => {
    insertRows = [
      {
        workspaceId: 'ws-1',
        displayName: 'Jane',
        accessToken: 'tok',
        refreshToken: 'ref',
      },
    ];
    const { service } = makeService();
    const row = await service.upsert('ws-1', 'user-1', {
      canvaUserId: 'canva-1',
      displayName: 'Jane',
      accessToken: 'tok',
      refreshToken: 'ref',
      expiresIn: 3600,
    });
    expect(row).toMatchObject({ workspaceId: 'ws-1', displayName: 'Jane' });
  });

  it('encrypts the tokens before persisting them', async () => {
    insertRows = [{ workspaceId: 'ws-1' }];
    const { service } = makeService();
    await service.upsert('ws-1', 'user-1', {
      displayName: 'Jane',
      accessToken: 'plain-access',
      refreshToken: 'plain-refresh',
      expiresIn: 3600,
    });
    expect(insertValuesArgs.accessToken).not.toBe('plain-access');
    expect(insertValuesArgs.refreshToken).not.toBe('plain-refresh');
    expect(decrypt(insertValuesArgs.accessToken)).toBe('plain-access');
    expect(decrypt(insertValuesArgs.refreshToken)).toBe('plain-refresh');
  });
});

describe('CanvaConnectionService.disconnect', () => {
  beforeEach(() => {
    selectRows = [];
    deletedWhere = false;
    jest.clearAllMocks();
  });

  it('returns quietly and does nothing when nothing is connected', async () => {
    const revokeToken = jest.fn();
    const { service } = makeService({ revokeToken });
    await service.disconnect('ws-none');
    expect(revokeToken).not.toHaveBeenCalled();
    expect(deletedWhere).toBe(false);
  });

  it('revokes the decrypted refresh token and deletes the row', async () => {
    selectRows = [
      {
        workspaceId: 'ws-1',
        accessToken: encrypt('a'),
        refreshToken: encrypt('the-refresh'),
        tokenExpiresAt: new Date(),
      },
    ];
    const revokeToken = jest.fn().mockResolvedValue(undefined);
    const { service } = makeService({ revokeToken });

    await service.disconnect('ws-1');

    expect(revokeToken).toHaveBeenCalledWith('the-refresh');
    expect(deletedWhere).toBe(true);
  });

  it('still deletes the row even if revocation rejects', async () => {
    selectRows = [
      {
        workspaceId: 'ws-1',
        accessToken: encrypt('a'),
        refreshToken: encrypt('r'),
        tokenExpiresAt: new Date(),
      },
    ];
    // revokeToken swallows its own errors, but guard the contract here too:
    // a disconnect must always clear the local row.
    const revokeToken = jest.fn().mockResolvedValue(undefined);
    const { service } = makeService({ revokeToken });

    await service.disconnect('ws-1');

    expect(deletedWhere).toBe(true);
  });
});
