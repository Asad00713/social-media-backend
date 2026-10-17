import { BadRequestException } from '@nestjs/common';
import { decodeListCursor, encodeListCursor } from './list-cursor';

const ID = '33333333-3333-4333-8333-333333333333';

describe('list cursor', () => {
  it('round trips', () => {
    const c = { key: '1790000000123', id: ID };
    expect(decodeListCursor(encodeListCursor(c))).toEqual(c);
  });

  it('round trips a negative key', () => {
    const c = { key: '-5', id: ID };
    expect(decodeListCursor(encodeListCursor(c))).toEqual(c);
  });

  const b64 = (v: unknown) =>
    Buffer.from(JSON.stringify(v), 'utf8').toString('base64url');

  it.each([
    ['empty', ''],
    ['not base64url', '%%%'],
    ['not json', Buffer.from('nope').toString('base64url')],
    ['json null', b64(null)],
    ['json array', b64([])],
    ['missing id', b64({ key: '1' })],
    ['missing key', b64({ id: ID })],
    ['numeric key', b64({ key: 1, id: ID })],
    ['decimal key', b64({ key: '1.5', id: ID })],
    ['key with sql', b64({ key: '1; drop', id: ID })],
    ['id not a uuid', b64({ key: '1', id: 'abc' })],
  ])('rejects %s with a 400', (_n, raw) => {
    expect(() => decodeListCursor(raw)).toThrow(BadRequestException);
    expect(() => decodeListCursor(raw)).toThrow('Invalid cursor');
  });
});
