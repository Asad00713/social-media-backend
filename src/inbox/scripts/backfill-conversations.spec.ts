import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Client } from 'pg';
import { runBackfill } from './backfill-conversations';

const SQL = '-- header\nSELECT 1;\n';

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function sqlFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'backfill-'));
  tempDirs.push(dir);
  const file = join(dir, '0052.sql');
  writeFileSync(file, contents);
  return file;
}

function fakeConnect() {
  const queries: string[] = [];
  const client = {
    query: jest.fn((text: string) => {
      queries.push(text);
      return Promise.resolve({
        rows: /count\(\*\)/i.test(text) ? [{ n: '7' }] : [],
      });
    }),
    end: jest.fn(() => Promise.resolve()),
  };
  const connect = jest.fn(() => Promise.resolve(client as unknown as Client));
  return { connect, client, queries };
}

describe('runBackfill', () => {
  it('refuses a non-local host without confirmation, before connecting', async () => {
    const { connect } = fakeConnect();
    await expect(
      runBackfill({
        databaseUrl: 'postgres://u@prod.example.com/db',
        confirmedProduction: false,
        sqlPath: sqlFile(SQL),
        connect,
      }),
    ).rejects.toThrow(/refusing to run against "prod\.example\.com"/);
    expect(connect).not.toHaveBeenCalled();
  });

  it('refuses a host= override even when the URL says localhost', async () => {
    const { connect } = fakeConnect();
    await expect(
      runBackfill({
        databaseUrl: 'postgres://u@localhost/db?host=prod.example.com',
        confirmedProduction: false,
        sqlPath: sqlFile(SQL),
        connect,
      }),
    ).rejects.toThrow(/host=/);
    expect(connect).not.toHaveBeenCalled();
  });

  it('runs against localhost as BEGIN, the SQL, COMMIT, and returns the count', async () => {
    const { connect, client, queries } = fakeConnect();
    const res = await runBackfill({
      databaseUrl: 'postgres://u@localhost/db',
      confirmedProduction: false,
      sqlPath: sqlFile(SQL),
      connect,
    });
    expect(res).toEqual({ conversations: 7 });
    expect(connect).toHaveBeenCalledWith('postgres://u@localhost/db');
    expect(queries[0]).toBe('BEGIN');
    expect(queries[1]).toBe(SQL);
    expect(queries[queries.length - 1]).toBe('COMMIT');
    expect(client.end).toHaveBeenCalled();
  });

  it('strips an outer BEGIN/COMMIT from the file so the transaction is its own', async () => {
    const { connect, queries } = fakeConnect();
    await runBackfill({
      databaseUrl: 'postgres://u@localhost/db',
      confirmedProduction: false,
      sqlPath: sqlFile('BEGIN;\nSELECT 1;\nCOMMIT;\n'),
      connect,
    });
    expect(queries.filter((q) => /^\s*BEGIN/i.test(q))).toHaveLength(1);
    expect(queries[1]).not.toMatch(/BEGIN|COMMIT/i);
  });

  it('allows a public host with the explicit production confirmation', async () => {
    const { connect } = fakeConnect();
    await runBackfill({
      databaseUrl: 'postgres://u@prod.example.com/db',
      confirmedProduction: true,
      sqlPath: sqlFile(SQL),
      connect,
    });
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('refuses a deploy-internal host without the production flag too', async () => {
    const { connect } = fakeConnect();
    await expect(
      runBackfill({
        databaseUrl: 'postgres://u@db.railway.internal/db',
        confirmedProduction: false,
        sqlPath: sqlFile(SQL),
        connect,
      }),
    ).rejects.toThrow(/--i-know-this-is-production/);
    expect(connect).not.toHaveBeenCalled();
  });

  it('allows a deploy-internal host with the production flag', async () => {
    const { connect } = fakeConnect();
    await runBackfill({
      databaseUrl: 'postgres://u@db.railway.internal/db',
      confirmedProduction: true,
      sqlPath: sqlFile(SQL),
      connect,
    });
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('the real 0052 file takes an EXCLUSIVE lock on inbox_conversations before any write', async () => {
    const { connect, queries } = fakeConnect();
    await runBackfill({
      databaseUrl: 'postgres://u@localhost/db',
      confirmedProduction: false,
      connect,
    });
    const withoutComments = queries[1].replace(/^\s*--.*$/gm, '').trim();
    expect(withoutComments).toMatch(
      /^LOCK TABLE inbox_conversations IN EXCLUSIVE MODE;/,
    );
    expect(queries[0]).toBe('BEGIN');
  });

  it('rolls back, closes the connection and rethrows when the SQL fails', async () => {
    const { connect, client, queries } = fakeConnect();
    client.query.mockImplementation((text: string) => {
      queries.push(text);
      return text === SQL
        ? Promise.reject(new Error('boom'))
        : Promise.resolve({ rows: [] });
    });
    await expect(
      runBackfill({
        databaseUrl: 'postgres://u@localhost/db',
        confirmedProduction: false,
        sqlPath: sqlFile(SQL),
        connect,
      }),
    ).rejects.toThrow('boom');
    expect(queries).toEqual(['BEGIN', SQL, 'ROLLBACK']);
    expect(client.end).toHaveBeenCalled();
  });
});
