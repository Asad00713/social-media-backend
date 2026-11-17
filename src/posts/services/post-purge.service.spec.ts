const selected: Array<Record<string, unknown>> = [];
const deleteWheres: unknown[] = [];
const returned: Array<Record<string, unknown>> = [];

jest.mock('../../drizzle/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve(selected) }),
      }),
    }),
    delete: () => ({
      where: (predicate: unknown) => {
        deleteWheres.push(predicate);
        return { returning: () => Promise.resolve(returned) };
      },
    }),
  },
}));

import { PostPurgeService } from './post-purge.service';
import { purgeCutoff } from '../soft-delete/soft-delete';

const NOW = new Date('2026-11-17T12:00:00.000Z');

/** Drizzle `SQL` objects are circular, so flatten rather than JSON.stringify. */
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
  returned.length = 0;
});

describe('PostPurgeService', () => {
  it('purges nothing when nothing has expired', async () => {
    await expect(new PostPurgeService().purge(NOW)).resolves.toBe(0);
    expect(deleteWheres).toHaveLength(0);
  });

  it('deletes the expired posts in one statement', async () => {
    selected.push({ id: 'a' }, { id: 'b' }, { id: 'c' });
    returned.push({ id: 'a' }, { id: 'b' }, { id: 'c' });

    await expect(new PostPurgeService().purge(NOW)).resolves.toBe(3);
    expect(deleteWheres).toHaveLength(1);
  });

  /**
   * The guard that protects a restore. A post can be brought back between the
   * read and the delete by clearing deleted_at; matching on id alone would
   * purge it anyway.
   */
  it('re-checks deleted_at in the delete, not only in the read', async () => {
    selected.push({ id: 'a' });
    returned.push({ id: 'a' });

    await new PostPurgeService().purge(NOW);

    expect(describeSql(deleteWheres[0])).toContain('deleted_at');
  });

  /** It reports what the database actually removed, not what it asked for. */
  it('counts the rows the delete returned, not the rows it selected', async () => {
    selected.push({ id: 'a' }, { id: 'b' });
    returned.push({ id: 'a' }); // 'b' was restored in between

    await expect(new PostPurgeService().purge(NOW)).resolves.toBe(1);
  });

  it('uses the shared 30-day window', () => {
    expect(purgeCutoff(NOW).toISOString()).toBe('2026-10-18T12:00:00.000Z');
  });
});
