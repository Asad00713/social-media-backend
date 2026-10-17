import { BadRequestException } from '@nestjs/common';
import { decodeListCursor, encodeListCursor } from './list-cursor';

const ID = '33333333-3333-4333-8333-333333333333';

describe('list cursor', () => {
  it('round trips', () => {
    const c = { key: '1790000000123', id: ID, tab: 'all' as const };
    expect(decodeListCursor(encodeListCursor(c), 'all')).toEqual(c);
  });

  it('round trips a negative key', () => {
    const c = { key: '-5', id: ID, tab: 'all' as const };
    expect(decodeListCursor(encodeListCursor(c), 'all')).toEqual(c);
  });

  const b64 = (v: unknown) =>
    Buffer.from(JSON.stringify(v), 'utf8').toString('base64url');

  it.each([
    ['empty', ''],
    ['not base64url', '%%%'],
    ['not json', Buffer.from('nope').toString('base64url')],
    ['json null', b64(null)],
    ['json array', b64([])],
    ['missing id', b64({ key: '1', tab: 'all' })],
    ['missing key', b64({ id: ID, tab: 'all' })],
    ['numeric key', b64({ key: 1, id: ID, tab: 'all' })],
    ['decimal key', b64({ key: '1.5', id: ID, tab: 'all' })],
    ['key with sql', b64({ key: '1; drop', id: ID, tab: 'all' })],
    [
      'key above int64',
      b64({ key: '99999999999999999999', id: ID, tab: 'all' }),
    ],
    [
      'key above int64 by one',
      b64({ key: '9223372036854775808', id: ID, tab: 'all' }),
    ],
    [
      'key below int64',
      b64({ key: '-9999999999999999999', id: ID, tab: 'all' }),
    ],
    ['missing tab', b64({ key: '1', id: ID })],
    ['unknown tab', b64({ key: '1', id: ID, tab: 'nope' })],
    ['id not a uuid', b64({ key: '1', id: 'abc', tab: 'all' })],
  ])('rejects %s with a 400', (_n, raw) => {
    expect(() => decodeListCursor(raw, 'all')).toThrow(BadRequestException);
    expect(() => decodeListCursor(raw, 'all')).toThrow('Invalid cursor');
  });

  it('accepts the int64 bounds', () => {
    for (const key of ['9223372036854775807', '-9223372036854775808']) {
      const raw = encodeListCursor({ key, id: ID, tab: 'all' });
      expect(decodeListCursor(raw, 'all').key).toBe(key);
    }
  });

  it('rejects a cursor minted for another tab', () => {
    const raw = encodeListCursor({ key: '1', id: ID, tab: 'failed' });
    expect(() => decodeListCursor(raw, 'published')).toThrow('Invalid cursor');
  });
});
