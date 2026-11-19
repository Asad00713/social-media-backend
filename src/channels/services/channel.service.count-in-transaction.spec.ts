import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `channels_count` is written inside the transaction that writes the channel.
 *
 * `createChannel` has two paths that add a billable channel — reviving a
 * soft-disconnected row, and inserting a new one — and each runs in a
 * `db.transaction` that holds `pg_advisory_xact_lock(account)` for its whole
 * lifetime, so a concurrent connect on the same account waits rather than
 * racing past the ceiling.
 *
 * The revival path counted the slot with its `tx`. The insert path did not: it
 * committed, then incremented on the pool, outside both the transaction and
 * its lock. A crash in between left a connected channel that `channels_count`
 * did not know about, so the customer kept a free slot and every limit check
 * reading that column was wrong until something recalculated it.
 *
 * `pg_advisory_xact_lock` is released when the transaction ends, so passing
 * `tx` is the only way to be counted under it — the same distinction the
 * usage-counter work turned on: `usage.service.ts` imported the module-level
 * `db` and therefore ran its increment on a different connection than the lock
 * that was supposed to protect it.
 *
 * Asserted on the source. Driving `createChannel` behaviourally here would
 * mean standing up channels, workspace usage, plans, the account-channel
 * ceiling and a transaction-aware `db` fake to observe which executor one
 * statement used — and a fake that treats `tx` and `db` alike cannot see the
 * difference at all, which is the whole property. Mutation-testing confirmed
 * the gap: dropping `tx` from the insert path left 1331 channel tests green.
 */

const THIS_FILE = join(__dirname, 'channel.service.ts');
const source = readFileSync(THIS_FILE, 'utf8');

/** Every `incrementChannelCount` call, with the line it sits on. */
function incrementCalls(): Array<{ line: number; text: string }> {
  return source
    .split('\n')
    .map((text, i) => ({ line: i + 1, text }))
    .filter(({ text }) => /this\.incrementChannelCount\(/.test(text));
}

describe('a billable channel is counted inside its transaction', () => {
  const calls = incrementCalls();

  it('there are exactly two sites that count a new channel', () => {
    // Revival and insert. A third would be a path this spec has not been
    // told about — and the question "does it pass tx" has to be answered for
    // it too, so the count is pinned deliberately.
    expect(calls.map((c) => c.line.toString())).toHaveLength(2);
  });

  it.each([0, 1])('site %i passes its transaction', (index) => {
    const call = calls[index];
    expect(call).toBeDefined();
    // `incrementChannelCount(workspaceId, tx)` — the second argument is the
    // executor. Without it the helper falls back to the module-level `db`,
    // which is a different connection and so outside the advisory lock.
    expect({
      line: call.line,
      passesTx: /,\s*tx\s*\)/.test(call.text),
    }).toEqual({ line: call.line, passesTx: true });
  });

  /**
   * The helper has to keep accepting an executor, or passing `tx` at the call
   * sites would silently do nothing.
   */
  it('incrementChannelCount takes an executor, defaulting to db', () => {
    const start = source.indexOf('private async incrementChannelCount');
    expect(start).toBeGreaterThan(-1);
    const signature = source.slice(start, source.indexOf(')', start));
    expect(signature).toMatch(/executor:\s*Pick<typeof db, 'update'>\s*=\s*db/);
  });

  /**
   * And it has to increment in SQL over the column, not from a value this
   * process read — the lost-increment shape fixed in the usage counters.
   */
  it('increments with a SQL expression over the column', () => {
    const start = source.indexOf('private async incrementChannelCount');
    const body = source.slice(start, source.indexOf('\n  }', start));
    expect(body).toMatch(/channelsCount:\s*sql`/);
    expect(body).toMatch(/workspaceUsage\.channelsCount\}\s*\+\s*1/);
  });
});
