import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The counter race.
 *
 * `updateUsageCount` read `workspace_usage`, added the delta in JavaScript and
 * wrote the result back. Two accepts landing together both read 5 and both
 * wrote 6, so one seat was lost permanently — and `members_count` is what
 * seat limits and billing are measured against, so the workspace silently kept
 * a seat it had not paid for. The same method carries `channels_count`.
 *
 * A lost increment leaves no trace: the row is internally consistent, just
 * wrong, and only a recalculation would ever notice.
 *
 * Asserting through a fake `db` would mean reproducing Drizzle's builder well
 * enough to tell `5 + 1` from `members_count + 1`, which is most of the thing
 * being tested. The property is visible in the source instead: the delta must
 * reach Postgres as an expression over the column, never as a number computed
 * here.
 */

const SRC = join(__dirname, '..', '..');

function read(relative: string): string {
  return readFileSync(join(SRC, relative), 'utf8');
}

const usage = read('billing/services/usage.service.ts');
const members = read('workspace-members/workspace-members.service.ts');

/** The body of `updateUsageCount`, where the arithmetic lives. */
function updateUsageCountBody(): string {
  const start = usage.indexOf('private async updateUsageCount');
  expect(start).toBeGreaterThan(-1);
  // Ends at the next method at the same indentation.
  const end = usage.indexOf('\n  async ', start);
  return usage.slice(start, end === -1 ? undefined : end);
}

describe('the usage counters are incremented by Postgres, not by us', () => {
  const body = updateUsageCountBody();

  /**
   * The delta must reach Postgres as an expression over the column, so the
   * read and the write happen under one row lock.
   *
   * Asserted on the statement rather than per column: the implementation
   * picks the column once by resource type, so both counters share one
   * expression. What matters is that the expression references a column and
   * carries the delta — not which spelling the reference has.
   */
  it('applies the delta inside a SQL expression over a column', () => {
    const template = body.match(/sql`[^`]*`/);
    expect(template).not.toBeNull();
    const text = template![0];
    expect(text).toMatch(/\$\{column\}|workspaceUsage\.\w+Count/);
    expect(text).toMatch(/\$\{delta\}/);
  });

  it.each([
    ['members', 'membersCount'],
    ['channels', 'channelsCount'],
  ])('%s is assigned that expression, not a number', (_label, column) => {
    // `<column>: bumped` — a reference to the SQL expression above. A literal
    // or a local arithmetic result is the bug.
    expect(body).toMatch(new RegExp(column + ':\\s*\\w+\\b'));
    expect(body).not.toMatch(new RegExp(column + ':\\s*\\d'));
    expect(body).not.toMatch(
      new RegExp(column + ':\\s*Math\\.(max|min)'),
    );
  });

  /**
   * The exact shape of the bug: a value derived from a row this process read.
   * `quantityAfter` was computed as `usage.<col> + delta` and assigned
   * directly, which is what made two writers collide.
   */
  it('never assigns a value computed in JavaScript', () => {
    expect(body).not.toMatch(/membersCount: quantityAfter/);
    expect(body).not.toMatch(/channelsCount: quantityAfter/);
  });

  /**
   * The counter must not go negative — two concurrent removals could take it
   * below zero, and a negative seat count would read as free capacity. The
   * old code clamped with Math.max(0, …); the clamp has to move into the
   * statement with the arithmetic, or it is not applied under concurrency.
   */
  it('clamps at zero inside the statement', () => {
    expect(body).toMatch(/GREATEST\(\s*0/);
  });
});

describe('the member increment runs inside the seat lock', () => {
  /**
   * `lockWorkspaceSeats` takes `pg_advisory_xact_lock`, which is held for the
   * rest of the *transaction*. `usage.service.ts` imported the module-level
   * `db`, so the increment ran on a different connection — outside both the
   * transaction and its lock. The comment at the call site said the opposite:
   * "Counted before the lock is released, so the next seat check sees it."
   *
   * The lock still protected the seat *check*, so this was not a
   * seat-overselling bug on its own; it is what let two increments race even
   * though the writes around them were serialised.
   */
  it('updateUsageCount can run on a caller-supplied transaction', () => {
    expect(usage).toMatch(/updateUsageCount\([\s\S]{0,400}tx\?:/);
  });

  it('increments and decrements accept a transaction', () => {
    for (const method of [
      'incrementMemberCount',
      'decrementMemberCount',
      'incrementChannelCount',
      'decrementChannelCount',
    ]) {
      const start = usage.indexOf(`async ${method}(`);
      expect({ method, found: start > -1 }).toEqual({ method, found: true });
      expect({ method, takesTx: /tx\?:/.test(usage.slice(start, start + 320)) }).toEqual(
        { method, takesTx: true },
      );
    }
  });

  it('the accept path passes its transaction in', () => {
    const start = members.indexOf('await this.usageService.incrementMemberCount');
    expect(start).toBeGreaterThan(-1);
    expect(members.slice(start, start + 260)).toMatch(/\btx\b/);
  });
});
