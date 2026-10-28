import { BadRequestException } from '@nestjs/common';
import {
  decodeConversationCursor,
  encodeConversationCursor,
  type ConversationCursor,
} from './list-cursor';

const ID = '11111111-1111-4111-8111-111111111111';
const good: ConversationCursor = {
  v: 'to_reply',
  s: 'newest',
  k: '2026-10-26T10:00:00.123456Z',
  id: ID,
};
const b64 = (o: unknown) =>
  Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString(
    'base64url',
  );

describe('conversation list cursor', () => {
  it('round-trips', () => {
    const raw = encodeConversationCursor(good);
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeConversationCursor(raw, 'to_reply', 'newest')).toEqual(good);
  });

  it('accepts millisecond keys and the inf key', () => {
    const ms = { ...good, k: '2026-10-26T10:00:00.123Z' };
    expect(
      decodeConversationCursor(
        encodeConversationCursor(ms),
        'to_reply',
        'newest',
      ),
    ).toEqual(ms);
    const inf = { ...good, s: 'window' as const, k: 'inf' };
    expect(
      decodeConversationCursor(
        encodeConversationCursor(inf),
        'to_reply',
        'window',
      ),
    ).toEqual(inf);
  });

  it.each([
    ['non-base64url', '!!'],
    ['empty', ''],
    ['bad json', b64('{')],
    ['k not iso', b64({ ...good, k: 'yesterday' })],
    ['k without fraction', b64({ ...good, k: '2026-10-26T10:00:00Z' })],
    ['id not uuid', b64({ ...good, id: 'x' })],
    ['view mismatch', b64({ ...good, v: 'later' })],
    ['sort mismatch', b64({ ...good, s: 'oldest' })],
    ['not an object', b64('"str"')],
  ])('rejects %s', (_n, raw) => {
    expect(() => decodeConversationCursor(raw, 'to_reply', 'newest')).toThrow(
      BadRequestException,
    );
  });
});
