import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { ListScheduledMessagesDto } from '../dto/list-scheduled-messages.dto';

/**
 * The calendar reads scheduled replies for a bounded range. `list` builds its
 * `where` from the DTO, so these tests capture that clause and render it to
 * SQL + params rather than asserting on a fake result set.
 */

let capturedWhere: SQL | undefined;

const mockDb = {
  query: {
    workspace: { findFirst: jest.fn().mockResolvedValue({ id: 'w' }) },
    workspaceInvitation: { findFirst: jest.fn() },
  },
  select: jest.fn(() => ({
    from: () => ({
      where: (w: SQL) => {
        capturedWhere = w;
        return { orderBy: () => Promise.resolve([]) };
      },
    }),
  })),
};

jest.mock('../../drizzle/db', () => ({ db: mockDb }));

import { ScheduledMessagesService } from './scheduled-messages.service';

const WS = '00000000-0000-0000-0000-000000000001';

function dto(obj: Record<string, unknown>) {
  return plainToInstance(ListScheduledMessagesDto, obj);
}

async function whereFor(obj: Record<string, unknown>) {
  capturedWhere = undefined;
  const svc = new ScheduledMessagesService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  await svc.list(WS, 'u', dto(obj));
  return new PgDialect().sqlToQuery(capturedWhere as unknown as SQL);
}

describe('ListScheduledMessagesDto range params', () => {
  const errorsFor = (obj: Record<string, unknown>) =>
    validateSync(dto(obj) as object, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });

  it('accepts ISO from/to', () => {
    expect(
      errorsFor({ from: '2026-03-01T00:00:00Z', to: '2026-03-31T00:00:00Z' }),
    ).toHaveLength(0);
  });

  it('rejects non-calendar ISO forms (week and ordinal dates)', () => {
    for (const v of ['2026-W10', '2026-060']) {
      expect(errorsFor({ from: v }).length).toBeGreaterThan(0);
      expect(errorsFor({ to: v }).length).toBeGreaterThan(0);
    }
  });

  it('rejects from=banana (a 400 under the global ValidationPipe)', () => {
    expect(errorsFor({ from: 'banana' }).length).toBeGreaterThan(0);
    expect(errorsFor({ to: 'banana' }).length).toBeGreaterThan(0);
  });
});

describe('ScheduledMessagesService.list range', () => {
  it('bounds scheduled_at by from and to when given', async () => {
    const q = await whereFor({
      from: '2026-03-01T00:00:00.000Z',
      to: '2026-03-31T00:00:00.000Z',
    });
    expect(q.sql).toMatch(/"scheduled_at" >= \$/);
    expect(q.sql).toMatch(/"scheduled_at" <= \$/);
    expect(q.params).toContain(WS);
    const stamps = q.params.map((p) =>
      p instanceof Date ? p.toISOString() : p,
    );
    expect(stamps).toContain('2026-03-01T00:00:00.000Z');
    expect(stamps).toContain('2026-03-31T00:00:00.000Z');
  });

  it('applies only the bound that was given', async () => {
    const q = await whereFor({ to: '2026-03-31T00:00:00.000Z' });
    expect(q.sql).not.toMatch(/"scheduled_at" >=/);
    expect(q.sql).toMatch(/"scheduled_at" <= \$/);
  });

  it('adds no scheduled_at condition without from/to and keeps the default statuses', async () => {
    const q = await whereFor({});
    expect(q.sql).not.toMatch(/"scheduled_at"/);
    expect(q.sql).toMatch(/"status" in \(\$\d+, \$\d+\)/);
    expect(q.params).toEqual(expect.arrayContaining(['pending', 'failed']));
  });
});
