import { BadRequestException } from '@nestjs/common';
import { assertIdsXorSelectAll, bulkTargetsBin, chunk } from './bulk';

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

describe('assertIdsXorSelectAll with nulls', () => {
  const msg = new BadRequestException('Send ids or selectAll, not both');

  it('treats null as absent', () => {
    expect(() =>
      assertIdsXorSelectAll({ ids: null, selectAll: { filter: {} } }),
    ).not.toThrow();
    expect(() =>
      assertIdsXorSelectAll({ ids: ['a'], selectAll: null }),
    ).not.toThrow();
    expect(() => assertIdsXorSelectAll({ ids: null, selectAll: null })).toThrow(
      msg,
    );
  });
});

describe('bulkTargetsBin', () => {
  it('restore and permanentDelete act on the Bin, the rest on live rows', () => {
    expect(bulkTargetsBin({ action: 'restore' })).toBe(true);
    expect(bulkTargetsBin({ action: 'permanentDelete' })).toBe(true);
    for (const action of ['delete', 'star', 'unstar', 'move']) {
      expect(bulkTargetsBin({ action })).toBe(false);
      expect(bulkTargetsBin({ action, selectAll: { filter: {} } })).toBe(false);
    }
  });

  it('refuses a select-all restore or permanentDelete', () => {
    const msg = new BadRequestException(
      'Use the Bin to restore or delete permanently',
    );
    for (const action of ['restore', 'permanentDelete']) {
      expect(() =>
        bulkTargetsBin({ action, selectAll: { filter: {} } }),
      ).toThrow(msg);
    }
    expect(bulkTargetsBin({ action: 'restore', selectAll: null })).toBe(true);
  });
});
