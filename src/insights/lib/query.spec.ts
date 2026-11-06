import { BadRequestException } from '@nestjs/common';
import { customWindow } from '../../post-performance/period';
import {
  MAX_CUSTOM_DAYS,
  comparisonRange,
  parseChannels,
  parseCompare,
  parseDays,
  parsePeriod,
  parseTableQuery,
  parseTz,
} from './query';

/** Midnight UTC, 3 Nov 2026: yesterday is 2 Nov. */
const TODAY = new Date('2026-11-03T00:00:00Z');

describe('parsePeriod', () => {
  it('a preset is the last whole days ending yesterday', () => {
    expect(parsePeriod({}, TODAY)).toEqual({
      days: 30,
      window: {
        from: '2026-10-04',
        to: '2026-11-02',
        previousFrom: '2026-09-04',
        previousTo: '2026-10-03',
      },
    });
    expect(parsePeriod({ days: '7' }, TODAY).window).toMatchObject({
      from: '2026-10-27',
      to: '2026-11-02',
    });
  });

  it('a custom range is its own dates, its span the day count', () => {
    expect(
      parsePeriod({ from: '2026-10-01', to: '2026-10-14' }, TODAY),
    ).toEqual({ days: 14, window: customWindow('2026-10-01', '2026-10-14') });
  });

  it('treats empty params as absent', () => {
    expect(parsePeriod({ days: '7', from: '', to: '' }, TODAY).days).toBe(7);
  });

  it('rejects days with from', () => {
    expect(() =>
      parsePeriod({ days: '7', from: '2026-10-01', to: '2026-10-02' }, TODAY),
    ).toThrow(BadRequestException);
  });

  it('rejects from without to, and to without from', () => {
    expect(() => parsePeriod({ from: '2026-10-01' }, TODAY)).toThrow(
      BadRequestException,
    );
    expect(() => parsePeriod({ to: '2026-10-01' }, TODAY)).toThrow(
      BadRequestException,
    );
  });

  it('rejects to of today; yesterday is the last day allowed', () => {
    expect(() =>
      parsePeriod({ from: '2026-10-20', to: '2026-11-03' }, TODAY),
    ).toThrow(BadRequestException);
    expect(
      parsePeriod({ from: '2026-10-20', to: '2026-11-02' }, TODAY).days,
    ).toBe(14);
  });

  it('rejects a span of 91 days and accepts 90', () => {
    expect(MAX_CUSTOM_DAYS).toBe(90);
    // 2026-08-05 .. 2026-11-02 is 90 days inclusive.
    expect(
      parsePeriod({ from: '2026-08-05', to: '2026-11-02' }, TODAY).days,
    ).toBe(90);
    expect(() =>
      parsePeriod({ from: '2026-08-04', to: '2026-11-02' }, TODAY),
    ).toThrow(BadRequestException);
  });

  it('rejects from after to, and impossible dates like 2026-02-30', () => {
    expect(() =>
      parsePeriod({ from: '2026-10-02', to: '2026-10-01' }, TODAY),
    ).toThrow(BadRequestException);
    expect(() =>
      parsePeriod({ from: '2026-02-30', to: '2026-03-02' }, TODAY),
    ).toThrow(BadRequestException);
    expect(() =>
      parsePeriod({ from: '2026-02-01', to: '2026-02-29' }, TODAY),
    ).toThrow(BadRequestException);
  });

  it.each(['2026-1-01', '2026/10/01', '20261001', '2026-10-01T00:00', 'x'])(
    'rejects the malformed date %s',
    (raw) => {
      expect(() => parsePeriod({ from: raw, to: '2026-10-14' }, TODAY)).toThrow(
        BadRequestException,
      );
    },
  );

  it('one-day range works; previous is the single day before', () => {
    expect(
      parsePeriod({ from: '2026-11-02', to: '2026-11-02' }, TODAY),
    ).toEqual({
      days: 1,
      window: {
        from: '2026-11-02',
        to: '2026-11-02',
        previousFrom: '2026-11-01',
        previousTo: '2026-11-01',
      },
    });
  });

  it('still rejects a bad preset', () => {
    expect(() => parsePeriod({ days: '14' }, TODAY)).toThrow(
      BadRequestException,
    );
  });
});

describe('parseCompare', () => {
  it('defaults to usual and accepts each mode', () => {
    expect(parseCompare(undefined)).toBe('usual');
    expect(parseCompare('')).toBe('usual');
    for (const m of ['usual', 'previous', 'year', 'none']) {
      expect(parseCompare(m)).toBe(m);
    }
  });
  it.each(['Year', 'last', 'prev'])('rejects %s', (raw) => {
    expect(() => parseCompare(raw)).toThrow(BadRequestException);
  });
});

describe('comparisonRange', () => {
  const w = customWindow('2028-02-01', '2028-02-29');
  it('previous is the span just before', () => {
    expect(comparisonRange(w, 'previous')).toEqual({
      from: '2028-01-03',
      to: '2028-01-31',
    });
  });
  it('year is the same dates a year back, Feb 29 clamped', () => {
    expect(comparisonRange(w, 'year')).toEqual({
      from: '2027-02-01',
      to: '2027-02-28',
    });
  });
  it('usual and none have no date range', () => {
    expect(comparisonRange(w, 'usual')).toBeNull();
    expect(comparisonRange(w, 'none')).toBeNull();
  });
});

describe('parseDays', () => {
  it('defaults to 30 and accepts 7, 30 and 90', () => {
    expect(parseDays(undefined)).toBe(30);
    expect(parseDays('')).toBe(30);
    expect(parseDays('7')).toBe(7);
    expect(parseDays('90')).toBe(90);
  });
  it.each(['14', '0', '-7', '7.5', 'abc', '1e1'])('rejects %s', (raw) => {
    expect(() => parseDays(raw)).toThrow(BadRequestException);
  });
});

describe('parseChannels', () => {
  const allowed = [16, 15, 18];

  it('is every allowed channel when none are asked for', () => {
    expect(parseChannels(undefined, allowed)).toEqual(allowed);
    expect(parseChannels(' ', allowed)).toEqual(allowed);
  });

  it('keeps the allowed ones asked for, in allowed order', () => {
    expect(parseChannels('18,16', allowed)).toEqual([16, 18]);
  });

  it("drops ids that aren't allowed: a stale id must not break the page", () => {
    expect(parseChannels('16,999', allowed)).toEqual([16]);
    // Every id foreign: nothing, not "all channels".
    expect(parseChannels('999', allowed)).toEqual([]);
  });

  it.each(['16,abc', '16;15', '1.5', '16,,15'])(
    'rejects malformed %s',
    (raw) => {
      expect(() => parseChannels(raw, allowed)).toThrow(BadRequestException);
    },
  );
});

describe('parseTz', () => {
  it('defaults to UTC and accepts IANA zones', () => {
    expect(parseTz(undefined)).toBe('UTC');
    expect(parseTz('Asia/Karachi')).toBe('Asia/Karachi');
  });
  it('rejects anything else', () => {
    expect(() => parseTz('Mars/Olympus')).toThrow(BadRequestException);
  });
});

describe('parseTableQuery', () => {
  it('defaults to every format, newest first, ten at a time', () => {
    expect(parseTableQuery({})).toEqual({
      format: 'all',
      sort: 'publishedAt',
      order: 'desc',
      limit: 10,
      offset: 0,
    });
  });
  it('accepts each documented value', () => {
    expect(
      parseTableQuery({
        format: 'video',
        sort: 'engagementRate',
        order: 'asc',
        limit: '100',
        offset: '20',
      }),
    ).toEqual({
      format: 'video',
      sort: 'engagementRate',
      order: 'asc',
      limit: 100,
      offset: 20,
    });
  });
  it('accepts the link format and sorting by reach', () => {
    expect(parseTableQuery({ format: 'link', sort: 'reach' })).toMatchObject({
      format: 'link',
      sort: 'reach',
    });
  });
  it('accepts sorting by usual', () => {
    expect(parseTableQuery({ sort: 'usual' }).sort).toBe('usual');
  });
  it.each([
    [{ format: 'gif' }],
    [{ format: 'unknown' }],
    [{ sort: 'saves' }],
    [{ order: 'up' }],
    [{ limit: '0' }],
    [{ limit: '101' }],
    [{ offset: '-1' }],
    [{ limit: '10.5' }],
  ])('rejects %p', (raw) => {
    expect(() => parseTableQuery(raw)).toThrow(BadRequestException);
  });
});
