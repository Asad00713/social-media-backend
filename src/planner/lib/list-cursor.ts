import { BadRequestException } from '@nestjs/common';
import { LIST_TABS, type ListTab } from '../dto/planner-list.dto';

export interface ListCursor {
  /** `floor(extract(epoch from <occurred>) * 1000)`, selected from SQL. */
  key: string;
  id: string;
  /** The tab the cursor was minted for: a cursor is not portable across tabs. */
  tab: ListTab;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_RE = /^-?\d+$/;
const INT64_MAX = 9223372036854775807n;
const INT64_MIN = -9223372036854775808n;

export function encodeListCursor(c: ListCursor): string {
  return Buffer.from(
    JSON.stringify({ key: c.key, id: c.id, tab: c.tab }),
    'utf8',
  ).toString('base64url');
}

export function decodeListCursor(raw: string, tab: ListTab): ListCursor {
  const invalid = () => new BadRequestException('Invalid cursor');
  if (!raw || !/^[A-Za-z0-9_-]+$/.test(raw)) throw invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  if (!parsed || typeof parsed !== 'object') throw invalid();
  const { key, id, tab: cursorTab } = parsed as Record<string, unknown>;
  if (
    typeof key !== 'string' ||
    key.length > 20 ||
    !KEY_RE.test(key) ||
    typeof id !== 'string' ||
    !UUID_RE.test(id) ||
    cursorTab !== tab ||
    !LIST_TABS.includes(cursorTab as ListTab)
  ) {
    throw invalid();
  }
  // A Postgres bigint holds 19 digits: anything wider would 500 at the cast.
  const n = BigInt(key);
  if (n > INT64_MAX || n < INT64_MIN) throw invalid();
  return { key, id, tab };
}
