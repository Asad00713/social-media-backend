import { BadRequestException } from '@nestjs/common';
import { assertIdsXorSelectAll, chunk } from './bulk';

describe('assertIdsXorSelectAll', () => {
  it('throws when both ids and selectAll are sent', () => {
    expect(() =>
      assertIdsXorSelectAll({ ids: ['a'], selectAll: { filter: {} } }),
    ).toThrow(new BadRequestException('Send ids or selectAll, not both'));
  });

  it('throws when neither is sent', () => {
    expect(() => assertIdsXorSelectAll({})).toThrow(
      new BadRequestException('Send ids or selectAll, not both'),
    );
  });

  it('passes with ids alone or selectAll alone', () => {
    expect(() => assertIdsXorSelectAll({ ids: ['a'] })).not.toThrow();
    expect(() =>
      assertIdsXorSelectAll({ selectAll: { filter: {} } }),
    ).not.toThrow();
  });
});

describe('chunk', () => {
  it('splits 1001 items into 500, 500 and 1', () => {
    const xs = Array.from({ length: 1001 }, (_, i) => i);
    const parts = chunk(xs);
    expect(parts.map((p) => p.length)).toEqual([500, 500, 1]);
    expect(parts.flat()).toEqual(xs);
  });

  it('returns no chunks for an empty list', () => {
    expect(chunk([])).toEqual([]);
  });
});
