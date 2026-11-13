import { BadRequestException } from '@nestjs/common';
import {
  CHANNEL_POST_SORTS,
  CHANNEL_POST_TABS,
  isMetricSort,
  type ChannelPostSort,
  type ChannelPostTab,
} from '../dto/channel-page.dto';

/**
 * Where a page of `GET :channelId/posts` ended. Bound to the tab and sort it
 * was minted for: a cursor is never portable across either.
 */
export interface ChannelPostsCursor {
  tab: ChannelPostTab;
  sort: ChannelPostSort;
  /** The time key in ms (bigint as text), selected from SQL. */
  key: string;
  /**
   * Metric sorts only: the metric key as SQL printed it (a count, or the
   * rate as `round(x, 6)`), `-1` = the post has no such number.
   */
  rate: string | null;
  id: string;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INT_RE = /^-?\d{1,19}$/;
/** A count, what `round(x, 6)::text` prints for a rate, or the -1 sentinel. */
const RATE_RE = /^(-1|\d{1,12}(\.\d{1,6})?)$/;
const INT64_MAX = 9223372036854775807n;
const INT64_MIN = -9223372036854775808n;

export function encodeChannelPostsCursor(c: ChannelPostsCursor): string {
  return Buffer.from(
    JSON.stringify({ t: c.tab, s: c.sort, k: c.key, r: c.rate, i: c.id }),
    'utf8',
  ).toString('base64url');
}

export function decodeChannelPostsCursor(
  raw: string,
  tab: ChannelPostTab,
  sort: ChannelPostSort,
): ChannelPostsCursor {
  const invalid = () => new BadRequestException('Invalid cursor');
  if (!raw || !/^[A-Za-z0-9_-]+$/.test(raw)) throw invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  if (!parsed || typeof parsed !== 'object') throw invalid();
  const { t, s, k, r, i } = parsed as Record<string, unknown>;
  if (
    t !== tab ||
    s !== sort ||
    !CHANNEL_POST_TABS.includes(t as ChannelPostTab) ||
    !CHANNEL_POST_SORTS.includes(s as ChannelPostSort) ||
    typeof k !== 'string' ||
    !INT_RE.test(k) ||
    typeof i !== 'string' ||
    !UUID_RE.test(i)
  ) {
    throw invalid();
  }
  const n = BigInt(k);
  if (n > INT64_MAX || n < INT64_MIN) throw invalid();
  if (isMetricSort(sort)) {
    if (typeof r !== 'string' || !RATE_RE.test(r)) throw invalid();
  } else if (r !== null) {
    throw invalid();
  }
  return { tab, sort, key: k, rate: typeof r === 'string' ? r : null, id: i };
}
