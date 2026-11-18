// The member and channel counters move in ONE atomic UPDATE, never as a value
// read in JS and written back: removals do not hold the seat lock, so two
// concurrent writers must each apply their own delta to the row's current
// value. The fake db records the UPDATE that was issued.
const recorded: { set: any }[] = [];
let usageRow: Record<string, unknown> | undefined;
let returned: Record<string, unknown>[] = [];
jest.mock('../../drizzle/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(usageRow ? [usageRow] : []),
        }),
      }),
    }),
    update: () => ({
      set: (set: any) => {
        recorded.push({ set });
        return {
          where: () => ({ returning: () => Promise.resolve(returned) }),
        };
      },
    }),
    insert: () => ({ values: () => Promise.resolve([]) }),
  },
}));

import { PgDialect } from 'drizzle-orm/pg-core';
import { UsageService } from './usage.service';

const dialect = new PgDialect();
const sqlOf = (chunk: unknown) => dialect.sqlToQuery(chunk as any);

function makeService() {
  return new UsageService({} as any, {} as any);
}

beforeEach(() => {
  recorded.length = 0;
  usageRow = { id: 7, channelsCount: 2, membersCount: 3 };
  returned = [{ count: 4 }];
});

describe('UsageService member counter', () => {
  it('increments with GREATEST(members_count + delta, 0) in one UPDATE, not a JS sum', async () => {
    await makeService().incrementMemberCount('ws1', 'u1', 'r1');

    const { membersCount } = recorded[0].set;
    // Not the number the pre-read implies (3 + 1): the database adds.
    expect(typeof membersCount).not.toBe('number');
    const q = sqlOf(membersCount);
    expect(q.sql).toMatch(/GREATEST\(.*"members_count" \+ \$1, 0\)/);
    expect(q.params).toEqual([1]);
  });

  it('decrements the same way with a negative delta', async () => {
    returned = [{ count: 2 }];
    await makeService().decrementMemberCount('ws1', 'u1', 'r1');

    const q = sqlOf(recorded[0].set.membersCount);
    expect(q.sql).toMatch(/GREATEST\(.*"members_count" \+ \$1, 0\)/);
    expect(q.params).toEqual([-1]);
  });

  it('does nothing for a workspace with no usage record', async () => {
    usageRow = undefined;
    await makeService().incrementMemberCount('ws1', 'u1');
    expect(recorded).toHaveLength(0);
  });
});
