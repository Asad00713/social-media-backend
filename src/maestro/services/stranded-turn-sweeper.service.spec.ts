/**
 * The db module is a live pool at import time, so it is replaced wholesale.
 * These capture what the sweeper decided to write per row, which is its entire
 * contract: bookkeeping only, never a re-run.
 */
const selected: unknown[] = [];
const updates: { id: unknown; set: unknown }[] = [];
const deletes: unknown[] = [];
/** Predicates the sweep built, so a test can assert what it filtered on. */
const wherePredicates: unknown[] = [];

/**
 * Flattens a drizzle `SQL` into readable text. Its chunks hold column objects
 * and raw operator strings, and the graph is circular, so JSON.stringify
 * cannot be used.
 */
function describeSql(node: unknown, depth = 0): string {
  if (depth > 8 || node == null) return '';
  if (typeof node === 'string') return node;
  const anyNode = node as Record<string, any>;
  if (typeof anyNode.name === 'string') return anyNode.name; // a column
  if (Array.isArray(anyNode.queryChunks)) {
    return anyNode.queryChunks
      .map((c: unknown) => describeSql(c, depth + 1))
      .join(' ');
  }
  if (Array.isArray(anyNode.value)) {
    return anyNode.value
      .map((c: unknown) => describeSql(c, depth + 1))
      .join(' ');
  }
  return '';
}

/**
 * Drizzle's `.where()` receives an already-built predicate, so the id a write
 * targets is not visible from it. The fakes below instead record the predicate
 * and the test matches on the row it fed in — there is one row per case.
 */
jest.mock('../../drizzle/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (predicate: unknown) => {
          wherePredicates.push(predicate);
          return { limit: () => Promise.resolve(selected) };
        },
      }),
    }),
    update: () => ({
      set: (set: unknown) => ({
        where: (predicate: unknown) => {
          updates.push({ id: predicate, set });
          return Promise.resolve();
        },
      }),
    }),
    delete: () => ({
      where: (predicate: unknown) => {
        deletes.push(predicate);
        return Promise.resolve();
      },
    }),
  },
}));

import { StrandedTurnSweeperService } from './stranded-turn-sweeper.service';

function runningRow(over: Record<string, unknown> = {}) {
  return {
    id: 'turn-1',
    content: 'Half an answer',
    metadata: {
      maestroTurn: {
        status: 'running',
        startedAt: '2026-11-23T06:00:00.000Z',
        model: 'claude-haiku-4-5',
      },
    },
    ...over,
  };
}

describe('StrandedTurnSweeperService', () => {
  let service: StrandedTurnSweeperService;

  beforeEach(() => {
    selected.length = 0;
    updates.length = 0;
    deletes.length = 0;
    wherePredicates.length = 0;
    service = new StrandedTurnSweeperService();
  });

  it('does nothing when no turn is stranded', async () => {
    // The expected outcome on healthy data. A pass that finds something is
    // what is worth looking at.
    expect(await service.sweep()).toBe(0);
    expect(updates).toHaveLength(0);
    expect(deletes).toHaveLength(0);
  });

  it('only ever considers assistant rows still marked running', async () => {
    // Without the status test it would reopen finished turns; without the role
    // test it would delete the user's own messages.
    await service.sweep();

    const predicate = describeSql(wherePredicates[0]);
    expect(predicate).toContain('role');
    expect(predicate).toContain('maestroTurn');
    expect(predicate).toContain('running');
    expect(predicate).toContain('created_at');
  });

  it('closes a stranded turn as failed and keeps what it wrote', async () => {
    // The turn really did produce this text — a crash is not a reason to
    // throw away an answer the user already saw.
    selected.push(runningRow());

    expect(await service.sweep()).toBe(1);

    expect(deletes).toHaveLength(0);
    const [write] = updates;
    const meta = (write.set as { metadata: Record<string, any> }).metadata;
    expect(meta.maestroTurn.status).toBe('failed');
    expect(meta.maestroTurn.endedAt).toBeDefined();
  });

  it('keeps the rest of the turn metadata when it closes one', async () => {
    // Media, references and the start time are all in the same blob. A
    // status write that replaced it would erase the reply's attachments.
    selected.push(
      runningRow({
        metadata: {
          maestroMedia: { items: [{ url: 'https://example.test/a.jpg' }] },
          maestroTurn: {
            status: 'running',
            startedAt: '2026-11-23T06:00:00.000Z',
            model: 'claude-haiku-4-5',
          },
        },
      }),
    );

    await service.sweep();

    const meta = (updates[0].set as { metadata: Record<string, any> }).metadata;
    expect(meta.maestroMedia.items).toHaveLength(1);
    expect(meta.maestroTurn.startedAt).toBe('2026-11-23T06:00:00.000Z');
    expect(meta.maestroTurn.model).toBe('claude-haiku-4-5');
  });

  it('deletes a stranded turn that never wrote anything', async () => {
    // An empty assistant bubble reads as Maestro having answered with
    // silence, which is worse than the turn simply not being there.
    selected.push(runningRow({ content: null }));

    expect(await service.sweep()).toBe(1);

    expect(deletes).toHaveLength(1);
    expect(updates).toHaveLength(0);
  });

  it('treats whitespace-only content as nothing written', async () => {
    selected.push(runningRow({ content: '   \n ' }));

    await service.sweep();

    expect(deletes).toHaveLength(1);
    expect(updates).toHaveLength(0);
  });

  it('never re-runs the turn it is closing', async () => {
    // The whole safety property: the sweeper writes bookkeeping. A turn the
    // user navigated away from must not suddenly produce a reply, and the
    // tokens for a second attempt were never spent.
    selected.push(runningRow());

    await service.sweep();

    // Only ever a metadata write — no insert of a new reply, and the content
    // column is left exactly as the dead process left it.
    expect(Object.keys(updates[0].set as object)).toEqual(['metadata']);
  });

  it('carries on after one row fails to close', async () => {
    // A single bad row must not strand every row behind it; the next pass
    // retries it.
    selected.push(runningRow({ id: 'bad' }), runningRow({ id: 'good' }));
    // The failure is logged, which is the point — silence it so the run is
    // readable rather than asserting on the log line's wording.
    const logger = (service as unknown as { logger: { error: unknown } })
      .logger;
    jest.spyOn(logger as never, 'error').mockImplementation(() => undefined);

    // The first update throws, the second must still be attempted.
    const dbModule = jest.requireMock('../../drizzle/db') as {
      db: { update: () => unknown };
    };
    const realUpdate = dbModule.db.update;
    let call = 0;
    dbModule.db.update = () => ({
      set: (set: unknown) => ({
        where: (predicate: unknown) => {
          if (++call === 1) return Promise.reject(new Error('db down'));
          updates.push({ id: predicate, set });
          return Promise.resolve();
        },
      }),
    });

    const repaired = await service.sweep();

    dbModule.db.update = realUpdate;
    jest.restoreAllMocks();

    expect(repaired).toBe(1);
    expect(updates).toHaveLength(1);
  });
});
