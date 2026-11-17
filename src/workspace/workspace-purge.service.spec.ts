const selected: Array<Record<string, unknown>> = [];
const deleteWheres: unknown[] = [];

jest.mock('../drizzle/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve(selected) }),
      }),
    }),
    delete: () => ({
      where: (predicate: unknown) => {
        deleteWheres.push(predicate);
        return Promise.resolve();
      },
    }),
  },
}));

import { WorkspacePurgeService } from './workspace-purge.service';
import {
  purgeCutoff,
  SOFT_DELETE_RETENTION_DAYS,
} from '../posts/soft-delete/soft-delete';

const NOW = new Date('2026-11-17T12:00:00.000Z');

/**
 * Flattens a drizzle `SQL` into readable text. Its chunks hold column objects
 * and raw operator strings and the graph is circular, so JSON.stringify
 * cannot be used.
 */
function describeSql(node: unknown, depth = 0): string {
  if (depth > 6 || node == null) return '';
  if (typeof node === 'string') return node;
  const any = node as Record<string, any>;
  if (typeof any.name === 'string') return any.name;
  if (Array.isArray(any.queryChunks)) {
    return any.queryChunks
      .map((c: unknown) => describeSql(c, depth + 1))
      .join(' ');
  }
  if (Array.isArray(any.value)) {
    return any.value.map((c: unknown) => describeSql(c, depth + 1)).join(' ');
  }
  return '';
}

beforeEach(() => {
  selected.length = 0;
  deleteWheres.length = 0;
});

describe('WorkspacePurgeService', () => {
  it('purges nothing when nothing has expired', async () => {
    await expect(new WorkspacePurgeService().purge(NOW)).resolves.toBe(0);
    expect(deleteWheres).toHaveLength(0);
  });

  it('deletes each expired workspace', async () => {
    selected.push({ id: 'ws-1', name: 'One' }, { id: 'ws-2', name: 'Two' });

    await expect(new WorkspacePurgeService().purge(NOW)).resolves.toBe(2);
    expect(deleteWheres).toHaveLength(2);
  });

  /**
   * One at a time, not one statement: each delete is a 50-table cascade, and
   * batching them would hold locks across all of those tables at once.
   */
  it('deletes one workspace per statement', async () => {
    selected.push({ id: 'a' }, { id: 'b' }, { id: 'c' });

    await new WorkspacePurgeService().purge(NOW);

    expect(deleteWheres).toHaveLength(3);
  });

  /**
   * The guard that protects a restore. Between reading the batch and deleting
   * a row, someone can clear `deleted_at` to bring the workspace back. The
   * delete re-checks the condition, so a restored workspace survives — if it
   * only matched on id, the purge would delete a live workspace.
   */
  it('re-checks deleted_at in the delete itself, not only in the read', async () => {
    selected.push({ id: 'ws-1' });

    await new WorkspacePurgeService().purge(NOW);

    const sql = describeSql(deleteWheres[0]);
    expect(sql).toContain('deleted_at');
    expect(sql).toContain('id');
  });

  /** One failed cascade must not abandon the rest of the night's batch. */
  it('keeps going when one delete fails', async () => {
    selected.push({ id: 'bad' }, { id: 'good' });

    const db = (jest.requireMock('../drizzle/db') as { db: any }).db;
    const realDelete = db.delete;
    let first = true;
    db.delete = () => ({
      where: (p: unknown) => {
        if (first) {
          first = false;
          return Promise.reject(new Error('deadlock detected'));
        }
        deleteWheres.push(p);
        return Promise.resolve();
      },
    });

    const purged = await new WorkspacePurgeService().purge(NOW);
    db.delete = realDelete;

    expect(purged).toBe(1);
    expect(deleteWheres).toHaveLength(1);
  });

  it('uses the shared 30-day retention window', () => {
    expect(SOFT_DELETE_RETENTION_DAYS).toBe(30);
    expect(purgeCutoff(NOW).toISOString()).toBe('2026-10-18T12:00:00.000Z');
  });
});
