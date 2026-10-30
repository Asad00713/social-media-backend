import { BadRequestException } from '@nestjs/common';
import type { InboxSort, InboxView } from '../dto/contract';

export interface ConversationCursor {
  v: InboxView | 'search';
  s: InboxSort | 'send';
  /** ISO-8601 UTC with 3 or 6 fractional digits, or 'inf' (null window sorts last). */
  k: string;
  id: string;
}

const KEY = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.(\d{3}|\d{6})Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export function encodeConversationCursor(c: ConversationCursor): string {
  return Buffer.from(
    JSON.stringify({ v: c.v, s: c.s, k: c.k, id: c.id }),
  ).toString('base64url');
}

export function decodeConversationCursor(
  raw: string,
  v: ConversationCursor['v'],
  s: ConversationCursor['s'],
): ConversationCursor {
  const bad = () => new BadRequestException('Invalid cursor');
  if (!BASE64URL.test(raw)) throw bad();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw bad();
  }
  if (typeof parsed !== 'object' || parsed === null) throw bad();
  const c = parsed as Record<string, unknown>;
  if (
    typeof c.k !== 'string' ||
    !(c.k === 'inf' || KEY.test(c.k)) ||
    typeof c.id !== 'string' ||
    !UUID.test(c.id) ||
    c.v !== v ||
    c.s !== s
  ) {
    throw bad();
  }
  return { v, s, k: c.k, id: c.id };
}
