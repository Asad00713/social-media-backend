import type { Client } from 'pg';
import { runBackfillFileSizes } from './backfill-file-sizes';

const LOCAL_URL = 'postgres://user:pw@localhost:5432/test';

interface FakeRow {
  id: string;
  workspace_id: string;
  storage_provider: 'cloudinary' | 'r2' | null;
  cloudinary_public_id: string | null;
  file_url: string;
  type: string;
  mime_type: string | null;
}

const row = (n: number, provider: FakeRow['storage_provider']): FakeRow => ({
  id: `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`,
  workspace_id: 'ws',
  storage_provider: provider,
  cloudinary_public_id: provider === 'cloudinary' ? `pid-${n}` : null,
  file_url: `https://cdn.example.test/${n}.png`,
  type: 'image',
  mime_type: 'image/png',
});

const idOf = (n: number) => row(n, null).id;

/** An in-memory stand-in for the two statements the script issues. */
function fakeConnect(rows: FakeRow[]) {
  const updates: Array<{ id: string; size: number }> = [];
  const client = {
    query: jest.fn((text: string, params: unknown[] = []) => {
      if (/^\s*UPDATE/i.test(text)) {
        updates.push({ size: params[0] as number, id: params[1] as string });
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      const after = params[0] as string;
      const limit = params[1] as number;
      return Promise.resolve({
        rows: rows
          .filter((r) => r.id > after)
          .sort((x, y) => (x.id < y.id ? -1 : 1))
          .slice(0, limit),
      });
    }),
    end: jest.fn(() => Promise.resolve()),
  };
  const connect = jest.fn(() => Promise.resolve(client as unknown as Client));
  return { connect, client, updates };
}

beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

const base = { databaseUrl: LOCAL_URL, confirmedProduction: false };

describe('runBackfillFileSizes', () => {
  it('refuses a .railway.internal host without the flag, before connecting', async () => {
    const { connect } = fakeConnect([]);
    await expect(
      runBackfillFileSizes({
        databaseUrl: 'postgres://u:p@db.railway.internal:5432/railway',
        confirmedProduction: false,
        dryRun: false,
        storage: { realSize: jest.fn() },
        connect,
      }),
    ).rejects.toThrow(/--i-know-this-is-production/);
    expect(connect).not.toHaveBeenCalled();
  });

  it('fills null sizes with the provider-reported bytes', async () => {
    const { connect, updates } = fakeConnect([
      row(1, 'cloudinary'),
      row(2, 'r2'),
    ]);
    const realSize = jest
      .fn()
      .mockResolvedValueOnce(1111)
      .mockResolvedValueOnce(2222);
    const res = await runBackfillFileSizes({
      ...base,
      dryRun: false,
      storage: { realSize },
      connect,
    });
    expect(res).toEqual({ filled: 2, failed: [], skippedForRateLimit: 0 });
    expect(updates).toEqual([
      { id: idOf(1), size: 1111 },
      { id: idOf(2), size: 2222 },
    ]);
  });

  it('lists a row whose size cannot be found in failed and does not write it', async () => {
    const { connect, updates } = fakeConnect([row(1, 'cloudinary')]);
    const res = await runBackfillFileSizes({
      ...base,
      dryRun: false,
      storage: { realSize: jest.fn().mockResolvedValue(null) },
      connect,
    });
    expect(res.failed).toEqual([idOf(1)]);
    expect(res.filled).toBe(0);
    expect(updates).toEqual([]);
  });

  it('records a row whose provider throws in failed and carries on', async () => {
    const { connect, updates } = fakeConnect([
      row(1, 'cloudinary'),
      row(2, 'r2'),
    ]);
    const realSize = jest
      .fn()
      .mockRejectedValueOnce(new Error('Cloudinary 500'))
      .mockResolvedValueOnce(2222);
    const res = await runBackfillFileSizes({
      ...base,
      dryRun: false,
      storage: { realSize },
      connect,
    });
    expect(res).toEqual({
      filled: 1,
      failed: [idOf(1)],
      skippedForRateLimit: 0,
    });
    expect(updates).toEqual([{ id: idOf(2), size: 2222 }]);
  });

  it('issues no UPDATE on a dry run, but still reports what it would fill', async () => {
    const { connect, updates } = fakeConnect([row(1, 'r2')]);
    const res = await runBackfillFileSizes({
      ...base,
      dryRun: true,
      storage: { realSize: jest.fn().mockResolvedValue(500) },
      connect,
    });
    expect(updates).toEqual([]);
    expect(res.filled).toBe(1);
  });

  it('stops asking Cloudinary after the cap and counts the rest as skipped; R2 is not capped', async () => {
    const { connect, updates } = fakeConnect([
      row(1, 'cloudinary'),
      row(2, 'cloudinary'),
      row(3, 'cloudinary'),
      row(4, 'r2'),
    ]);
    const realSize = jest.fn().mockResolvedValue(10);
    const res = await runBackfillFileSizes({
      ...base,
      dryRun: false,
      maxCloudinaryCalls: 1,
      storage: { realSize },
      connect,
    });
    expect(res.skippedForRateLimit).toBe(2);
    expect(res.filled).toBe(2);
    expect(realSize).toHaveBeenCalledTimes(2);
    expect(updates.map((u) => u.id)).toEqual([idOf(1), idOf(4)]);
  });

  it('pages through more than one page of rows', async () => {
    const rows = Array.from({ length: 150 }, (_, i) => row(i + 1, 'r2'));
    const { connect, updates } = fakeConnect(rows);
    const res = await runBackfillFileSizes({
      ...base,
      dryRun: false,
      storage: { realSize: jest.fn().mockResolvedValue(1) },
      connect,
    });
    expect(res.filled).toBe(150);
    expect(updates).toHaveLength(150);
  });
});
