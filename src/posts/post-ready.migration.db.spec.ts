import { describeDb, withRollbackDb } from '../planner/testing/rollback-db';

const MIGRATION = '0041_post_ready.sql';
interface R {
  ready_at: Date | null;
  ready_by_id: string | null;
}

async function seed(client: import('pg').PoolClient) {
  const tag = Math.random().toString(36).slice(2, 10);
  const owner = await client.query<{ id: string }>(
    `INSERT INTO users (email) VALUES ($1) RETURNING id`,
    [`owner-${tag}@example.test`],
  );
  const marker = await client.query<{ id: string }>(
    `INSERT INTO users (email) VALUES ($1) RETURNING id`,
    [`marker-${tag}@example.test`],
  );
  const ws = await client.query<{ id: string }>(
    `INSERT INTO workspace (name, slug, owner_id) VALUES ($1, $2, $3) RETURNING id`,
    ['ws', `ws-${tag}`, owner.rows[0].id],
  );
  return {
    ownerId: owner.rows[0].id,
    markerId: marker.rows[0].id,
    workspaceId: ws.rows[0].id,
  };
}

describeDb('0041_post_ready migration', () => {
  it('adds the ready columns and the draft_ready enum value', () =>
    withRollbackDb([MIGRATION], async (_db, client) => {
      const cols = await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'posts' AND column_name IN ('ready_at', 'ready_by_id')`,
      );
      expect(cols.rows.map((r) => r.column_name).sort()).toEqual([
        'ready_at',
        'ready_by_id',
      ]);
      const en = await client.query(
        `SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
         WHERE t.typname = 'notification_type' AND e.enumlabel = 'draft_ready'`,
      );
      expect(en.rowCount).toBe(1);
    }));

  it('clears ready_at and ready_by_id when the post leaves draft', () =>
    withRollbackDb([MIGRATION], async (_db, client) => {
      const s = await seed(client);
      const p = await client.query<{ id: string }>(
        `INSERT INTO posts (workspace_id, created_by_id, status, ready_at, ready_by_id)
         VALUES ($1, $2, 'draft', now(), $3) RETURNING id`,
        [s.workspaceId, s.ownerId, s.markerId],
      );
      await client.query(
        `UPDATE posts SET status = 'scheduled' WHERE id = $1`,
        [p.rows[0].id],
      );
      const r = await client.query<R>(
        `SELECT ready_at, ready_by_id FROM posts WHERE id = $1`,
        [p.rows[0].id],
      );
      expect(r.rows[0].ready_at).toBeNull();
      expect(r.rows[0].ready_by_id).toBeNull();
    }));

  it('keeps ready_at when only the content of a ready draft changes', () =>
    withRollbackDb([MIGRATION], async (_db, client) => {
      const s = await seed(client);
      const p = await client.query<{ id: string }>(
        `INSERT INTO posts (workspace_id, created_by_id, status, ready_at, ready_by_id)
         VALUES ($1, $2, 'draft', now(), $3) RETURNING id`,
        [s.workspaceId, s.ownerId, s.markerId],
      );
      await client.query(`UPDATE posts SET content = 'edited' WHERE id = $1`, [
        p.rows[0].id,
      ]);
      const r = await client.query<R>(
        `SELECT ready_at, ready_by_id FROM posts WHERE id = $1`,
        [p.rows[0].id],
      );
      expect(r.rows[0].ready_at).not.toBeNull();
      expect(r.rows[0].ready_by_id).toBe(s.markerId);
    }));

  it('sets ready_by_id NULL when the marking user is deleted, keeping ready_at', () =>
    withRollbackDb([MIGRATION], async (_db, client) => {
      const s = await seed(client);
      const p = await client.query<{ id: string }>(
        `INSERT INTO posts (workspace_id, created_by_id, status, ready_at, ready_by_id)
         VALUES ($1, $2, 'draft', now(), $3) RETURNING id`,
        [s.workspaceId, s.ownerId, s.markerId],
      );
      await client.query(`DELETE FROM users WHERE id = $1`, [s.markerId]);
      const r = await client.query<R>(
        `SELECT ready_at, ready_by_id FROM posts WHERE id = $1`,
        [p.rows[0].id],
      );
      expect(r.rows[0].ready_by_id).toBeNull();
      expect(r.rows[0].ready_at).not.toBeNull();
    }));
});
