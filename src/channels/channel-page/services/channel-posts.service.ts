import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { DRIZZLE } from '../../../drizzle/drizzle.module';
import type { DbType } from '../../../drizzle/db';
import { socialMediaChannels } from '../../../drizzle/schema/channels.schema';
import { posts } from '../../../drizzle/schema/posts.schema';
import { users } from '../../../drizzle/schema/users.schema';
import { round1 } from '../../../post-performance/period';
import { PlannerPostsService } from '../../../posts/services/planner-posts.service';
import { displayNameOf } from '../../lib/people';
import {
  CHANNEL_POST_TABS,
  DEFAULT_CHANNEL_POSTS_LIMIT,
  isMetricSort,
  type ChannelPostMetricSort,
  type ChannelPostFormat,
  type ChannelPostRow,
  type ChannelPostSort,
  type ChannelPostTab,
  type ChannelPostsQueryDto,
  type ChannelPostsResponse,
  type PersonRef,
} from '../dto/channel-page.dto';
import {
  decodeChannelPostsCursor,
  encodeChannelPostsCursor,
} from '../lib/channel-posts-cursor';
import { channelTargetsSql, tabSql } from '../lib/channel-targets.sql';

type Row = Record<string, unknown>;

/** node-postgres returns `{ rows }`; some drivers return the array itself. */
function rowsOf(result: unknown): Row[] {
  const r = result as { rows?: Row[] } | Row[];
  return Array.isArray(r) ? r : (r.rows ?? []);
}

const numOrNull = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);

/** The snapshot column a metric sort reads (`m0` = the latest snapshot). */
function metricSql(metric: ChannelPostMetricSort | null): SQL {
  switch (metric) {
    case 'engagementRate':
      return sql`m0.rate`;
    case 'reach':
      return sql`m0.reach_count`;
    case 'impressions':
      return sql`m0.impressions_count`;
    case 'likes':
      return sql`m0.likes_count`;
    case 'comments':
      return sql`m0.comments_count`;
    case 'shares':
      return sql`m0.shares_count`;
    default:
      return sql`NULL::numeric`;
  }
}

/** `time` on Scheduled reads soonest first; every other tab newest first. */
const ASCENDING: ReadonlySet<ChannelPostTab> = new Set(['scheduled']);
/** Drafts have no Planner instant: they sort by their last edit. */
const BY_EDIT: ReadonlySet<ChannelPostTab> = new Set(['drafts', 'approval']);

/** The `ct` rows with their tab: the base every query below reads. */
const tabbedSql = (workspaceId: string, channelId: number): SQL => sql`
  SELECT ct.*, ${tabSql()} AS tab
  FROM (${channelTargetsSql(workspaceId, channelId)}) ct
`;

/**
 * The channel page's Posts tab: one channel's posts, a page at a time, by
 * tab. Everything that narrows the list - the channel, the target's own
 * status, the tab, format and author - is SQL, so pages are always full and
 * every count is exact. Rows are presented exactly as the Planner presents
 * them, plus this channel's target, format and (Sent) latest numbers.
 */
@Injectable()
export class ChannelPostsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DbType,
    private readonly planner: PlannerPostsService,
  ) {}

  async list(
    workspaceId: string,
    channelId: number,
    q: ChannelPostsQueryDto,
  ): Promise<ChannelPostsResponse> {
    const tab: ChannelPostTab = q.tab ?? 'scheduled';
    const sort: ChannelPostSort = q.sort ?? 'time';
    if (isMetricSort(sort) && tab !== 'sent') {
      throw new BadRequestException(`sort=${sort} is only for the sent tab`);
    }
    const limit = q.limit ?? DEFAULT_CHANNEL_POSTS_LIMIT;
    const formats = q.format ?? [];
    const authors = q.createdBy ?? [];
    const cursor = q.cursor
      ? decodeChannelPostsCursor(q.cursor, tab, sort)
      : null;

    await this.assertChannel(workspaceId, channelId);

    const formatWhere = formats.length
      ? sql`x.format IN (${sql.join(
          formats.map((f) => sql`${f}`),
          sql`, `,
        )})`
      : sql`TRUE`;
    const authorWhere = authors.length
      ? sql`x.created_by_id IN (${sql.join(
          authors.map((a) => sql`${a}::uuid`),
          sql`, `,
        )})`
      : sql`TRUE`;

    const [pageRows, groups] = await Promise.all([
      this.page(workspaceId, channelId, {
        tab,
        sort,
        limit,
        cursor,
        where: sql`${formatWhere} AND ${authorWhere}`,
      }),
      this.groups(workspaceId, channelId),
    ]);

    const page = pageRows.slice(0, limit);
    const last = page[page.length - 1];
    const nextCursor =
      pageRows.length > limit && last
        ? encodeChannelPostsCursor({
            tab,
            sort,
            key: String(last.key),
            rate: isMetricSort(sort) ? String(last.metric_key) : null,
            id: String(last.id),
          })
        : null;

    // Counts and facets, from one GROUP BY (tab, format, author).
    const fmtOk = (f: string) =>
      formats.length === 0 || formats.includes(f as ChannelPostFormat);
    const authorOk = (a: string) => authors.length === 0 || authors.includes(a);
    const counts = Object.fromEntries(
      CHANNEL_POST_TABS.map((t) => [t, 0]),
    ) as Record<ChannelPostTab, number>;
    const formatFacet: Record<string, number> = {};
    const authorFacet = new Map<string, number>();
    for (const g of groups) {
      if (fmtOk(g.format) && authorOk(g.author)) counts[g.tab] += g.n;
      if (g.tab !== tab) continue;
      if (authorOk(g.author)) {
        formatFacet[g.format] = (formatFacet[g.format] ?? 0) + g.n;
      }
      if (fmtOk(g.format)) {
        authorFacet.set(g.author, (authorFacet.get(g.author) ?? 0) + g.n);
      }
    }

    const [rows, people] = await Promise.all([
      this.present(page, tab),
      this.people([...authorFacet.keys()]),
    ]);

    return {
      rows,
      nextCursor,
      total: counts[tab],
      counts,
      facets: {
        format: formatFacet,
        createdBy: [...authorFacet.entries()]
          .flatMap(([id, count]) => {
            const user = people.get(id);
            return user ? [{ user, count }] : [];
          })
          .sort(
            (a, b) =>
              b.count - a.count || a.user.name.localeCompare(b.user.name),
          ),
      },
    };
  }

  /** A channel of another workspace (or none) is "not found". */
  private async assertChannel(
    workspaceId: string,
    channelId: number,
  ): Promise<void> {
    const [row] = await this.db
      .select({ id: socialMediaChannels.id })
      .from(socialMediaChannels)
      .where(
        and(
          eq(socialMediaChannels.id, channelId),
          eq(socialMediaChannels.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException('Channel not found');
  }

  /** One page (plus one row, to know there is more) of the tab. */
  private async page(
    workspaceId: string,
    channelId: number,
    o: {
      tab: ChannelPostTab;
      sort: ChannelPostSort;
      limit: number;
      cursor: ReturnType<typeof decodeChannelPostsCursor> | null;
      where: SQL;
    },
  ): Promise<Row[]> {
    const key = BY_EDIT.has(o.tab) ? sql`x.upd_ms` : sql`x.at_ms`;
    const metric = isMetricSort(o.sort) ? o.sort : null;
    const asc =
      !metric &&
      (o.sort === 'timeAsc' || (o.sort === 'time' && ASCENDING.has(o.tab)));
    const c = o.cursor;
    // Metric sorts: highest first, posts without the number (-1) last, then
    // newest first, then id - a total order, so the keyset never skips.
    const keyset = !c
      ? sql`TRUE`
      : metric
        ? sql`(m.metric_key, ${key}, x.id) < (${c.rate}::numeric, ${c.key}::bigint, ${c.id}::uuid)`
        : asc
          ? sql`(${key}, x.id) > (${c.key}::bigint, ${c.id}::uuid)`
          : sql`(${key}, x.id) < (${c.key}::bigint, ${c.id}::uuid)`;
    const order = metric
      ? sql`m.metric_key DESC, ${key} DESC, x.id DESC`
      : asc
        ? sql`${key} ASC, x.id ASC`
        : sql`${key} DESC, x.id DESC`;

    // The latest snapshot on THIS channel; only the Sent tab reads it.
    const metrics =
      o.tab === 'sent'
        ? sql`LEFT JOIN LATERAL (
            SELECT
              s.impressions_count, s.reach_count, s.likes_count,
              s.comments_count, s.shares_count,
              CASE WHEN s.impressions_count > 0 THEN round(
                (COALESCE(s.likes_count, 0) + COALESCE(s.comments_count, 0)
                  + COALESCE(s.shares_count, 0))::numeric * 100
                  / s.impressions_count,
                6)
              END AS rate
            FROM post_metric_snapshots s
            WHERE s.post_id = x.id AND s.channel_id = ${channelId}
            ORDER BY s.snapshot_at DESC, s.id DESC
            LIMIT 1
          ) m0 ON TRUE
          CROSS JOIN LATERAL (
            SELECT m0.impressions_count, m0.reach_count, m0.likes_count,
              m0.comments_count, m0.shares_count, m0.rate,
              COALESCE(${metricSql(metric)}, -1)::numeric AS metric_key
          ) m`
        : sql`CROSS JOIN LATERAL (
            SELECT NULL::int AS impressions_count, NULL::int AS reach_count,
              NULL::int AS likes_count, NULL::int AS comments_count,
              NULL::int AS shares_count, NULL::numeric AS rate,
              -1::numeric AS metric_key
          ) m`;

    const result = await this.db.execute(sql`
      SELECT x.id, x.ord, x.format, ${key} AS key,
        m.impressions_count, m.reach_count, m.likes_count, m.comments_count,
        m.shares_count, m.rate::text AS rate, m.metric_key::text AS metric_key
      FROM (${tabbedSql(workspaceId, channelId)}) x
      ${metrics}
      WHERE x.tab = ${o.tab} AND ${o.where} AND ${keyset}
      ORDER BY ${order}
      LIMIT ${o.limit + 1}
    `);
    return rowsOf(result);
  }

  /** Every post of the channel counted by (tab, format, author). */
  private async groups(
    workspaceId: string,
    channelId: number,
  ): Promise<
    Array<{ tab: ChannelPostTab; format: string; author: string; n: number }>
  > {
    const result = await this.db.execute(sql`
      SELECT x.tab, x.format, x.created_by_id AS author, count(*)::int AS n
      FROM (${tabbedSql(workspaceId, channelId)}) x
      WHERE x.tab IS NOT NULL
      GROUP BY 1, 2, 3
    `);
    return rowsOf(result).map((r) => ({
      tab: r.tab as ChannelPostTab,
      format: String(r.format),
      author: String(r.author),
      n: Number(r.n),
    }));
  }

  /** The page's posts, presented as the Planner does, in page order. */
  private async present(
    page: Row[],
    tab: ChannelPostTab,
  ): Promise<ChannelPostRow[]> {
    if (page.length === 0) return [];
    const ids = page.map((r) => String(r.id));
    const found = await this.db
      .select()
      .from(posts)
      .where(inArray(posts.id, ids));
    const presented = new Map(
      (await this.planner.present(found)).map((p) => [p.id, p]),
    );
    return page.flatMap((r) => {
      const post = presented.get(String(r.id));
      // Deleted between the two reads: drop it rather than invent it.
      if (!post) return [];
      const target = post.targets[Number(r.ord) - 1];
      const row: ChannelPostRow = {
        ...post,
        target,
        format: r.format as ChannelPostFormat,
      };
      if (tab === 'sent') {
        row.metrics = {
          engagementRate:
            r.rate === null || r.rate === undefined
              ? null
              : round1(Number(r.rate)),
          impressions: numOrNull(r.impressions_count),
          reach: numOrNull(r.reach_count),
          likes: numOrNull(r.likes_count),
          comments: numOrNull(r.comments_count),
          shares: numOrNull(r.shares_count),
        };
      }
      return [row];
    });
  }

  /** Authors with name and avatar; an id with no user is left out. */
  private async people(ids: string[]): Promise<Map<string, PersonRef>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        avatarUrl: users.avatarUrl,
      })
      .from(users)
      .where(inArray(users.id, ids));
    return new Map(
      rows.map((u) => [
        u.id,
        { id: u.id, name: displayNameOf(u), avatarUrl: u.avatarUrl ?? null },
      ]),
    );
  }
}
