import { BadRequestException } from '@nestjs/common';
import { decodeDraftCursor, encodeDraftCursor } from './draft-cursor';

const ID = '33333333-3333-4333-8333-333333333333';
const b64 = (v: unknown) =>
  Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString(
    'base64url',
  );

describe('draft cursor', () => {
  it('round-trips', () => {
    const c = { ready: 1 as const, updatedMs: '1767225600123', id: ID };
    expect(decodeDraftCursor(encodeDraftCursor(c))).toEqual(c);
  });

  it.each([
    ['bang characters', '!!'],
    ['empty', ''],
    ['valid base64 of non-JSON', b64('not json')],
    ['non-uuid id', b64({ ready: 0, updatedMs: '1', id: 'nope' })],
    ['bad ready flag', b64({ ready: 2, updatedMs: '1', id: ID })],
    ['non-numeric ms', b64({ ready: 0, updatedMs: '1; drop', id: ID })],
    ['JSON null', b64('null')],
  ])('rejects %s', (_n, raw) => {
    expect(() => decodeDraftCursor(raw)).toThrow(BadRequestException);
  });
});
