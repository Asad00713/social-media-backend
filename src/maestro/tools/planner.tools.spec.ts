import type { PostService } from '../../posts/services/post.service';
import type { ScheduledMessagesService } from '../../inbox/services/scheduled-messages.service';
import type { DripService } from '../../drips/drip.service';
import type { WorkspaceService } from '../../workspace/workspace.service';
import type { CampaignsService } from '../../campaigns/campaigns.service';
import type { AgentToolDefinition, ToolContext } from '../maestro.types';
import { createPlannerTools } from './planner.tools';
import { isReferencePayload, type ReferencePayload } from './references';

const CTX: ToolContext = { userId: 'u1', workspaceId: 'ws-1' };

/** A post row as getCalendarPosts returns it — only the fields the tool reads. */
function postRow(over: Record<string, unknown> = {}) {
  return {
    id: 'p-1',
    workspaceId: 'ws-1',
    content: 'Autumn collection is live',
    status: 'scheduled',
    scheduledAt: new Date('2026-09-02T09:00:00.000Z'),
    publishedAt: null,
    targets: [{ platform: 'instagram' }],
    platformContent: {},
    ...over,
  };
}

function scheduledMessage(over: Record<string, unknown> = {}) {
  return {
    id: 'm-1',
    workspaceId: 'ws-1',
    channelId: 2,
    type: 'dm',
    threadKey: '2:conv',
    scheduledAt: '2026-09-03T14:00:00.000Z',
    status: 'pending',
    text: 'Following up on your question',
    textPreview: 'Following up on your question',
    targetLabel: 'Omar Hassan',
    platform: 'facebook',
    ...over,
  };
}

function dripPost(over: Record<string, unknown> = {}) {
  return {
    id: 'd-1',
    campaignId: 'c-1',
    campaignName: 'Weekly Tips',
    scheduledAt: '2026-09-04T08:00:00.000Z',
    status: 'scheduled',
    platforms: ['twitter'],
    content: 'Tip of the week',
    ...over,
  };
}

interface Recorded {
  method: string;
  workspaceId: string;
  userId?: string;
  from?: Date;
  to?: Date;
}

/**
 * Stand-ins for the three services the Planner merges.
 *
 * Each filters by workspace the way the real service does, so a tool that
 * leaked a caller-supplied workspace id would return the wrong rows rather
 * than silently passing.
 */
function fakeDeps(
  data: {
    posts?: ReturnType<typeof postRow>[];
    messages?: ReturnType<typeof scheduledMessage>[];
    drips?: ReturnType<typeof dripPost>[];
    /** The workspace's zone. Defaults to UTC so existing cases are unchanged. */
    timezone?: string;
    /** Every post the workspace holds, however far outside the window. */
    totalWorkspacePosts?: number;
    /** Campaigns the workspace holds, for the idle-campaign check. */
    campaigns?: {
      id: string;
      name: string;
      status: string;
      postsPlanned: number;
    }[];
  },
  calls: Recorded[] = [],
) {
  const guard = (workspaceId: string) => {
    if (workspaceId !== CTX.workspaceId) throw new Error('Forbidden');
  };

  return {
    posts: {
      getCalendarPosts: (workspaceId: string, from: Date, to: Date) => {
        calls.push({ method: 'getCalendarPosts', workspaceId, from, to });
        guard(workspaceId);
        return Promise.resolve(
          (data.posts ?? []).filter((p) => {
            const at = (p.publishedAt ?? p.scheduledAt) as Date | null;
            return at ? at >= from && at <= to : false;
          }),
        );
      },
      getWorkspacePosts: (workspaceId: string) => {
        calls.push({ method: 'getWorkspacePosts', workspaceId });
        guard(workspaceId);
        return Promise.resolve({
          posts: [],
          total: data.totalWorkspacePosts ?? (data.posts ?? []).length,
        });
      },
      getPost: (id: string, workspaceId: string) => {
        calls.push({ method: 'getPost', workspaceId });
        guard(workspaceId);
        const found = (data.posts ?? []).find((p) => p.id === id);
        return found
          ? Promise.resolve(found)
          : Promise.reject(new Error('Not found'));
      },
    } as unknown as PostService,

    scheduledMessages: {
      list: (workspaceId: string, userId: string) => {
        calls.push({ method: 'list', workspaceId, userId });
        guard(workspaceId);
        if (userId !== CTX.userId) throw new Error('Forbidden');
        return Promise.resolve(data.messages ?? []);
      },
    } as unknown as ScheduledMessagesService,

    drips: {
      getWorkspaceScheduledDripPosts: (
        workspaceId: string,
        from: Date,
        to: Date,
      ) => {
        calls.push({
          method: 'getWorkspaceScheduledDripPosts',
          workspaceId,
          from,
          to,
        });
        guard(workspaceId);
        return Promise.resolve(
          (data.drips ?? []).filter((d) => {
            const at = new Date(d.scheduledAt);
            return at >= from && at <= to;
          }),
        );
      },
    } as unknown as DripService,

    workspaces: {
      findOne: (workspaceId: string, userId: string) => {
        calls.push({ method: 'findOne', workspaceId, userId });
        guard(workspaceId);
        return Promise.resolve({ timezone: data.timezone ?? 'UTC' });
      },
    } as unknown as WorkspaceService,

    campaigns: {
      list: (workspaceId: string, filters: { status?: string } = {}) => {
        calls.push({ method: 'campaignList', workspaceId });
        guard(workspaceId);
        return Promise.resolve(
          (data.campaigns ?? [])
            .filter((c) => !filters.status || c.status === filters.status)
            .map((c) => ({
              id: c.id,
              name: c.name,
              status: c.status,
              metrics: { postsPlanned: c.postsPlanned },
            })),
        );
      },
    } as unknown as CampaignsService,
  };
}

function toolNamed(tools: AgentToolDefinition[], name: string) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`No tool named ${name}`);
  return tool;
}

function payload(result: unknown): ReferencePayload {
  if (!isReferencePayload(result)) {
    throw new Error(
      `Expected a reference payload, got ${JSON.stringify(result)}`,
    );
  }
  return result;
}

interface PlannerRow {
  id: string;
  kind: 'post' | 'message' | 'drip';
  scheduledAt: string;
  date: string;
  localTime: string;
  status: string;
  platforms: string[];
  content: string;
  campaignName?: string;
  target?: string;
  settled: boolean;
}

interface DayLabel {
  date: string;
  day: string;
}

interface ListData {
  range: { from: string; to: string; timeZone: string; label: string };
  total: number;
  showing: number;
  upcomingCount: number;
  alreadyOutCount: number;
  upcoming: PlannerRow[];
  alreadyOut: PlannerRow[];
  byDate: { date: string; day: string; count: number; items: PlannerRow[] }[];
  filteredByPlatform?: string;
}

interface SummaryData {
  range: { timeZone: string; label: string };
  activeCampaignsWithNoPosts: string[];
  postsOutsideThisWindow: number;
  upcomingCount: number;
  alreadyOutCount: number;
  perDay: { date: string; day: string; count: number }[];
  perPlatform: Record<string, number>;
  emptyDays: DayLabel[];
  busiestDay: { date: string; day: string; count: number } | null;
}

function dataOf<T>(result: unknown): T {
  return payload(result).data as T;
}

/** A range wide enough to hold every fixture above. */
const WIDE = { from: '2026-09-01', to: '2026-09-30' };

describe('list_scheduled', () => {
  it('merges all three sources the Planner shows', async () => {
    const tools = createPlannerTools(
      fakeDeps({
        posts: [postRow()],
        messages: [scheduledMessage()],
        drips: [dripPost()],
      }),
    );

    const data = dataOf<ListData>(
      await toolNamed(tools, 'list_scheduled').handler(WIDE, CTX),
    );

    expect(data.total).toBe(3);
    expect(data.upcoming.map((e) => e.kind).sort()).toEqual([
      'drip',
      'message',
      'post',
    ]);
  });

  it('orders entries by when they fire, across sources', async () => {
    const tools = createPlannerTools(
      fakeDeps({
        // Deliberately out of order, and interleaved across sources.
        drips: [
          dripPost({ id: 'd-late', scheduledAt: '2026-09-10T08:00:00.000Z' }),
        ],
        posts: [
          postRow({
            id: 'p-early',
            scheduledAt: new Date('2026-09-02T09:00:00.000Z'),
          }),
        ],
        messages: [
          scheduledMessage({
            id: 'm-mid',
            scheduledAt: '2026-09-05T14:00:00.000Z',
          }),
        ],
      }),
    );

    const data = dataOf<ListData>(
      await toolNamed(tools, 'list_scheduled').handler(WIDE, CTX),
    );

    expect(data.upcoming.map((e) => e.id)).toEqual([
      'p-early',
      'm-mid',
      'd-late',
    ]);
  });

  /**
   * The bug this locks down: the calendar query returns five statuses, not just
   * `scheduled`. Reporting the total as though it were all still to come would
   * tell the user "3 posts scheduled" when two already went out — the same
   * class of error as counting messages as conversations.
   */
  it('separates what is still to fire from what already went out', async () => {
    const tools = createPlannerTools(
      fakeDeps({
        posts: [
          postRow({ id: 'p-sched', status: 'scheduled' }),
          postRow({
            id: 'p-done',
            status: 'published',
            scheduledAt: null,
            publishedAt: new Date('2026-09-01T09:00:00.000Z'),
          }),
          postRow({
            id: 'p-failed',
            status: 'failed',
            publishedAt: new Date('2026-09-01T10:00:00.000Z'),
          }),
        ],
      }),
    );

    const data = dataOf<ListData>(
      await toolNamed(tools, 'list_scheduled').handler(WIDE, CTX),
    );

    expect(data.upcomingCount).toBe(1);
    expect(data.alreadyOutCount).toBe(2);
    expect(data.upcoming[0].id).toBe('p-sched');
  });

  // A "post now" has no scheduledAt; keying on that alone drops it entirely.
  it('places an immediately-published post by its published time', async () => {
    const tools = createPlannerTools(
      fakeDeps({
        posts: [
          postRow({
            id: 'p-now',
            status: 'published',
            scheduledAt: null,
            publishedAt: new Date('2026-09-03T11:30:00.000Z'),
          }),
        ],
      }),
    );

    const data = dataOf<ListData>(
      await toolNamed(tools, 'list_scheduled').handler(WIDE, CTX),
    );

    expect(data.alreadyOut[0].date).toBe('2026-09-03');
  });

  it('groups upcoming entries by the day they occupy', async () => {
    const tools = createPlannerTools(
      fakeDeps({
        posts: [
          postRow({
            id: 'p-1',
            scheduledAt: new Date('2026-09-02T09:00:00.000Z'),
          }),
          postRow({
            id: 'p-2',
            scheduledAt: new Date('2026-09-02T17:00:00.000Z'),
          }),
          postRow({
            id: 'p-3',
            scheduledAt: new Date('2026-09-05T09:00:00.000Z'),
          }),
        ],
      }),
    );

    const data = dataOf<ListData>(
      await toolNamed(tools, 'list_scheduled').handler(WIDE, CTX),
    );

    expect(data.byDate).toEqual([
      expect.objectContaining({ date: '2026-09-02', count: 2 }),
      expect.objectContaining({ date: '2026-09-05', count: 1 }),
    ]);
  });

  it('filters by platform', async () => {
    const tools = createPlannerTools(
      fakeDeps({
        posts: [postRow({ id: 'p-ig', targets: [{ platform: 'instagram' }] })],
        drips: [dripPost({ id: 'd-tw', platforms: ['twitter'] })],
      }),
    );

    const data = dataOf<ListData>(
      await toolNamed(tools, 'list_scheduled').handler(
        { ...WIDE, platform: 'instagram' },
        CTX,
      ),
    );

    expect(data.showing).toBe(1);
    expect(data.upcoming[0].id).toBe('p-ig');
    expect(data.filteredByPlatform).toBe('instagram');
  });

  /**
   * A bare `to` date means the whole of that day. Treating it as midnight would
   * report an empty day the Planner shows as full.
   */
  it('includes entries later in the day named as the end of the range', async () => {
    const tools = createPlannerTools(
      fakeDeps({
        posts: [
          postRow({
            id: 'p-evening',
            scheduledAt: new Date('2026-09-02T23:30:00.000Z'),
          }),
        ],
      }),
    );

    const data = dataOf<ListData>(
      await toolNamed(tools, 'list_scheduled').handler(
        { from: '2026-09-02', to: '2026-09-02' },
        CTX,
      ),
    );

    expect(data.showing).toBe(1);
  });

  // Seven CALENDAR days counting today — not seven times twenty-four hours,
  // which from a mid-afternoon "now" spills into an eighth day and puts the
  // same weekday at both ends of "this week".
  it('defaults to a week ahead when no dates are given', async () => {
    const calls: Recorded[] = [];
    const tools = createPlannerTools(fakeDeps({}, calls));

    await toolNamed(tools, 'list_scheduled').handler({}, CTX);

    const call = calls.find((c) => c.method === 'getCalendarPosts')!;
    const dayOf = (d: Date) => d.toISOString().slice(0, 10);
    const span =
      (Date.parse(`${dayOf(call.to!)}T00:00:00Z`) -
        Date.parse(`${dayOf(call.from!)}T00:00:00Z`)) /
      86_400_000;
    expect(span + 1).toBe(7);
  });

  // One question must not be able to pull a year of posts into the context.
  it('caps an over-long range', async () => {
    const calls: Recorded[] = [];
    const tools = createPlannerTools(fakeDeps({}, calls));

    await toolNamed(tools, 'list_scheduled').handler(
      { from: '2026-01-01', to: '2027-01-01' },
      CTX,
    );

    const call = calls.find((c) => c.method === 'getCalendarPosts')!;
    const days = (call.to!.getTime() - call.from!.getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(90);
  });

  // Messages are listed outright, not queried by date, so the tool windows them.
  it('drops a scheduled message outside the range', async () => {
    const tools = createPlannerTools(
      fakeDeps({
        messages: [
          scheduledMessage({
            id: 'm-in',
            scheduledAt: '2026-09-03T14:00:00.000Z',
          }),
          scheduledMessage({
            id: 'm-out',
            scheduledAt: '2026-12-25T14:00:00.000Z',
          }),
        ],
      }),
    );

    const data = dataOf<ListData>(
      await toolNamed(tools, 'list_scheduled').handler(WIDE, CTX),
    );

    expect(data.upcoming.map((e) => e.id)).toEqual(['m-in']);
  });

  it('carries the campaign name onto a drip entry', async () => {
    const tools = createPlannerTools(fakeDeps({ drips: [dripPost()] }));

    const data = dataOf<ListData>(
      await toolNamed(tools, 'list_scheduled').handler(WIDE, CTX),
    );

    expect(data.upcoming[0].campaignName).toBe('Weekly Tips');
  });

  it('carries who a scheduled message is addressed to', async () => {
    const tools = createPlannerTools(
      fakeDeps({ messages: [scheduledMessage()] }),
    );

    const data = dataOf<ListData>(
      await toolNamed(tools, 'list_scheduled').handler(WIDE, CTX),
    );

    expect(data.upcoming[0].target).toBe('Omar Hassan');
  });

  /**
   * Only posts have a detail page. A scheduled message has no route of its own
   * and a drip post is not addressable until it materialises, so citing either
   * would render a chip that goes nowhere.
   */
  it('cites posts only, never entries with no page to open', async () => {
    const tools = createPlannerTools(
      fakeDeps({
        posts: [postRow({ id: 'p-1' })],
        messages: [scheduledMessage()],
        drips: [dripPost()],
      }),
    );

    const refs = payload(
      await toolNamed(tools, 'list_scheduled').handler(WIDE, CTX),
    ).refs;

    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ kind: 'post', id: 'p-1' });
  });

  it('trims the merged list to the limit', async () => {
    const tools = createPlannerTools(
      fakeDeps({
        posts: [
          postRow({
            id: 'p-1',
            scheduledAt: new Date('2026-09-02T09:00:00.000Z'),
          }),
          postRow({
            id: 'p-2',
            scheduledAt: new Date('2026-09-03T09:00:00.000Z'),
          }),
          postRow({
            id: 'p-3',
            scheduledAt: new Date('2026-09-04T09:00:00.000Z'),
          }),
        ],
      }),
    );

    const data = dataOf<ListData>(
      await toolNamed(tools, 'list_scheduled').handler(
        { ...WIDE, limit: 2 },
        CTX,
      ),
    );

    expect(data.showing).toBe(2);
    expect(data.total).toBe(3);
    // The earliest survive: the limit trims the tail, not the head.
    expect(data.upcoming.map((e) => e.id)).toEqual(['p-1', 'p-2']);
  });

  it('reads the caller workspace, ignoring any workspaceId argument', async () => {
    const calls: Recorded[] = [];
    const tools = createPlannerTools(fakeDeps({}, calls));

    await toolNamed(tools, 'list_scheduled').handler(
      { ...WIDE, workspaceId: 'ws-someone-else' },
      CTX,
    );

    expect(calls.every((c) => c.workspaceId === 'ws-1')).toBe(true);
  });

  it('passes the caller userId, ignoring any userId argument', async () => {
    const calls: Recorded[] = [];
    const tools = createPlannerTools(fakeDeps({}, calls));

    await toolNamed(tools, 'list_scheduled').handler(
      { ...WIDE, userId: 'u-someone-else' },
      CTX,
    );

    expect(
      calls
        .filter((c) => c.userId !== undefined)
        .every((c) => c.userId === 'u1'),
    ).toBe(true);
  });
});

describe('get_schedule_summary', () => {
  it('counts only what is still to go out', async () => {
    const tools = createPlannerTools(
      fakeDeps({
        posts: [
          postRow({ id: 'p-sched', status: 'scheduled' }),
          postRow({
            id: 'p-done',
            status: 'published',
            publishedAt: new Date('2026-09-01T09:00:00.000Z'),
          }),
        ],
      }),
    );

    const result = dataOf<SummaryData>(
      await toolNamed(tools, 'get_schedule_summary').handler(WIDE, CTX),
    );

    expect(result.upcomingCount).toBe(1);
    expect(result.alreadyOutCount).toBe(1);
  });

  it('counts per platform across every source', async () => {
    const tools = createPlannerTools(
      fakeDeps({
        posts: [postRow({ targets: [{ platform: 'instagram' }] })],
        drips: [dripPost({ platforms: ['instagram', 'twitter'] })],
      }),
    );

    const result = dataOf<SummaryData>(
      await toolNamed(tools, 'get_schedule_summary').handler(WIDE, CTX),
    );

    expect(result.perPlatform).toEqual({ instagram: 2, twitter: 1 });
  });

  // "Which days am I not posting" is the question behind most summary asks.
  it('names the days in range with nothing scheduled', async () => {
    const tools = createPlannerTools(
      fakeDeps({
        posts: [postRow({ scheduledAt: new Date('2026-09-02T09:00:00.000Z') })],
      }),
    );

    const result = dataOf<SummaryData>(
      await toolNamed(tools, 'get_schedule_summary').handler(
        { from: '2026-09-01', to: '2026-09-03' },
        CTX,
      ),
    );

    expect(result.emptyDays.map((d) => d.date)).toEqual([
      '2026-09-01',
      '2026-09-03',
    ]);
  });

  it('names the busiest day', async () => {
    const tools = createPlannerTools(
      fakeDeps({
        posts: [
          postRow({
            id: 'p-1',
            scheduledAt: new Date('2026-09-02T09:00:00.000Z'),
          }),
          postRow({
            id: 'p-2',
            scheduledAt: new Date('2026-09-05T09:00:00.000Z'),
          }),
          postRow({
            id: 'p-3',
            scheduledAt: new Date('2026-09-05T17:00:00.000Z'),
          }),
        ],
      }),
    );

    const result = dataOf<SummaryData>(
      await toolNamed(tools, 'get_schedule_summary').handler(WIDE, CTX),
    );

    expect(result.busiestDay?.date).toBe('2026-09-05');
    expect(result.busiestDay?.count).toBe(2);
  });

  it('reports an empty calendar without inventing a busiest day', async () => {
    const tools = createPlannerTools(fakeDeps({}));

    const result = dataOf<SummaryData>(
      await toolNamed(tools, 'get_schedule_summary').handler(
        { from: '2026-09-01', to: '2026-09-02' },
        CTX,
      ),
    );

    expect(result.upcomingCount).toBe(0);
    expect(result.busiestDay).toBeNull();
    expect(result.emptyDays.map((d) => d.date)).toEqual([
      '2026-09-01',
      '2026-09-02',
    ]);
  });

  it('reads the caller workspace, ignoring any workspaceId argument', async () => {
    const calls: Recorded[] = [];
    const tools = createPlannerTools(fakeDeps({}, calls));

    await toolNamed(tools, 'get_schedule_summary').handler(
      { ...WIDE, workspaceId: 'ws-someone-else' },
      CTX,
    );

    expect(calls.every((c) => c.workspaceId === 'ws-1')).toBe(true);
  });
});

/**
 * The count and the list read the same rows through one collector, so they
 * cannot disagree. A summary saying "5 upcoming" beside a list showing 3 is
 * exactly what made the agent contradict the Inbox screen.
 */
describe('the two tools agree', () => {
  it('reports the same upcoming count from both', async () => {
    const fixtures = {
      posts: [
        postRow({ id: 'p-1' }),
        postRow({
          id: 'p-done',
          status: 'published',
          publishedAt: new Date('2026-09-01T09:00:00.000Z'),
        }),
      ],
      messages: [scheduledMessage()],
      drips: [dripPost()],
    };

    const listData = dataOf<ListData>(
      await toolNamed(
        createPlannerTools(fakeDeps(fixtures)),
        'list_scheduled',
      ).handler(WIDE, CTX),
    );
    const summary = dataOf<SummaryData>(
      await toolNamed(
        createPlannerTools(fakeDeps(fixtures)),
        'get_schedule_summary',
      ).handler(WIDE, CTX),
    );

    expect(summary.upcomingCount).toBe(listData.upcomingCount);
    expect(summary.alreadyOutCount).toBe(listData.alreadyOutCount);
  });
});

/**
 * The agent is told neither today's date nor the workspace's zone, so every
 * time and weekday it says has to arrive pre-formatted. Live, it read UTC
 * hours aloud (9:00 AM for a post the Planner showed at 2:00 PM) and named
 * weekdays it had worked out itself — all three wrong.
 */
describe('times the workspace would recognise', () => {
  const KARACHI = 'Asia/Karachi'; // UTC+5, no DST — stable to assert against.

  it('states the time in the workspace zone, not UTC', async () => {
    const tools = createPlannerTools(
      fakeDeps({
        timezone: KARACHI,
        // 09:00 UTC is 2:00 PM in Karachi — the hour the Planner shows.
        posts: [postRow({ scheduledAt: new Date('2026-09-02T09:00:00.000Z') })],
      }),
    );

    const data = dataOf<ListData>(
      await toolNamed(tools, 'list_scheduled').handler(WIDE, CTX),
    );

    expect(data.upcoming[0].localTime).toContain('2:00 PM');
    expect(data.upcoming[0].localTime).not.toContain('9:00 AM');
  });

  it('carries the weekday, so the model never has to work one out', async () => {
    const tools = createPlannerTools(
      fakeDeps({
        timezone: KARACHI,
        // 2 September 2026 is a Wednesday.
        posts: [postRow({ scheduledAt: new Date('2026-09-02T09:00:00.000Z') })],
      }),
    );

    const data = dataOf<ListData>(
      await toolNamed(tools, 'list_scheduled').handler(WIDE, CTX),
    );

    expect(data.upcoming[0].localTime).toContain('Wed');
    expect(data.byDate[0].day).toBe('Wednesday, Sep 2');
  });

  /**
   * The bug that survives a correct clock: an evening post is the previous
   * day in UTC, so slicing the ISO string files it under the wrong date and
   * the day it belongs to looks empty.
   */
  it('files a late-evening post on the local day, not the UTC one', async () => {
    const tools = createPlannerTools(
      fakeDeps({
        timezone: KARACHI,
        // 22:00 on the 2nd in Karachi is 17:00 UTC on the 2nd...
        posts: [
          postRow({
            id: 'p-evening',
            scheduledAt: new Date('2026-09-02T17:00:00.000Z'),
          }),
          // ...and 1:00 AM on the 3rd in Karachi is 20:00 UTC on the 2nd.
          postRow({
            id: 'p-after-midnight',
            scheduledAt: new Date('2026-09-02T20:00:00.000Z'),
          }),
        ],
      }),
    );

    const data = dataOf<ListData>(
      await toolNamed(tools, 'list_scheduled').handler(WIDE, CTX),
    );

    const byId = new Map(data.upcoming.map((e) => [e.id, e.date]));
    expect(byId.get('p-evening')).toBe('2026-09-02');
    // Both are 2 September in UTC; only one of them is, locally.
    expect(byId.get('p-after-midnight')).toBe('2026-09-03');
  });

  it('names the zone it answered in', async () => {
    const tools = createPlannerTools(fakeDeps({ timezone: KARACHI }));

    const data = dataOf<ListData>(
      await toolNamed(tools, 'list_scheduled').handler(WIDE, CTX),
    );

    expect(data.range.timeZone).toBe(KARACHI);
    expect(data.range.label).toContain('Sep');
  });

  it('falls back to UTC rather than failing on an unknown zone', async () => {
    const tools = createPlannerTools(
      fakeDeps({
        timezone: 'Mars/Olympus_Mons',
        posts: [postRow({ scheduledAt: new Date('2026-09-02T09:00:00.000Z') })],
      }),
    );

    const data = dataOf<ListData>(
      await toolNamed(tools, 'list_scheduled').handler(WIDE, CTX),
    );

    expect(data.range.timeZone).toBe('UTC');
    expect(data.upcoming[0].localTime).toContain('9:00 AM');
  });
});

describe('claims the numbers actually support', () => {
  // Live, it called a 2-post day "busiest" out of four days holding one post
  // each — a pattern read into an even spread.
  it('names no busiest day when every day carries the same count', async () => {
    const tools = createPlannerTools(
      fakeDeps({
        posts: [
          postRow({
            id: 'p-1',
            scheduledAt: new Date('2026-09-02T09:00:00.000Z'),
          }),
          postRow({
            id: 'p-2',
            scheduledAt: new Date('2026-09-05T09:00:00.000Z'),
          }),
        ],
      }),
    );

    const result = dataOf<SummaryData>(
      await toolNamed(tools, 'get_schedule_summary').handler(WIDE, CTX),
    );

    expect(result.busiestDay).toBeNull();
  });

  // Telling someone to fill a day they are standing in is not advice.
  it('leaves today out of the empty days', async () => {
    const now = new Date();
    const tools = createPlannerTools(fakeDeps({}));

    const result = dataOf<SummaryData>(
      await toolNamed(tools, 'get_schedule_summary').handler({}, CTX),
    );

    const today = now.toISOString().slice(0, 10);
    expect(result.emptyDays.map((d) => d.date)).not.toContain(today);
    // The rest of the window is still reported.
    expect(result.emptyDays.length).toBeGreaterThan(0);
  });
});

/**
 * A campaign that is active but has nothing planned publishes nothing, quietly.
 * It looks healthy on the Campaigns page, so the only way anyone finds out is
 * by comparing two screens — which is exactly the kind of thing the agent
 * should say without being asked.
 */
describe('an active campaign that will publish nothing', () => {
  it('names it, and cites it so the user can open it', async () => {
    const tools = createPlannerTools(
      fakeDeps({
        campaigns: [
          {
            id: 'c-idle',
            name: 'Autumn Launch',
            status: 'active',
            postsPlanned: 0,
          },
        ],
      }),
    );

    const result = await toolNamed(tools, 'get_schedule_summary').handler(
      WIDE,
      CTX,
    );

    expect(dataOf<SummaryData>(result).activeCampaignsWithNoPosts).toEqual([
      'Autumn Launch',
    ]);
    expect(payload(result).refs).toEqual([
      expect.objectContaining({
        kind: 'campaign',
        id: 'c-idle',
        label: 'Autumn Launch',
      }),
    ]);
  });

  it('stays quiet about an active campaign that has posts planned', async () => {
    const tools = createPlannerTools(
      fakeDeps({
        campaigns: [
          {
            id: 'c-ok',
            name: 'Weekly Tips',
            status: 'active',
            postsPlanned: 12,
          },
        ],
      }),
    );

    const result = dataOf<SummaryData>(
      await toolNamed(tools, 'get_schedule_summary').handler(WIDE, CTX),
    );

    expect(result.activeCampaignsWithNoPosts).toEqual([]);
  });

  // A paused or draft campaign is not running, so it is not failing to run.
  it('ignores campaigns that are not active', async () => {
    const tools = createPlannerTools(
      fakeDeps({
        campaigns: [
          {
            id: 'c-draft',
            name: 'Evergreen Quotes',
            status: 'draft',
            postsPlanned: 0,
          },
          {
            id: 'c-paused',
            name: 'Weekly Tips',
            status: 'paused',
            postsPlanned: 0,
          },
        ],
      }),
    );

    const result = dataOf<SummaryData>(
      await toolNamed(tools, 'get_schedule_summary').handler(WIDE, CTX),
    );

    expect(result.activeCampaignsWithNoPosts).toEqual([]);
  });

  // The calendar answer is the point; a campaigns read failing must not take it.
  it('still answers when the campaigns read fails', async () => {
    const deps = fakeDeps({
      posts: [postRow({ scheduledAt: new Date('2026-09-02T09:00:00.000Z') })],
    });
    const broken = {
      ...deps,
      campaigns: {
        list: () => Promise.reject(new Error('campaigns down')),
      } as unknown as CampaignsService,
    };

    const result = dataOf<SummaryData>(
      await toolNamed(
        createPlannerTools(broken),
        'get_schedule_summary',
      ).handler(WIDE, CTX),
    );

    expect(result.upcomingCount).toBe(1);
    expect(result.activeCampaignsWithNoPosts).toEqual([]);
  });
});

/**
 * The default window used to add a full 7 days to "now", which reaches into an
 * eighth calendar day and put the same weekday at both ends — the answer named
 * "Monday" as empty and the user could not tell whether that meant today or a
 * week from today.
 */
describe('the week is seven days, not eight', () => {
  it("never names today, or today's weekday a week out, as empty", async () => {
    const tools = createPlannerTools(fakeDeps({}));

    const result = dataOf<SummaryData>(
      await toolNamed(tools, 'get_schedule_summary').handler({}, CTX),
    );

    const days = result.emptyDays.map((d) => d.date);
    const weekdayOf = (key: string) =>
      new Intl.DateTimeFormat('en-US', {
        timeZone: 'UTC',
        weekday: 'long',
      }).format(new Date(`${key}T12:00:00Z`));

    // Today is excluded outright...
    const today = new Date().toISOString().slice(0, 10);
    expect(days).not.toContain(today);
    // ...and no weekday appears twice, so "Monday" can only mean one day.
    const weekdays = days.map(weekdayOf);
    expect(new Set(weekdays).size).toBe(weekdays.length);
  });

  it('gives every empty day a date, never a bare weekday', async () => {
    const tools = createPlannerTools(fakeDeps({}));

    const result = dataOf<SummaryData>(
      await toolNamed(tools, 'get_schedule_summary').handler({}, CTX),
    );

    expect(result.emptyDays.length).toBeGreaterThan(0);
    for (const d of result.emptyDays) {
      // "Wednesday, Sep 2" — weekday AND date, so it cannot be misread.
      expect(d.day).toMatch(/^[A-Z][a-z]+day, [A-Z][a-z]{2} \d{1,2}$/);
    }
  });
});

/**
 * The Planner's filter chips count every post the workspace holds; a week's
 * answer counts the week. Both are right and the user cannot see why, so the
 * difference is volunteered rather than waiting to be challenged.
 */
describe('posts outside the window being reported', () => {
  it('counts the ones the window does not cover', async () => {
    const tools = createPlannerTools(
      fakeDeps({
        posts: [postRow({ scheduledAt: new Date('2026-09-02T09:00:00.000Z') })],
        // Four in the workspace, one of them inside this window.
        totalWorkspacePosts: 4,
      }),
    );

    const result = dataOf<SummaryData>(
      await toolNamed(tools, 'get_schedule_summary').handler(WIDE, CTX),
    );

    expect(result.upcomingCount).toBe(1);
    expect(result.postsOutsideThisWindow).toBe(3);
  });

  it('reports none when the window already holds them all', async () => {
    const tools = createPlannerTools(
      fakeDeps({
        posts: [postRow({ scheduledAt: new Date('2026-09-02T09:00:00.000Z') })],
        totalWorkspacePosts: 1,
      }),
    );

    const result = dataOf<SummaryData>(
      await toolNamed(tools, 'get_schedule_summary').handler(WIDE, CTX),
    );

    expect(result.postsOutsideThisWindow).toBe(0);
  });

  // A count that cannot be read must not cost the user their calendar answer.
  it('still answers when the workspace count fails', async () => {
    const base = fakeDeps({
      posts: [postRow({ scheduledAt: new Date('2026-09-02T09:00:00.000Z') })],
    });
    const broken = {
      ...base,
      posts: {
        ...base.posts,
        getWorkspacePosts: () => Promise.reject(new Error('down')),
      } as unknown as PostService,
    };

    const result = dataOf<SummaryData>(
      await toolNamed(
        createPlannerTools(broken),
        'get_schedule_summary',
      ).handler(WIDE, CTX),
    );

    expect(result.upcomingCount).toBe(1);
    expect(result.postsOutsideThisWindow).toBe(0);
  });
});
