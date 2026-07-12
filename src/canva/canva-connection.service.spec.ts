import { NotFoundException } from '@nestjs/common';
import { CanvaConnectionService } from './canva-connection.service';

// Minimal fake db mirroring the query-builder chains the service uses.
// The closures below read these mutable holders lazily (at call time), so
// each test can set them up before invoking the service.
let selectRows: any[] = [];
let insertRows: any[] = [];
let updateSetArgs: any = null;

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
      values: () => ({
        onConflictDoUpdate: () => ({
          returning: () => Promise.resolve(insertRows),
        }),
      }),
    }),
    update: () => ({
      set: (vals: any) => {
        updateSetArgs = vals;
        return { where: () => Promise.resolve() };
      },
    }),
  },
}));

function makeService(refreshAccessToken?: jest.Mock) {
  const canvaService = {
    refreshAccessToken: refreshAccessToken ?? jest.fn(),
  } as any;
  return { service: new CanvaConnectionService(canvaService), canvaService };
}

describe('CanvaConnectionService.getValidAccessToken', () => {
  beforeEach(() => {
    selectRows = [];
    insertRows = [];
    updateSetArgs = null;
    jest.clearAllMocks();
  });

  it('throws NotFoundException when the workspace has no connection', async () => {
    const { service } = makeService();
    await expect(service.getValidAccessToken('ws-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('returns the stored access token when it is not near expiry', async () => {
    const farFuture = new Date(Date.now() + 60 * 60 * 1000);
    selectRows = [
      {
        workspaceId: 'ws-1',
        accessToken: 'stored-token',
        refreshToken: 'stored-refresh',
        tokenExpiresAt: farFuture,
      },
    ];
    const refreshAccessToken = jest.fn();
    const { service } = makeService(refreshAccessToken);

    const token = await service.getValidAccessToken('ws-1');

    expect(token).toBe('stored-token');
    expect(refreshAccessToken).not.toHaveBeenCalled();
  });

  it('refreshes and persists new tokens when the stored token is expired', async () => {
    const past = new Date(Date.now() - 60 * 1000);
    selectRows = [
      {
        workspaceId: 'ws-1',
        accessToken: 'old-token',
        refreshToken: 'old-refresh',
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
    const { service } = makeService(refreshAccessToken);

    const token = await service.getValidAccessToken('ws-1');

    expect(refreshAccessToken).toHaveBeenCalledWith('old-refresh');
    expect(token).toBe('new-token');
    expect(updateSetArgs).toMatchObject({
      accessToken: 'new-token',
      refreshToken: 'new-refresh',
    });
  });

  it('also refreshes when the token is within the 60s expiry skew', async () => {
    const almostExpired = new Date(Date.now() + 30 * 1000);
    selectRows = [
      {
        workspaceId: 'ws-1',
        accessToken: 'old-token',
        refreshToken: 'old-refresh',
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
    const { service } = makeService(refreshAccessToken);

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
});
