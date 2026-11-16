import { BadRequestException } from '@nestjs/common';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { DbType } from '../drizzle/db';
import { AdminLogsService } from './admin-logs.service';

const ID = 'req_0123456789abcdef01234567';

function setup() {
  const where = jest.fn((_cond: SQL | undefined) => chain);
  const chain = {
    from: jest.fn(() => chain),
    where,
    orderBy: jest.fn(() => chain),
    limit: jest.fn(() => Promise.resolve([])),
  };
  const db = { select: jest.fn(() => chain) } as unknown as DbType;
  const service = new AdminLogsService(db);
  const whereSql = () => {
    const cond = where.mock.calls[0][0];
    return cond ? new PgDialect().sqlToQuery(cond) : undefined;
  };
  return { service, whereSql };
}

describe('AdminLogsService.getLogs requestId filter', () => {
  it('filters by the exact request id', async () => {
    const { service, whereSql } = setup();
    await service.getLogs({ requestId: ID });
    const q = whereSql();
    expect(q?.sql).toContain('"error_logs"."request_id" = $1');
    expect(q?.params).toEqual([ID]);
  });

  it('trims a pasted id', async () => {
    const { service, whereSql } = setup();
    await service.getLogs({ requestId: `  ${ID}\n` });
    expect(whereSql()?.params).toEqual([ID]);
  });

  it('combines with the other filters', async () => {
    const { service, whereSql } = setup();
    await service.getLogs({ requestId: ID, level: 'error' });
    expect(whereSql()?.params).toEqual(expect.arrayContaining([ID, 'error']));
  });

  it('refuses something that cannot be an id', async () => {
    const { service } = setup();
    await expect(
      service.getLogs({ requestId: "x' OR 1=1 --" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('applies no filter when requestId is blank', async () => {
    const { service, whereSql } = setup();
    await service.getLogs({ requestId: '   ' });
    expect(whereSql()).toBeUndefined();
  });
});
