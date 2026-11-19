import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A post and the record of its creation commit together.
 *
 * `createPost` wrote the `posts` row and then its `post_history` row as two
 * separate statements on the pool. A crash or a dropped connection between
 * them left a post whose history had no `created` entry.
 *
 * That is not only untidiness. The stranded-post sweeper reconstructs what
 * actually happened to a post FROM `post_history` — a `published` row there is
 * its proof that content reached a platform — so a post with a hole in its
 * history is a post the recovery machinery can reason about wrongly.
 *
 * ## What must stay OUT of the transaction
 *
 * The publish job. BullMQ writes to Redis, which no Postgres transaction can
 * roll back, so enqueueing inside the transaction would risk a live job for a
 * post that never committed — the job fires, finds nothing, and the failure is
 * harder to see than the one being fixed. It is enqueued after the commit, and
 * a post whose job never made it is re-armed by the reconciler, which exists
 * for exactly that gap.
 *
 * ## Why this is asserted on the source
 *
 * The behavioural specs for `createPost` (`post.service.approval.spec.ts`,
 * `post.service.guest-rules.spec.ts`) drive it through a fake `db` whose
 * `transaction` hands the callback the fake itself. That is the right fake —
 * writes inside land where the assertions can see them — but it means `tx` and
 * `db` are the same object there, so no behavioural assertion in that harness
 * can tell "wrote on the transaction" from "wrote on the pool". Mutation
 * proved it: dropping `tx` from the history call left 26 tests green.
 *
 * A fake that COULD tell them apart would have to model two connections and
 * rollback, which is a database. So the property is pinned here instead.
 */

const source = readFileSync(join(__dirname, 'post.service.ts'), 'utf8');

/** The body of `createPost`, where the writes live. */
function createPostBody(): string {
  const start = source.indexOf('async createPost(');
  expect(start).toBeGreaterThan(-1);
  // Ends at the next method at the same indentation.
  const end = source.indexOf('\n  async ', start + 10);
  const privateEnd = source.indexOf('\n  private async ', start + 10);
  const stop = [end, privateEnd].filter((i) => i > -1).sort((a, b) => a - b)[0];
  return source.slice(start, stop === undefined ? undefined : stop);
}

describe('createPost writes the post and its history in one transaction', () => {
  const body = createPostBody();

  it('opens a transaction', () => {
    expect(body).toMatch(/await db\.transaction\(async \(tx\) =>/);
  });

  it('inserts the post on the transaction, not the pool', () => {
    // `tx.insert(posts)` — a bare `db.insert(posts)` inside the callback would
    // run on a different connection and defeat the whole thing.
    expect(body).toMatch(/tx\s*\.insert\(posts\)/);
    expect(body).not.toMatch(/db\s*\.insert\(posts\)/);
  });

  /**
   * The mutation that survived until this file existed: `recordHistory`
   * defaults its executor to the pool, so omitting `tx` is silent.
   */
  it('passes the transaction to recordHistory', () => {
    const call = body.slice(
      body.indexOf('this.recordHistory('),
      body.indexOf(');', body.indexOf('this.recordHistory(')),
    );
    expect(call).not.toBe('');
    expect(call).toMatch(/\btx\b/);
  });

  it('the history insert honours a caller-supplied executor', () => {
    // Without this, passing `tx` above would compile and do nothing.
    const start = source.indexOf('private async recordHistory');
    expect(start).toBeGreaterThan(-1);
    const method = source.slice(start, source.indexOf('\n  }', start));
    expect(method).toMatch(/executor:\s*Pick<typeof db, 'insert'>\s*=\s*db/);
    expect(method).toMatch(/await executor\.insert\(postHistory\)/);
  });

  /**
   * The queue must not be inside the transaction. Asserted by position: the
   * enqueue has to come after the transaction callback closes.
   */
  it('enqueues the publish job only after the commit', () => {
    const txStart = body.indexOf('await db.transaction(');
    const schedule = body.indexOf('this.schedulePublishJob(');
    expect(txStart).toBeGreaterThan(-1);

    if (schedule === -1) return; // no scheduling in this method shape
    // The callback's closing `});` — everything after it is post-commit.
    const txEnd = body.indexOf('\n    });', txStart);
    expect(txEnd).toBeGreaterThan(txStart);
    expect({ enqueuedAfterCommit: schedule > txEnd }).toEqual({
      enqueuedAfterCommit: true,
    });
  });
});
