import { BadRequestException } from '@nestjs/common';
import { parseChannels, parseDays, parseTableQuery, parseTz } from './query';

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
  it.each([
    [{ format: 'gif' }],
    [{ sort: 'reach' }],
    [{ order: 'up' }],
    [{ limit: '0' }],
    [{ limit: '101' }],
    [{ offset: '-1' }],
    [{ limit: '10.5' }],
  ])('rejects %p', (raw) => {
    expect(() => parseTableQuery(raw)).toThrow(BadRequestException);
  });
});
