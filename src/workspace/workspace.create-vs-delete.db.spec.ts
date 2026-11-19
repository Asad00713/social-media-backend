import { readFileSync } from 'fs';
import { join } from 'path';
import { Client, Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../drizzle/schema';
import type { DbType } from '../drizzle/db';
import {
  assertLocalDatabase,
  describeDb,
} from '../planner/testing/rollback-db';
import { WorkspaceService } from './workspace.service';

/**
 * Workspace create racing account delete, on TWO real connections.
 *
 * withRollbackDb runs everything on one connection, which cannot show a lock
 * wait, so this spec commits for real. To leave the developer's database as
 * it was, it works in a scratch schema of its own: copies of the tables the
 * race touches (LIKE public.*), the migrations that shape them applied INTO
 * that schema (search_path puts it first), dropped in afterAll.
 *
 * Connection A plays AccountDeletionService.deleteInTransaction: BEGIN,
 * users row FOR UPDATE, ... deleted_at stamped, COMMIT. Connection B is
 * WorkspaceService.create through drizzle.
 */

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'drizzle', 'migrations');
/** The files that add the columns the drizzle schema of these tables names. */
const MIGRATIONS = [
  '0070_users_sessions_revoked_at.sql',
  '0071_users_pending_email.sql',
  '0073_users_email_changed_at.sql',
  '0080_member_soft_removal.sql',
  '0088_soft_delete_posts_workspaces.sql',
  '0092_user_account_settings.sql',
  '0093_workspace_settings.sql',
];
const COPIED_TABLES = ['users', 'workspace', 'workspace_invitations', 'posts'];

const SCHEMA = `race_${Math.random().toString(36).slice(2, 10)}`;
const url = () => assertLocalDatabase(process.env.DATABASE_URL);
const searchPath = `-c search_path=${SCHEMA},public`;

let setup: Client;
let poolB: Pool;
let pidB: number;
let service: WorkspaceService;

function makeService(db: DbType): WorkspaceService {
  const svc = new WorkspaceService(
    db,
    { enforceWorkspaceLimit: jest.fn().mockResolvedValue(undefined) } as never,
    {
      findOne: jest.fn().mockResolvedValue({ lastAccessedWorkspaceId: 'x' }),
      setLastAccessedWorkspace: jest.fn(),
    } as never,
    { createSubscription: jest.fn().mockResolvedValue(undefined) } as never,
    {} as never,
    {} as never,
    { seedInBackground: jest.fn() } as never,
    {} as never,
    {} as never,
    {} as never,
  );
  // workspace_usage is not copied into the scratch schema; not the unit here.
  jest
    .spyOn(
      svc as unknown as { seedWorkspaceUsage: () => Promise<void> },
      'seedWorkspaceUsage',
    )
    .mockResolvedValue(undefined);
  return svc;
}

async function seedUser(): Promise<string> {
  const r = await setup.query<{ id: string }>(
    `INSERT INTO users (email) VALUES ($1) RETURNING id`,
    [`race-${Math.random().toString(36).slice(2)}@example.test`],
  );
  return r.rows[0].id;
}

/** Resolves once connection B is waiting on a lock it has not been granted. */
async function untilBWaits(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const r = await setup.query<{ n: string }>(
      `SELECT count(*) AS n FROM pg_locks WHERE pid = $1 AND NOT granted`,
      [pidB],
    );
    if (Number(r.rows[0].n) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('connection B never waited on a lock');
}

async function ownedCount(ownerId: string): Promise<number> {
  const r = await setup.query<{ n: string }>(
    `SELECT count(*) AS n FROM workspace WHERE owner_id = $1`,
    [ownerId],
  );
  return Number(r.rows[0].n);
}

describeDb(
  'WorkspaceService.create vs account delete (two connections)',
  () => {
    beforeAll(async () => {
      setup = new Client({ connectionString: url(), options: searchPath });
      await setup.connect();
      await setup.query(`CREATE SCHEMA ${SCHEMA}`);
      for (const table of COPIED_TABLES) {
        await setup.query(
          `CREATE TABLE ${SCHEMA}.${table} (LIKE public.${table} INCLUDING ALL)`,
        );
      }
      // LIKE copies no foreign key; the real one takes KEY SHARE on users too.
      await setup.query(
        `ALTER TABLE ${SCHEMA}.workspace
         ADD FOREIGN KEY (owner_id) REFERENCES ${SCHEMA}.users (id)`,
      );
      for (const file of MIGRATIONS) {
        await setup.query('BEGIN');
        await setup.query(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
        await setup.query('COMMIT');
      }
      poolB = new Pool({
        connectionString: url(),
        max: 1,
        options: searchPath,
      });
      const r = await poolB.query<{ pid: number }>(
        `SELECT pg_backend_pid() AS pid`,
      );
      pidB = r.rows[0].pid;
      service = makeService(drizzle(poolB, { schema }) as unknown as DbType);
    });

    afterAll(async () => {
      await poolB?.end();
      if (setup) {
        await setup.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
        await setup.end();
      }
    });

    async function deleterHoldsUser(userId: string): Promise<Client> {
      const a = new Client({ connectionString: url(), options: searchPath });
      await a.connect();
      await a.query('BEGIN');
      await a.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [userId]);
      return a;
    }

    it('a create that waited on a delete which then committed is refused 401 ACCOUNT_DELETED, and writes no workspace', async () => {
      const userId = await seedUser();
      const a = await deleterHoldsUser(userId);
      try {
        const create = service.create({ name: `Race ${SCHEMA} 1` }, userId);
        const settled = create.then(
          () => null,
          (e: unknown) => e,
        );
        await untilBWaits();
        await a.query(`UPDATE users SET deleted_at = now() WHERE id = $1`, [
          userId,
        ]);
        await a.query('COMMIT');

        const error = await settled;
        expect(error).toMatchObject({
          status: 401,
          response: { code: 'ACCOUNT_DELETED' },
        });
        expect(await ownedCount(userId)).toBe(0);
      } finally {
        await a.end();
      }
    });

    it('a create that waited on a delete which rolled back goes ahead', async () => {
      const userId = await seedUser();
      const a = await deleterHoldsUser(userId);
      try {
        const create = service.create({ name: `Race ${SCHEMA} 2` }, userId);
        await untilBWaits();
        await a.query('ROLLBACK');

        await expect(create).resolves.toMatchObject({ ownerId: userId });
        expect(await ownedCount(userId)).toBe(1);
      } finally {
        await a.end();
      }
    });

    it('a create on an account already deleted is refused without waiting', async () => {
      const userId = await seedUser();
      await setup.query(`UPDATE users SET deleted_at = now() WHERE id = $1`, [
        userId,
      ]);
      await expect(
        service.create({ name: `Race ${SCHEMA} 3` }, userId),
      ).rejects.toMatchObject({ response: { code: 'ACCOUNT_DELETED' } });
      expect(await ownedCount(userId)).toBe(0);
    });
  },
);
