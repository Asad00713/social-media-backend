import type { DbType } from '../drizzle/db';
import type { LabelsService } from './labels.service';
import { PostLabelsService } from './post-labels.service';

type Rows = { rows: Array<Record<string, string>> };

/**
 * A db whose every `execute` answers the next queued result, inside a
 * `transaction` that just runs the callback. Enough to steer `setForPost`
 * down a path the single-connection DB harness cannot stage.
 */
function fakeDb(results: Rows[]) {
  const queue = [...results];
  const execute = jest.fn(() => Promise.resolve(queue.shift() ?? { rows: [] }));
  const tx = { execute };
  const db = {
    transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) =>
      fn(tx),
    ),
  };
  return { db, execute };
}

const labels = {
  nextColor: jest.fn(() => Promise.resolve('blue')),
} as unknown as LabelsService;

const POST = { rows: [{ id: 'p1' }] };
const NONE = { rows: [] };

describe('PostLabelsService.setForPost: a created name that vanishes', () => {
  it('retries once when the conflicting label is gone by the re-select', async () => {
    const { db } = fakeDb([
      // Attempt 1: post found, name not live, insert loses the conflict,
      // re-select finds nothing (the winner was deleted or merged away).
      POST,
      NONE,
      NONE,
      NONE,
      // Attempt 2: the name now resolves; delete, insert.
      POST,
      { rows: [{ id: 'l1', key: 'promo' }] },
      NONE,
      NONE,
    ]);
    const svc = new PostLabelsService(db as unknown as DbType, labels);
    await expect(svc.setForPost('w1', 'p1', ['Promo'])).resolves.toBe(
      undefined,
    );
    expect(db.transaction).toHaveBeenCalledTimes(2);
  });

  it('gives up with a clear error, not a TypeError, when it vanishes twice', async () => {
    const { db } = fakeDb([POST, NONE, NONE, NONE, POST, NONE, NONE, NONE]);
    const svc = new PostLabelsService(db as unknown as DbType, labels);
    await expect(svc.setForPost('w1', 'p1', ['Promo'])).rejects.toThrow(
      'Label "Promo" vanished while it was being created',
    );
    expect(db.transaction).toHaveBeenCalledTimes(2);
  });
});
