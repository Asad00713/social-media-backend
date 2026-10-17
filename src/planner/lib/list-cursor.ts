import { BadRequestException } from '@nestjs/common';

export interface ListCursor {
  /** `floor(extract(epoch from <occurred>) * 1000)`, selected from SQL. */
  key: string;
  id: string;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_RE = /^-?\d+$/;

export function encodeListCursor(c: ListCursor): string {
  return Buffer.from(JSON.stringify({ key: c.key, id: c.id }), 'utf8').toString(
    'base64url',
  );
}

export function decodeListCursor(raw: string): ListCursor {
  const invalid = () => new BadRequestException('Invalid cursor');
  if (!raw || !/^[A-Za-z0-9_-]+$/.test(raw)) throw invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  if (!parsed || typeof parsed !== 'object') throw invalid();
  const { key, id } = parsed as Record<string, unknown>;
  if (
    typeof key !== 'string' ||
    key.length > 20 ||
    !KEY_RE.test(key) ||
    typeof id !== 'string' ||
    !UUID_RE.test(id)
  ) {
    throw invalid();
  }
  return { key, id };
}
