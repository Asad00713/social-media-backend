import { BadRequestException } from '@nestjs/common';
import {
  decodeChannelPostsCursor,
  encodeChannelPostsCursor,
  type ChannelPostsCursor,
} from './channel-posts-cursor';

const ID = '11111111-1111-4111-8111-111111111111';
const raw = (o: unknown) =>
  Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');

describe('channel posts cursor', () => {
  it.each<ChannelPostsCursor>([
    {
      tab: 'scheduled',
      sort: 'time',
      key: '1763000000000',
      rate: null,
      id: ID,
    },
    {
      tab: 'sent',
      sort: 'engagementRate',
      key: '-5',
      rate: '12.345679',
      id: ID,
    },
    { tab: 'sent', sort: 'engagementRate', key: '0', rate: '-1', id: ID },
    { tab: 'sent', sort: 'likes', key: '1', rate: '1300', id: ID },
    { tab: 'sent', sort: 'timeAsc', key: '1', rate: null, id: ID },
  ])('round-trips %o', (c) => {
    expect(
      decodeChannelPostsCursor(encodeChannelPostsCursor(c), c.tab, c.sort),
    ).toEqual(c);
  });

  const good = { t: 'sent', s: 'engagementRate', k: '1', r: '5.000000', i: ID };
  it.each([
    ['another tab', good, 'failed', 'engagementRate'],
    ['another sort', good, 'sent', 'time'],
    ['a rate on a time cursor', { ...good, s: 'time' }, 'sent', 'time'],
    [
      'no rate on a rate cursor',
      { ...good, r: null },
      'sent',
      'engagementRate',
    ],
    [
      'a rate that is SQL',
      { ...good, r: '1); drop' },
      'sent',
      'engagementRate',
    ],
    [
      'a key past int64',
      { ...good, k: '9223372036854775808' },
      'sent',
      'engagementRate',
    ],
    ['a non-uuid id', { ...good, i: 'x' }, 'sent', 'engagementRate'],
  ] as const)('refuses %s', (_label, body, tab, sort) => {
    expect(() => decodeChannelPostsCursor(raw(body), tab, sort)).toThrow(
      BadRequestException,
    );
  });

  it('refuses text that is not a cursor', () => {
    expect(() =>
      decodeChannelPostsCursor('not json!', 'scheduled', 'time'),
    ).toThrow(BadRequestException);
    expect(() =>
      decodeChannelPostsCursor(raw([1, 2]), 'scheduled', 'time'),
    ).toThrow(BadRequestException);
  });
});
