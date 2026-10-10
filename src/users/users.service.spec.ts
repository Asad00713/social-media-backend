import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { UsersService } from './users.service';

const dialect = new PgDialect();
const render = (where: SQL) => dialect.sqlToQuery(where);

describe('UsersService email matching', () => {
  it('findByEmail compares lower(email) against the normalised input', async () => {
    // Accounts were stored exactly as typed until now, so `Sara@Daybreak.co`
    // exists on prod. An exact match would lock that person out the moment
    // they type their address in lowercase.
    const findFirst = jest.fn().mockResolvedValue(undefined);
    const service = new UsersService({
      query: { users: { findFirst } },
    } as never);

    await service.findByEmail('  Sara@Daybreak.CO ');

    const { sql, params } = render(findFirst.mock.calls[0][0].where);
    expect(sql).toBe('lower("users"."email") = $1');
    expect(params).toEqual(['sara@daybreak.co']);
  });

  it('create stores the normalised email and checks for it case-insensitively', async () => {
    const findFirst = jest.fn().mockResolvedValue(undefined);
    const returning = jest
      .fn()
      .mockResolvedValue([{ id: 'u1', email: 'sara@daybreak.co' }]);
    const values = jest.fn().mockReturnValue({ returning });
    const insert = jest.fn().mockReturnValue({ values });
    const service = new UsersService({
      query: { users: { findFirst } },
      insert,
    } as never);

    await service.create({
      email: 'Sara@Daybreak.co',
      name: 'Sara',
      password: 'Secret123',
    });

    expect(render(findFirst.mock.calls[0][0].where).params).toEqual([
      'sara@daybreak.co',
    ]);
    expect(values.mock.calls[0][0].email).toBe('sara@daybreak.co');
  });
});

describe('UsersService.createFromGoogle', () => {
  const input = { email: 'sara@gmail.com', name: 'Sara', googleSub: 'g-1' };
  const build = (rejection: unknown, findFirst: jest.Mock) => {
    const returning = jest.fn().mockRejectedValue(rejection);
    const insert = jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({ returning }),
    });
    return new UsersService({
      query: { users: { findFirst } },
      insert,
    } as never);
  };

  it('returns the row a racing callback created (unique violation by sub)', async () => {
    const row = { id: 'won' };
    const findFirst = jest.fn().mockResolvedValue(row);
    const service = build({ code: '23505' }, findFirst);
    await expect(service.createFromGoogle(input)).resolves.toBe(row);
  });

  it('falls back to the email when the wrapped violation finds no sub match', async () => {
    const row = { id: 'by-email' };
    const findFirst = jest
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(row);
    const service = build({ cause: { code: '23505' } }, findFirst);
    await expect(service.createFromGoogle(input)).resolves.toBe(row);
    expect(findFirst).toHaveBeenCalledTimes(2);
  });

  it('rethrows anything that is not a unique violation', async () => {
    const boom = new Error('connection lost');
    const service = build(boom, jest.fn());
    await expect(service.createFromGoogle(input)).rejects.toBe(boom);
  });
});
