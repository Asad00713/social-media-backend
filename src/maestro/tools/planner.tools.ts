import { z } from 'zod';
import type { PostService } from '../../posts/services/post.service';
import type { ScheduledMessagesService } from '../../inbox/services/scheduled-messages.service';
import type { DripService } from '../../drips/drip.service';
import type { WorkspaceService } from '../../workspace/workspace.service';
import type { CampaignsService } from '../../campaigns/campaigns.service';
import type { AgentToolDefinition } from '../maestro.types';
import {
  REFERENCE_USAGE_HINT,
  withReferences,
  type EntityReference,
} from './references';
import { postReference, type PostRow } from './post.tools';

/**
 * How far ahead "what's coming up" looks when the user names no dates.
 *
 * A week is the horizon the Planner opens on and the one people plan in. A
 * longer default would bury this week's work under next month's.
 */
const DEFAULT_DAYS_AHEAD = 7;
const MAX_DAYS = 90;

/** How many items one answer can name before it stops being readable. */
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/**
 * The count a day needs before "busiest" means anything.
 *
 * Two posts against one is not a pattern, it is a light week — naming it
 * dresses arithmetic up as insight, and every reviewer read it that way.
 */
const BUSIEST_DAY_MIN_COUNT = 3;

/** Statuses a post can hold once it has left the schedule. */
const SETTLED_POST_STATUSES = new Set([
  'published',
  'failed',
  'partially_published',
]);

/**
 * One planner entry, normalised across the three sources the Planner merges.
 *
 * The Planner page is a frontend composition — there is no backend calendar
 * service — so this tool performs the same merge the page does. Anything else
 * would put the agent and the screen on different data.
 */
interface PlannerEntry {
  id: string;
  kind: 'post' | 'message' | 'drip';
  scheduledAt: string;
  /** The date it occupies, as the Planner groups it. */
  date: string;
  /**
   * The time as the Planner writes it — "Tue, Sep 1, 2:00 PM".
   *
   * This is the one to say out loud. `scheduledAt` is UTC and is here only for
   * ordering; reading it aloud tells the user an hour they will not recognise.
   */
  localTime: string;
  status: string;
  platforms: string[];
  /** The caption, message text, or post body — what is actually going out. */
  content: string;
  /** Set when a campaign put this on the calendar. */
  campaignName?: string;
  /** Messages only: who or what the message is addressed to. */
  target?: string;
  /** True once this has fired — published, failed, or sent. */
  settled: boolean;
}

/** Trim to one readable line. */
function preview(text: string | null | undefined, limit = 140): string {
  const oneLine = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!oneLine) return '';
  return oneLine.length > limit
    ? `${oneLine.slice(0, limit).trimEnd()}…`
    : oneLine;
}

/**
 * The workspace's clock, as calendar parts.
 *
 * Everything is stored in UTC, but the Planner renders in the workspace's zone
 * — so a post at 22:00 in Karachi is 17:00 UTC. Slicing the ISO string would
 * file it under the wrong day near midnight, and label it with the wrong hour
 * always. Every date the agent says out loud is built from these parts.
 */
function partsIn(iso: string, timeZone: string): Record<string, string> {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const out: Record<string, string> = {};
  for (const { type, value } of fmt.formatToParts(new Date(iso))) {
    out[type] = value;
  }
  return out;
}

/** The calendar date an entry sits on, in the same YYYY-MM-DD the page keys by. */
function dateKey(iso: string, timeZone: string): string {
  if (!iso) return '';
  const p = partsIn(iso, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

/**
 * The label the Planner shows for a time — "Tue, Sep 1, 2:00 PM".
 *
 * Pre-formatted rather than left to the model: it is told neither today's date
 * nor the workspace zone, so any weekday or clock time it derives from a UTC
 * string is a guess. Reading a label back cannot be guessed wrong.
 */
function humanTime(iso: string, timeZone: string): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(iso));
}

/** The weekday-and-date label for a whole day — "Tuesday, Sep 1". */
function humanDate(key: string): string {
  if (!key) return '';
  // The key is already a wall-clock date, so read it back in UTC at noon —
  // far enough from either midnight that the date cannot slip.
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  }).format(new Date(`${key}T12:00:00Z`));
}

function platformsOfPost(post: PostRow): string[] {
  const targets = Array.isArray(post.targets) ? post.targets : [];
  return targets
    .map((t) => (t as { platform?: string }).platform)
    .filter((p): p is string => typeof p === 'string');
}

function fromPost(post: PostRow, tz: string): PlannerEntry {
  // publishedAt first: a "post now" has no scheduledAt, and keying on that
  // alone dropped every immediate post off the calendar — the same bug the
  // Planner endpoint already fixed for itself.
  const occurredAt = post.publishedAt ?? post.scheduledAt;
  const iso = occurredAt ? occurredAt.toISOString() : '';

  return {
    id: post.id,
    kind: 'post',
    scheduledAt: iso,
    date: dateKey(iso, tz),
    localTime: humanTime(iso, tz),
    status: post.status,
    platforms: platformsOfPost(post),
    content: preview(post.content),
    settled: SETTLED_POST_STATUSES.has(post.status),
  };
}

/** The shape ScheduledMessagesService.list returns, narrowed to what we read. */
interface ScheduledMessageLike {
  id: string;
  scheduledAt: string;
  status: string;
  textPreview: string;
  text: string;
  targetLabel: string | null;
  platform?: string;
  type: string;
}

function fromMessage(m: ScheduledMessageLike, tz: string): PlannerEntry {
  return {
    id: m.id,
    kind: 'message',
    scheduledAt: m.scheduledAt,
    date: dateKey(m.scheduledAt, tz),
    localTime: humanTime(m.scheduledAt, tz),
    status: m.status,
    platforms: m.platform ? [m.platform] : [],
    content: preview(m.textPreview || m.text),
    ...(m.targetLabel ? { target: m.targetLabel } : {}),
    // A scheduled message is settled once it is no longer waiting to fire.
    settled: m.status !== 'pending',
  };
}

/** The shape DripService.getWorkspaceScheduledDripPosts returns. */
interface DripPostLike {
  id: string;
  campaignId: string;
  campaignName: string;
  scheduledAt: string;
  status: string;
  platforms: string[];
  content: string | null;
}

function fromDrip(d: DripPostLike, tz: string): PlannerEntry {
  return {
    id: d.id,
    kind: 'drip',
    scheduledAt: d.scheduledAt,
    date: dateKey(d.scheduledAt, tz),
    localTime: humanTime(d.scheduledAt, tz),
    status: d.status,
    platforms: d.platforms,
    content: preview(d.content),
    campaignName: d.campaignName,
    // The drip query only returns posts still queued to fire.
    settled: false,
  };
}

/** What the planner tools need to read. */
interface PlannerDeps {
  posts: PostService;
  scheduledMessages: ScheduledMessagesService;
  drips: DripService;
  workspaces: WorkspaceService;
  campaigns: CampaignsService;
}

/**
 * Campaigns that are running but have nothing to run.
 *
 * An active campaign with no planned posts publishes nothing, quietly, and
 * looks fine on the Campaigns page — the failure is only visible by comparing
 * two screens. It is a fact about the schedule, so it belongs in the schedule
 * answer rather than waiting for someone to ask about campaigns.
 */
async function idleCampaigns(
  deps: PlannerDeps,
  ctx: { workspaceId: string },
): Promise<{ id: string; name: string }[]> {
  try {
    const rows = await deps.campaigns.list(ctx.workspaceId, {
      status: 'active',
    });
    return rows
      .filter((c) => (c.metrics?.postsPlanned ?? 0) === 0)
      .map((c) => ({ id: c.id, name: c.name }));
  } catch {
    // A campaigns read failing must not take the calendar answer with it.
    return [];
  }
}

/**
 * Posts the workspace holds outside the window being reported.
 *
 * The Planner's own filter chips count everything — "All 7" — while a week's
 * answer counts four. Both are right, and the user cannot see why. Left to be
 * challenged, the model guessed at reasons instead of looking; volunteering the
 * number in the first sentence means the question is never asked.
 */
async function postsOutsideWindow(
  deps: PlannerDeps,
  ctx: { workspaceId: string },
  inWindow: number,
): Promise<number> {
  try {
    // limit 1: only the total is wanted, never the rows.
    const { total } = await deps.posts.getWorkspacePosts(ctx.workspaceId, {
      limit: 1,
    });
    return Math.max(total - inWindow, 0);
  } catch {
    return 0;
  }
}

/**
 * Clickable chips for the posts among these entries.
 *
 * Only posts have a page to open: a scheduled message has no route of its own,
 * and a drip post is not addressable until it materialises — citing those
 * would be a dead chip. Shared by both tools because a post the summary names
 * has to be as clickable as the same post in a list; naming it in one place
 * and not the other is the difference the user notices.
 */
async function postChips(
  deps: PlannerDeps,
  ctx: { workspaceId: string },
  entries: PlannerEntry[],
): Promise<EntityReference[]> {
  const ids = new Set(
    entries.filter((e) => e.kind === 'post').map((e) => e.id),
  );
  const rows = await Promise.all(
    [...ids].map((id) =>
      deps.posts.getPost(id, ctx.workspaceId).catch(() => null),
    ),
  );
  return rows.filter((r): r is PostRow => r !== null).map(postReference);
}

/**
 * The zone the workspace plans in.
 *
 * Falls back to UTC rather than throwing: a wrong-by-an-offset time is a far
 * smaller failure than the whole tool erroring out, and UTC is the column's
 * own default anyway.
 */
async function resolveTimeZone(
  deps: PlannerDeps,
  ctx: { workspaceId: string; userId: string },
): Promise<string> {
  try {
    const ws = await deps.workspaces.findOne(ctx.workspaceId, ctx.userId);
    const tz = ws?.timezone;
    if (typeof tz !== 'string' || !tz.trim()) return 'UTC';
    // A zone the runtime does not know would throw on every later format call.
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

/**
 * How far a zone is from UTC at a given instant, in milliseconds.
 *
 * The formatter has no milliseconds, so they are taken off `at` before the
 * subtraction — otherwise a time ending in .999 yields an offset 999ms short
 * of the real one, and that error rides straight into the resolved instant.
 */
function offsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(at);
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second'),
  );
  return asUtc - (at.getTime() - at.getUTCMilliseconds());
}

/**
 * The instant a wall-clock time in `timeZone` corresponds to.
 *
 * A bare "2026-09-06" parses as UTC midnight, and pushing it to 23:59:59Z is
 * still 4:59 AM on the 7th in Karachi — which is how a range the model
 * correctly asked to end on Sunday came back labelled Monday. The offset is
 * measured twice because the first guess can land on the wrong side of a DST
 * change, and the second reading is taken with that shift already applied.
 */
function zonedTime(
  key: string,
  timeZone: string,
  endOfDay: boolean,
): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key.trim());
  if (!m) return null;
  const wall = Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    endOfDay ? 23 : 0,
    endOfDay ? 59 : 0,
    endOfDay ? 59 : 0,
    endOfDay ? 999 : 0,
  );
  const first = new Date(wall - offsetMs(new Date(wall), timeZone));
  return new Date(wall - offsetMs(first, timeZone));
}

/**
 * The named windows a question usually means.
 *
 * "This week" is not the model's to work out. Asked the same question three
 * times it sent three different ranges — one of them eight days long, which
 * put Monday at both ends — so the phrase now names a period and the server
 * decides what it covers. `this_week` deliberately runs from TODAY, not from
 * the calendar Monday: a week already half gone is not what someone planning
 * is asking about, and days that have passed cannot be filled.
 */
const PERIODS = [
  'today',
  'tomorrow',
  'this_week',
  'next_week',
  'this_month',
] as const;
type Period = (typeof PERIODS)[number];

/** Shift a YYYY-MM-DD key by whole days, staying on the calendar. */
function addDays(key: string, days: number): string {
  const at = new Date(`${key}T12:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/** The weekday index (0 = Sunday) of a date key. */
function weekdayOf(key: string): number {
  return new Date(`${key}T12:00:00Z`).getUTCDay();
}

/** The whole-day span a named period covers, in the workspace's calendar. */
function periodRange(
  period: Period,
  now: Date,
  timeZone: string,
): { from: Date; to: Date } | null {
  const today = dateKey(now.toISOString(), timeZone);
  let firstKey = today;
  let lastKey = today;

  switch (period) {
    case 'today':
      break;
    case 'tomorrow':
      firstKey = lastKey = addDays(today, 1);
      break;
    case 'this_week':
      // From today to the coming Sunday — the part of the week still ahead.
      lastKey = addDays(today, (7 - weekdayOf(today)) % 7);
      break;
    case 'next_week': {
      const nextMonday = addDays(today, (8 - weekdayOf(today)) % 7 || 7);
      firstKey = nextMonday;
      lastKey = addDays(nextMonday, 6);
      break;
    }
    case 'this_month': {
      firstKey = today;
      const [y, m] = today.split('-').map(Number);
      // Day 0 of the next month is the last day of this one.
      lastKey = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
      break;
    }
  }

  const from = zonedTime(firstKey, timeZone, false);
  const to = zonedTime(lastKey, timeZone, true);
  return from && to ? { from, to } : null;
}

/**
 * The window a query covers, in the workspace's own calendar.
 *
 * Dates arrive as YYYY-MM-DD and mean whole days where the user lives — so
 * they are resolved in the workspace zone, not UTC. Doing it in UTC is what
 * made a Sunday-ending week report itself as ending Monday.
 */
function resolveRange(
  fromArg: unknown,
  toArg: unknown,
  now: Date,
  timeZone: string,
  periodArg?: unknown,
): { from: Date; to: Date } {
  // A named period wins: it is the one path where no arithmetic was guessed.
  if (typeof periodArg === 'string') {
    const named = (PERIODS as readonly string[]).includes(periodArg)
      ? periodRange(periodArg as Period, now, timeZone)
      : null;
    if (named) return named;
  }

  const bare = (value: unknown): string | null =>
    typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())
      ? value.trim()
      : null;

  const parseAny = (value: unknown, endOfDay: boolean): Date | null => {
    const key = bare(value);
    if (key) return zonedTime(key, timeZone, endOfDay);
    if (typeof value !== 'string' || !value.trim()) return null;
    const d = new Date(value.trim());
    return Number.isNaN(d.getTime()) ? null : d;
  };

  const from = parseAny(fromArg, false) ?? now;
  const parsedTo = parseAny(toArg, true);

  if (parsedTo) {
    // Cap the span so one question cannot pull a year of posts.
    const maxTo = new Date(from.getTime() + MAX_DAYS * 24 * 60 * 60 * 1000);
    return { from, to: parsedTo > maxTo ? maxTo : parsedTo };
  }

  // DEFAULT_DAYS_AHEAD days INCLUDING the day we start on, and ending when that
  // last day ends locally. Adding a flat 7×24h to a mid-afternoon "now" reached
  // into an eighth calendar day, which put the same weekday at both ends of
  // "this week" — the answer named Monday as empty and the user could not tell
  // whether that meant today or a week from today.
  const lastDay = dateKey(
    new Date(
      from.getTime() + (DEFAULT_DAYS_AHEAD - 1) * 24 * 60 * 60 * 1000,
    ).toISOString(),
    timeZone,
  );
  return {
    from,
    to:
      zonedTime(lastDay, timeZone, true) ??
      new Date(from.getTime() + DEFAULT_DAYS_AHEAD * 24 * 60 * 60 * 1000),
  };
}

/**
 * Every planner entry in a window, from all three sources the Planner merges.
 *
 * Shared by both tools so a count and a list can never disagree — the summary
 * counting one set of rows while the list showed another is exactly the class
 * of bug that had the agent contradicting the Inbox screen.
 */
async function collectEntries(
  deps: PlannerDeps,
  ctx: { workspaceId: string; userId: string },
  range: { from: Date; to: Date },
  tz: string,
): Promise<PlannerEntry[]> {
  const [postRows, messageRows, dripRows] = await Promise.all([
    deps.posts.getCalendarPosts(ctx.workspaceId, range.from, range.to),
    deps.scheduledMessages.list(ctx.workspaceId, ctx.userId, {}),
    deps.drips.getWorkspaceScheduledDripPosts(
      ctx.workspaceId,
      range.from,
      range.to,
    ),
  ]);

  const entries: PlannerEntry[] = [
    ...postRows.map((p) => fromPost(p, tz)),
    // Messages are not queried by date — the service lists pending ones
    // outright — so the window is applied here instead.
    ...(messageRows as unknown as ScheduledMessageLike[])
      .map((m) => fromMessage(m, tz))
      .filter((m) => {
        const at = new Date(m.scheduledAt).getTime();
        return at >= range.from.getTime() && at <= range.to.getTime();
      }),
    ...(dripRows as unknown as DripPostLike[]).map((d) => fromDrip(d, tz)),
  ];

  return entries
    .filter((e) => e.scheduledAt)
    .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
}

/** Group entries by the date they occupy, oldest day first. */
function byDate(entries: PlannerEntry[]) {
  const map = new Map<string, PlannerEntry[]>();
  for (const entry of entries) {
    const list = map.get(entry.date);
    if (list) list.push(entry);
    else map.set(entry.date, [entry]);
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, items]) => ({
      date,
      day: humanDate(date),
      count: items.length,
      items,
    }));
}

/**
 * Read-only tools over the Planner.
 *
 * Two tools: a list for "what is going out this week" and a count-only summary
 * for "am I posting enough". Both read the same three sources the Planner page
 * merges — posts, scheduled inbox messages, and drip campaign posts — because
 * there is no backend calendar service to read instead.
 *
 * External calendar events (the user's connected Google/Outlook calendars) are
 * deliberately excluded: they are personal appointments imported read-only, and
 * an agent answering "what am I posting?" should not read out dentist visits.
 *
 * Every read derives its workspace from `ctx`, never from tool arguments.
 */
export function createPlannerTools(deps: PlannerDeps): AgentToolDefinition[] {
  return [
    {
      name: 'list_scheduled',
      description:
        'What is on the content calendar in a date range: scheduled posts, scheduled inbox replies, and posts queued by drip campaigns — the same three things the Planner screen shows, merged and in time order. Use this for "what am I posting this week", "what goes out tomorrow", "anything scheduled for Friday", or before suggesting a new posting time.\n\n' +
        'WINDOW: pass `period` ("today", "tomorrow", "this_week", "next_week", "this_month") for anything the user said in words, and let the server work out the dates. Do NOT compute a range yourself — asked "this week" three times you sent three different ranges, one of them eight days long with the same weekday at both ends. Use `from`/`to` only for dates the user named outright. Defaults to the next 7 days.\n\n' +
        'UPCOMING vs ALREADY OUT. The range can span the past, so the result is split into `upcoming` (still to fire) and `alreadyOut` (published, failed, or sent). Never report the total as though it were all still scheduled — "12 posts scheduled" when 8 have already published is wrong, and the user is looking at a calendar that shows the difference.\n\n' +
        'Say what is going out, not what kind of record it is. A drip post and a normal scheduled post are both "a post" to the user; `kind` is there so you can group or filter, not to be read aloud. Each entry carries its `content` — that is what makes one line distinguishable from the next, so use it.\n\n' +
        "TIMES: say the entry's `localTime` verbatim — it is already the workspace's zone and already carries the weekday, and it matches what the Planner screen shows. Never read `scheduledAt` aloud (it is UTC), never convert a time yourself, and never work out a weekday from a date: you are not told what day it is, so a weekday you derive is a guess. Group days under `byDate[].day` for the same reason.\n\n" +
        'SAY THE WINDOW. Your count is only for `range.label` — the Planner screen may be showing a different month, so a bare number invites "but my calendar says 7". Name the window with the count.\n\n' +
        'If the user says your number disagrees with their screen, do not speculate about why — call this tool again over a wider range (the surrounding months) and look. Almost always they are counting posts that have already published, which come back as `alreadyOut`. Answer with what you found, not with a list of things it might have been.' +
        REFERENCE_USAGE_HINT,
      inputSchema: {
        period: z
          .enum(PERIODS)
          .optional()
          .describe(
            'The window to look at, resolved in the workspace timezone. Prefer this over from/to for anything the user phrased in words ("this week", "tomorrow"). Defaults to the next 7 days.',
          ),
        from: z
          .string()
          .optional()
          .describe(
            'Start of an EXPLICIT range the user named, YYYY-MM-DD. Leave unset when using period.',
          ),
        to: z
          .string()
          .optional()
          .describe(
            `End of the range, YYYY-MM-DD inclusive. Defaults to ${DEFAULT_DAYS_AHEAD} days after the start; spans longer than ${MAX_DAYS} days are trimmed.`,
          ),
        platform: z
          .string()
          .optional()
          .describe(
            'Optional platform filter (e.g. "instagram"). Omit for every platform.',
          ),
        limit: z
          .number()
          .optional()
          .describe(
            `Max entries to return (1-${MAX_LIMIT}, default ${DEFAULT_LIMIT}).`,
          ),
      },
      handler: async (args, ctx) => {
        const tz = await resolveTimeZone(deps, ctx);
        const range = resolveRange(
          args.from,
          args.to,
          new Date(),
          tz,
          args.period,
        );
        const platform =
          typeof args.platform === 'string' && args.platform.trim()
            ? args.platform.trim().toLowerCase()
            : undefined;
        const limit = Math.min(
          Math.max(Number(args.limit) || DEFAULT_LIMIT, 1),
          MAX_LIMIT,
        );

        const all = await collectEntries(deps, ctx, range, tz);
        const matching = platform
          ? all.filter((e) =>
              e.platforms.some((p) => p.toLowerCase() === platform),
            )
          : all;

        const page = matching.slice(0, limit);
        const upcoming = page.filter((e) => !e.settled);
        const alreadyOut = page.filter((e) => e.settled);

        const refs = await postChips(deps, ctx, page);

        return withReferences(
          {
            range: {
              from: range.from.toISOString(),
              to: range.to.toISOString(),
              timeZone: tz,
              // The window said in words, so the answer can name the boundary
              // it is answering within rather than leaving the user to guess
              // why a count differs from the one on their screen.
              label: `${humanDate(dateKey(range.from.toISOString(), tz))} – ${humanDate(dateKey(range.to.toISOString(), tz))}`,
            },
            total: matching.length,
            showing: page.length,
            ...(platform ? { filteredByPlatform: platform } : {}),
            upcomingCount: upcoming.length,
            alreadyOutCount: alreadyOut.length,
            upcoming,
            alreadyOut,
            byDate: byDate(upcoming),
          },
          refs,
        );
      },
    },

    {
      name: 'get_schedule_summary',
      description:
        'Counts of what is on the calendar over a range — per day, per platform, and how many days have nothing on them. Use this for "how does my week look", "am I posting enough", "which days are empty", or as a cheap first check before deciding whether to list anything.\n\n' +
        'WINDOW: pass `period` ("today", "tomorrow", "this_week", "next_week", "this_month") for anything the user said in words, and let the server work out the dates. Do NOT compute a range yourself — asked "this week" three times you sent three different ranges, one of them eight days long with the same weekday at both ends. Use `from`/`to` only for dates the user named outright.\n\n' +
        'NAME THE POSTS, DO NOT JUST COUNT THEM. Every day in `perDay` carries the `postIds` sitting on it, and every one of those posts comes back cited in THIS result — no second tool call is needed to name them. Write "Tuesday: [[ref:id]] and [[ref:id]]", never "Tuesday: 2 posts". A bare count the user cannot click is a dead end when the posts were right here. Fall back to a plain count only when a day holds more than five.\n\n' +
        'Every count here is of UPCOMING entries — things still to go out. Anything already published in the range is reported separately as `alreadyOut` and must not be folded into the total.\n\n' +
        '`emptyDays` are the days in range with nothing scheduled, today excluded — a day already underway is not something the user can fill. Each carries a `day` label that already includes the date; say it whole ("Wed, Sep 2"), never a bare weekday. "Nothing on Monday" is unanswerable when the user cannot tell which Monday.\n\n' +
        'Report an empty day as an absence, not a shortfall: "nothing scheduled Wed Sep 2 or Fri Sep 4". Do not call it a gap, a hole, or a break in rhythm/consistency/cadence — you do not know what this workspace is aiming for, so every one of those words is a judgement on a plan you have not seen. A deliberate three-posts-a-week schedule is not a problem to solve.\n\n' +
        '`busiestDay` is null when the days are evenly spread. Null means there is no busiest day — do not name one anyway, and do not describe an even spread as a pattern. Say nothing about cadence beyond what these numbers show: you do not know what this workspace is aiming for, so "you have gaps in your rhythm" is a judgement you cannot support.\n\n' +
        '`activeCampaignsWithNoPosts` is a campaign that is running and will publish nothing, because it has no posts planned. It looks healthy on the Campaigns page, so the user cannot see it — say it whenever the list is non-empty, cite the campaign, and put it FIRST: it matters more than any count on this result. Say the consequence, not a nudge: "it will not publish anything until it has posts" beats "worth checking on".\n\n' +
        '`postsOutsideThisWindow` is how many of the workspace\'s posts fall outside the range you are reporting. When it is above zero, say it in the same breath as your count — "4 scheduled this week; your other 3 posts sit outside it" — because the Planner\'s own filter counts every post and the user is looking at the larger number. Volunteer it; do not wait to be asked why the two disagree.\n\n' +
        '`perPlatform` is a count per platform. Say the counts, not just the names: "Threads (2), Discord (1)" tells the user where the week actually went; "across Threads and Discord" does not.\n\n' +
        'ENOUGH / TOO FEW / TOO MANY. `canJudgeSufficiency` is false: no target cadence is set, so you CANNOT answer whether the schedule is enough. Give the counts, then say plainly that there is no target to compare against and offer to compare if the user names one. Do not answer it sideways either — "depends on your goals, but you may want more" is the same judgement in a softer voice.' +
        REFERENCE_USAGE_HINT,
      inputSchema: {
        period: z
          .enum(PERIODS)
          .optional()
          .describe(
            'The window to look at, resolved in the workspace timezone. Prefer this over from/to for anything the user phrased in words ("this week", "tomorrow"). Defaults to the next 7 days.',
          ),
        from: z
          .string()
          .optional()
          .describe(
            'Start of an EXPLICIT range the user named, YYYY-MM-DD. Leave unset when using period.',
          ),
        to: z
          .string()
          .optional()
          .describe(
            `End of the range, YYYY-MM-DD inclusive. Defaults to ${DEFAULT_DAYS_AHEAD} days after the start.`,
          ),
      },
      handler: async (args, ctx) => {
        const now = new Date();
        const tz = await resolveTimeZone(deps, ctx);
        const range = resolveRange(args.from, args.to, now, tz, args.period);
        const [all, idle] = await Promise.all([
          collectEntries(deps, ctx, range, tz),
          idleCampaigns(deps, ctx),
        ]);
        // The summary names posts too — "2 going out Tuesday" and then no way
        // to open either of them is exactly the dead end the chips exist to
        // avoid. Same entities, same clickability, whichever tool answered.
        const chips = await postChips(deps, ctx, all);
        const upcoming = all.filter((e) => !e.settled);
        const elsewhere = await postsOutsideWindow(
          deps,
          ctx,
          all.filter((e) => e.kind === 'post').length,
        );

        const perPlatform: Record<string, number> = {};
        for (const entry of upcoming) {
          for (const p of entry.platforms) {
            perPlatform[p] = (perPlatform[p] ?? 0) + 1;
          }
        }

        // Every date in the window, so a day with nothing on it is visible as
        // a gap rather than simply missing from the list. Walked in the
        // workspace's zone, because a UTC walk skips or repeats a local day
        // whenever the offset pushes midnight across the boundary.
        const scheduledDays = new Set(upcoming.map((e) => e.date));
        const today = dateKey(now.toISOString(), tz);
        const endKey = dateKey(range.to.toISOString(), tz);
        const emptyDays: string[] = [];
        let key = dateKey(range.from.toISOString(), tz);
        // A bounded walk: one step per day, capped so a bad range cannot spin.
        for (let i = 0; i <= MAX_DAYS && key <= endKey; i += 1) {
          // Today is not an opportunity — it is already partly gone, and
          // telling someone to fill a day they are standing in is not advice.
          if (!scheduledDays.has(key) && key > today) emptyDays.push(key);
          const next = new Date(`${key}T12:00:00Z`);
          next.setUTCDate(next.getUTCDate() + 1);
          key = next.toISOString().slice(0, 10);
        }

        const days = byDate(upcoming);
        const busiest = [...days].sort((a, b) => b.count - a.count)[0] ?? null;

        return withReferences(
          {
            range: {
              from: range.from.toISOString(),
              to: range.to.toISOString(),
              timeZone: tz,
              label: `${humanDate(dateKey(range.from.toISOString(), tz))} – ${humanDate(endKey)}`,
            },
            upcomingCount: upcoming.length,
            alreadyOutCount: all.length - upcoming.length,
            // Each day carries the ids sitting on it, so a count can be turned
            // into named, clickable posts without a second tool call.
            perDay: days.map(({ date, day, count, items }) => ({
              date,
              day,
              count,
              postIds: items.filter((e) => e.kind === 'post').map((e) => e.id),
            })),
            perPlatform,
            emptyDays: emptyDays.map((d) => ({ date: d, day: humanDate(d) })),
            // Only a real peak is worth naming. Two posts against one is not a
            // pattern, it is four posts in a week — calling it "your busiest
            // day" dresses arithmetic up as insight.
            busiestDay:
              busiest && busiest.count >= BUSIEST_DAY_MIN_COUNT
                ? { date: busiest.date, day: busiest.day, count: busiest.count }
                : null,
            activeCampaignsWithNoPosts: idle.map((c) => c.name),
            postsOutsideThisWindow: elsewhere,
            // There is no target to measure against, so "enough" is not a
            // question this data can answer. Said as a fact rather than left
            // to the prompt, because the prompt asked and was ignored.
            canJudgeSufficiency: false,
            noTargetCadenceReason:
              'This workspace has no posting-frequency target set, so whether this is enough is not something the calendar can answer. Say so plainly and offer to compare against a target if the user names one.',
          },
          [
            ...chips,
            ...idle.map((c) => ({
              kind: 'campaign' as const,
              id: c.id,
              label: c.name,
              status: 'active',
            })),
          ],
        );
      },
    },
  ];
}
