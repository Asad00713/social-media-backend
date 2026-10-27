import 'dotenv/config';
import { Client } from 'pg';
import { sql } from 'drizzle-orm';
import { describeDb, withRollbackDb } from './rollback-db';

const PROBE = `rollback_probe_${Math.random().toString(36).slice(2, 10)}`;

describeDb('withRollbackDb', () => {
  let fresh: Client;

  beforeAll(async () => {
    fresh = new Client({ connectionString: process.env.DATABASE_URL });
    await fresh.connect();
  });

  afterAll(async () => {
    // Clean up by hand in case the harness leaked the probe table.
    await fresh.query(`DROP TABLE IF EXISTS ${PROBE}`);
    await fresh.end();
  });

  it('rolls back DDL issued through a nested db.transaction()', async () => {
    await withRollbackDb([], async (db) => {
      await db.transaction(async (t) => {
        await t.execute(sql.raw(`CREATE TABLE ${PROBE} (x int)`));
      });
    });
    const r = await fresh.query<{ reg: string | null }>(
      `SELECT to_regclass($1) AS reg`,
      [PROBE],
    );
    expect(r.rows[0].reg).toBeNull();
  });

  it('rethrows an error thrown by fn', async () => {
    await expect(
      withRollbackDb([], () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
  });

  it('returns the value fn resolves with', async () => {
    await expect(withRollbackDb([], () => Promise.resolve(42))).resolves.toBe(
      42,
    );
  });
});
