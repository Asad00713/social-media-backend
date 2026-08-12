import { getTableName } from 'drizzle-orm';
import { CampaignsService } from './campaigns.service';
import type { ChannelDayContentJson } from '../drizzle/schema/campaigns.schema';
import type { CampaignDay, CampaignSlotContent } from '../drizzle/schema/campaigns.schema';
import type { CampaignScheduleJson } from '../drizzle/schema/campaigns.schema';

// ==========================================================================
// Pure-helper tests — no DB. These exercise isSlotFilled / computeMetrics /
// computeNextRun directly, mirroring the frontend's isChannelDayFilled +
// campaign-days/campaign-dates logic.
// ==========================================================================

function content(overrides: Partial<ChannelDayContentJson>): ChannelDayContentJson {
  return {
    mode: 'manual',
    postType: 'text',
    caption: '',
    media: [],
    threadParts: [],
    templateIds: [],
    ...overrides,
  };
}

describe('CampaignsService.isSlotFilled', () => {
  // Pure-helper tests never touch the injected CampaignPublishingService —
  // undefined is safe here, cast away since the constructor param is typed
  // required for real (module-wired) construction.
  const service = new CampaignsService(undefined as never);

  it('returns false for undefined content', () => {
    expect(service.isSlotFilled(undefined as unknown as ChannelDayContentJson)).toBe(false);
  });

  it('ai mode is always filled', () => {
    expect(service.isSlotFilled(content({ mode: 'ai' }))).toBe(true);
  });

  it('library mode is filled only when templateIds is non-empty', () => {
    expect(service.isSlotFilled(content({ mode: 'library', templateIds: [] }))).toBe(false);
    expect(service.isSlotFilled(content({ mode: 'library', templateIds: ['tpl-1'] }))).toBe(true);
  });

  it('poll postType is filled when question is non-blank', () => {
    expect(
      service.isSlotFilled(
        content({
          postType: 'poll',
          poll: { question: '', options: ['a', 'b'], durationDays: 1 },
        }),
      ),
    ).toBe(false);
    expect(
      service.isSlotFilled(
        content({
          postType: 'poll',
          poll: { question: '   ', options: ['a', 'b'], durationDays: 1 },
        }),
      ),
    ).toBe(false);
    expect(
      service.isSlotFilled(
        content({
          postType: 'poll',
          poll: { question: 'Pick one', options: ['a', 'b'], durationDays: 1 },
        }),
      ),
    ).toBe(true);
  });

  it('poll postType with no poll object is not filled', () => {
    expect(service.isSlotFilled(content({ postType: 'poll' }))).toBe(false);
  });

  it('thread postType is filled only by non-blank caption (media does not count)', () => {
    expect(service.isSlotFilled(content({ postType: 'thread', caption: '' }))).toBe(false);
    expect(
      service.isSlotFilled(
        content({
          postType: 'thread',
          caption: '',
          media: [{ id: 'm1', filename: 'a.png', kind: 'image' }],
        }),
      ),
    ).toBe(false);
    expect(service.isSlotFilled(content({ postType: 'thread', caption: 'Part 1' }))).toBe(true);
  });

  it('manual text is filled by non-blank caption', () => {
    expect(service.isSlotFilled(content({ postType: 'text', caption: '' }))).toBe(false);
    expect(service.isSlotFilled(content({ postType: 'text', caption: '   ' }))).toBe(false);
    expect(service.isSlotFilled(content({ postType: 'text', caption: 'Hello world' }))).toBe(true);
  });

  it('manual text is filled by having media even with empty caption', () => {
    expect(
      service.isSlotFilled(
        content({
          postType: 'image',
          caption: '',
          media: [{ id: 'm1', filename: 'a.png', kind: 'image' }],
        }),
      ),
    ).toBe(true);
  });

  it('empty manual content is not filled', () => {
    expect(service.isSlotFilled(content({}))).toBe(false);
  });
});

describe('CampaignsService.computeMetrics', () => {
  // Pure-helper tests never touch the injected CampaignPublishingService —
  // undefined is safe here, cast away since the constructor param is typed
  // required for real (module-wired) construction.
  const service = new CampaignsService(undefined as never);

  function day(date: string, skip = false): CampaignDay {
    return {
      id: `day-${date}`,
      campaignId: 'c1',
      date,
      skip,
      createdAt: new Date(),
    };
  }

  function slot(
    date: string,
    channelId: string,
    contentOverrides: Partial<ChannelDayContentJson>,
  ): CampaignSlotContent {
    return {
      id: `slot-${date}-${channelId}`,
      campaignId: 'c1',
      date,
      channelId,
      content: content(contentOverrides),
      scheduledAt: null,
      slotStatus: 'pending',
      postId: null,
      jobId: null,
      publishedAt: null,
      lastError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  it('counts filled slots on non-skipped days only', () => {
    const days = [day('2026-08-10', false), day('2026-08-11', true)];
    const slots = [
      slot('2026-08-10', 'ch-1', { caption: 'Hello' }), // filled, non-skipped -> counts
      slot('2026-08-10', 'ch-2', { caption: '' }), // not filled -> doesn't count
      slot('2026-08-11', 'ch-1', { caption: 'Should not count, day skipped' }), // skipped day
    ];

    const metrics = service.computeMetrics(days, slots);

    expect(metrics.postsPlanned).toBe(1);
    expect(metrics.postsPublished).toBe(0);
    expect(metrics.postsFailed).toBe(0);
    expect(metrics.postsSkipped).toBe(0);
  });

  it('slots on dates with no matching campaign_days row are treated as non-skipped', () => {
    const days: CampaignDay[] = [];
    const slots = [slot('2026-08-12', 'ch-1', { caption: 'Hello' })];

    const metrics = service.computeMetrics(days, slots);

    expect(metrics.postsPlanned).toBe(1);
  });

  it('returns all zero metrics for empty input', () => {
    const metrics = service.computeMetrics([], []);
    expect(metrics).toEqual({
      postsPlanned: 0,
      postsPublished: 0,
      postsFailed: 0,
      postsSkipped: 0,
    });
  });
});

describe('CampaignsService.computeNextRun', () => {
  // Pure-helper tests never touch the injected CampaignPublishingService —
  // undefined is safe here, cast away since the constructor param is typed
  // required for real (module-wired) construction.
  const service = new CampaignsService(undefined as never);

  const bulkSchedule = (start: string, end: string): CampaignScheduleJson => ({
    type: 'bulk',
    startDate: start,
    endDate: end,
    defaultTime: '10:00',
    timezone: 'UTC',
    blackoutDates: [],
    skipWeekends: false,
  });

  it('returns null when status is draft', () => {
    const schedule = bulkSchedule('2020-01-01', '2099-01-01');
    expect(service.computeNextRun(schedule, 'draft')).toBeNull();
  });

  it('returns null when status is paused', () => {
    const schedule = bulkSchedule('2020-01-01', '2099-01-01');
    expect(service.computeNextRun(schedule, 'paused')).toBeNull();
  });

  it('returns null when status is completed', () => {
    const schedule = bulkSchedule('2020-01-01', '2099-01-01');
    expect(service.computeNextRun(schedule, 'completed')).toBeNull();
  });

  it('returns a next firing ISO string for an active bulk schedule within range', () => {
    const schedule = bulkSchedule('2020-01-01', '2099-01-01');
    const next = service.computeNextRun(schedule, 'active');
    expect(next).not.toBeNull();
    expect(new Date(next as string).getTime()).toBeGreaterThan(Date.now());
  });

  it('returns null when the schedule window is fully in the past', () => {
    const schedule = bulkSchedule('2000-01-01', '2000-01-31');
    expect(service.computeNextRun(schedule, 'active')).toBeNull();
  });

  it('returns null when the schedule window is fully in the past even for scheduled status', () => {
    const schedule = bulkSchedule('2000-01-01', '2000-01-31');
    expect(service.computeNextRun(schedule, 'scheduled')).toBeNull();
  });

  it('honors skipWeekends by skipping Saturday/Sunday', () => {
    const schedule: CampaignScheduleJson = {
      ...bulkSchedule('2099-01-01', '2099-01-31'), // far future, deterministic window
      skipWeekends: true,
    };
    const next = service.computeNextRun(schedule, 'active');
    expect(next).not.toBeNull();
    const day = new Date(next as string).getUTCDay();
    expect(day).not.toBe(0);
    expect(day).not.toBe(6);
  });

  it('honors blackoutDates by skipping the listed date', () => {
    // Use a schedule that starts "now" conceptually but forces a specific
    // blacked-out first day using a far-future fixed window so the test is
    // deterministic regardless of when it runs.
    const schedule: CampaignScheduleJson = {
      type: 'bulk',
      startDate: '2099-06-01',
      endDate: '2099-06-03',
      defaultTime: '10:00',
      timezone: 'UTC',
      blackoutDates: ['2099-06-01'],
      skipWeekends: false,
    };
    const next = service.computeNextRun(schedule, 'active');
    expect(next).not.toBeNull();
    expect((next as string).startsWith('2099-06-01')).toBe(false);
  });

  it('returns a next firing for drip schedules honoring weekdays/times', () => {
    const schedule: CampaignScheduleJson = {
      type: 'drip',
      startDate: '2020-01-01',
      endDate: null,
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      times: ['09:00'],
      timezone: 'UTC',
      blackoutDates: [],
    };
    const next = service.computeNextRun(schedule, 'active');
    expect(next).not.toBeNull();
    expect(new Date(next as string).getTime()).toBeGreaterThan(Date.now());
  });

  it('returns null for drip when weekdays/times are empty', () => {
    const schedule: CampaignScheduleJson = {
      type: 'drip',
      startDate: '2020-01-01',
      endDate: null,
      weekdays: [],
      times: [],
      timezone: 'UTC',
      blackoutDates: [],
    };
    expect(service.computeNextRun(schedule, 'active')).toBeNull();
  });

  it('returns a next firing for evergreen schedules with no end date', () => {
    const schedule: CampaignScheduleJson = {
      type: 'evergreen',
      startDate: '2020-01-01',
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      times: ['09:00'],
      timezone: 'UTC',
      blackoutDates: [],
      loop: true,
    };
    const next = service.computeNextRun(schedule, 'active');
    expect(next).not.toBeNull();
  });
});

// ==========================================================================
// Write-half pure-logic tests — no DB. Exercises the union/AI-mock helpers
// that back refreshChannelCache / generateAi / approveAi / skipAi.
// ==========================================================================

describe('CampaignsService.computeChannelIdUnion', () => {
  // Pure-helper tests never touch the injected CampaignPublishingService —
  // undefined is safe here, cast away since the constructor param is typed
  // required for real (module-wired) construction.
  const service = new CampaignsService(undefined as never);

  it('returns the deduped set of channelIds across slot rows', () => {
    const union = service.computeChannelIdUnion([
      { channelId: '1' },
      { channelId: '2' },
      { channelId: '1' },
    ]);
    expect(union.sort()).toEqual(['1', '2']);
  });

  it('returns an empty array for no slots', () => {
    expect(service.computeChannelIdUnion([])).toEqual([]);
  });

  it('preserves single-channel union of one', () => {
    expect(service.computeChannelIdUnion([{ channelId: '42' }])).toEqual(['42']);
  });
});

describe('CampaignsService.emptyChannelDayContent', () => {
  // Pure-helper tests never touch the injected CampaignPublishingService —
  // undefined is safe here, cast away since the constructor param is typed
  // required for real (module-wired) construction.
  const service = new CampaignsService(undefined as never);

  it('builds a blank manual text slot by default', () => {
    expect(service.emptyChannelDayContent('text')).toEqual({
      mode: 'manual',
      postType: 'text',
      caption: '',
      media: [],
      threadParts: [],
      templateIds: [],
      poll: undefined,
    });
  });

  it('includes a blank poll payload for postType "poll"', () => {
    const content = service.emptyChannelDayContent('poll', 'manual');
    expect(content.poll).toEqual({ question: '', options: ['', ''], durationDays: 1 });
  });

  it('respects the mode passed in (e.g. ai / library)', () => {
    expect(service.emptyChannelDayContent('image', 'ai').mode).toBe('ai');
    expect(service.emptyChannelDayContent('image', 'library').mode).toBe('library');
  });
});

describe('CampaignsService.mockAiCaption', () => {
  // Pure-helper tests never touch the injected CampaignPublishingService —
  // undefined is safe here, cast away since the constructor param is typed
  // required for real (module-wired) construction.
  const service = new CampaignsService(undefined as never);

  it('falls back to "your campaign" when brief is blank', () => {
    expect(service.mockAiCaption('2026-08-10', null)).toBe(
      'AI draft for 2026-08-10 — your campaign ✨',
    );
  });

  it('includes the brief, tone hint, and CTA when configured', () => {
    const caption = service.mockAiCaption('2026-08-10', {
      brief: 'launch week',
      tone: ['witty', 'casual'],
      guardrails: { mustIncludeCta: true },
    });
    expect(caption).toBe(
      'AI draft for 2026-08-10 — launch week in a witty, casual tone ✨ Learn more — link in bio!',
    );
  });

  it('omits the tone hint when tone is empty', () => {
    const caption = service.mockAiCaption('2026-08-10', { brief: 'x', tone: [] });
    expect(caption).toBe('AI draft for 2026-08-10 — x ✨');
  });
});

// ==========================================================================
// Write-half DB-mocked tests — reproduce the mock store's error/reset
// semantics using a minimal fake `db` (same pattern as
// channels/services/channel.service.spec.ts), since a real Postgres
// instance is not available in this sandbox. See task-3-report.md for the
// DB-availability note.
// ==========================================================================

describe('CampaignsService write methods (mocked db)', () => {
  const WORKSPACE_ID = 'ws-1';
  const CAMPAIGN_ID = 'c-1';

  function makeCampaignRow(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: CAMPAIGN_ID,
      workspaceId: WORKSPACE_ID,
      createdById: 'user-1',
      name: 'Launch week',
      description: null,
      type: 'bulk',
      status: 'draft',
      schedule: {
        type: 'bulk',
        startDate: '2026-08-01',
        endDate: '2026-08-31',
        defaultTime: '09:00',
        timezone: 'UTC',
        blackoutDates: [],
        skipWeekends: false,
      },
      contentSource: 'manual',
      aiConfig: null,
      libraryTemplateIds: [],
      channelIds: [],
      platforms: [],
      createdAt: new Date('2026-08-01T00:00:00Z'),
      updatedAt: new Date('2026-08-01T00:00:00Z'),
      ...overrides,
    };
  }

  /**
   * Loads a fresh, isolated copy of the service module with `../drizzle/db`
   * mocked to `fakeDb`. `jest.isolateModules` scopes the mock + require to
   * this call only, so tests in this describe block don't leak mocks into
   * each other or into the DB-free suites above. `publishing` is passed
   * straight into the service's constructor (a mock `CampaignPublishingService`
   * for the `launch` tests; unused — and safe to omit — by every other test
   * in this block).
   */
  function loadServiceWithFakeDb(
    fakeDb: unknown,
    publishing?: unknown,
  ): InstanceType<typeof CampaignsService> {
    let ServiceCtor!: typeof CampaignsService;
    jest.isolateModules(() => {
      jest.doMock('../drizzle/db', () => ({ db: fakeDb }));
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      ServiceCtor = require('./campaigns.service').CampaignsService;
    });
    return new ServiceCtor(publishing as never);
  }

  afterEach(() => {
    jest.dontMock('../drizzle/db');
    jest.resetModules();
  });

  it('list() search matches on description alone when the name does not match', async () => {
    const rows = [
      makeCampaignRow({
        id: 'c-1',
        name: 'Launch week',
        description: 'Back to school promo',
      }),
      makeCampaignRow({ id: 'c-2', name: 'Unrelated', description: null }),
    ];

    // list() issues 3 selects: campaigns (ends in .orderBy()), then
    // campaignDays and campaignSlotContent (awaited straight off .where(),
    // no .orderBy()). Track call order so the fake `where()` can return the
    // right shape for each, same approach as the updateEvent tests above.
    let selectCall = 0;
    const service = loadServiceWithFakeDb({
      select: () => ({
        from: () => ({
          where: () => {
            selectCall += 1;
            if (selectCall === 1) {
              return { orderBy: () => Promise.resolve(rows) };
            }
            return Promise.resolve([]);
          },
        }),
      }),
    });

    const result = await service.list(WORKSPACE_ID, { search: 'school' });

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('c-1');
  });

  it('updateEvent 404s ("Campaign not found") when the campaign is not in this workspace', async () => {
    const service = loadServiceWithFakeDb({
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([]), // getOne's workspace-scoped lookup finds nothing
        }),
      }),
    });

    await expect(
      service.updateEvent(WORKSPACE_ID, CAMPAIGN_ID, {
        date: '2026-08-10',
        channelId: '1',
        patch: { caption: 'hi' },
      }),
    ).rejects.toThrow('Campaign not found');
  });

  it('updateEvent 404s with "Event not found" when campaign exists but slot does not', async () => {
    const campaignRow = makeCampaignRow();
    let selectCall = 0;

    const service = loadServiceWithFakeDb({
      select: () => ({
        from: () => ({
          where: () => {
            selectCall += 1;
            // Call 1: getOne's campaign-by-workspace lookup -> found.
            // Call 2: the slot lookup inside updateEvent -> empty.
            if (selectCall === 1) return Promise.resolve([campaignRow]);
            return Promise.resolve([]);
          },
        }),
      }),
    });

    await expect(
      service.updateEvent(WORKSPACE_ID, CAMPAIGN_ID, {
        date: '2026-08-10',
        channelId: '1',
        patch: { caption: 'hi' },
      }),
    ).rejects.toThrow('Event not found');
  });

  it('duplicate resets status to draft on the copy even when the source is active', async () => {
    const sourceRow = makeCampaignRow({ status: 'active', name: 'Launch week' });
    const copyRow = makeCampaignRow({
      id: 'c-2',
      status: 'draft',
      name: 'Launch week (copy)',
    });

    // `select().from().where()` is called, in order, for:
    //   1. getOne's workspace-scoped campaign row lookup         -> [sourceRow]
    //   2/3. getOne -> assembleFromRow(source) days + slots      -> []
    //   4/5. duplicate's sourceDays + sourceSlots fetch           -> []
    //   6. assembleCampaign(copy) row lookup                     -> [copyRow]
    //   7/8. assembleFromRow(copy) days + slots                  -> []
    const selectResults = [[sourceRow], [], [], [], [], [copyRow], [], []];
    let selectCall = 0;

    const service = loadServiceWithFakeDb({
      select: () => ({
        from: () => ({
          where: () => Promise.resolve(selectResults[selectCall++] ?? []),
        }),
      }),
      insert: () => ({
        values: () => ({
          returning: () => Promise.resolve([copyRow]),
        }),
      }),
    });

    const result = await service.duplicate(WORKSPACE_ID, 'user-1', CAMPAIGN_ID);

    expect(result.status).toBe('draft');
    expect(result.name).toBe('Launch week (copy)');
  });

  // ==========================================================================
  // launch() — table-identity-routed fake db (rather than call-order indices,
  // since launch's preflight + per-slot loop issues a variable number of
  // selects/updates depending on how many slots are publishable). Compares
  // the `from(table)` / `update(table)` argument by reference against the
  // real schema table objects so each query resolves against its own
  // in-memory fixture regardless of call order. Nested inside this describe
  // block (rather than a sibling) so it can reuse `loadServiceWithFakeDb`.
  // ==========================================================================

  describe('launch', () => {
  const WORKSPACE_ID = 'ws-1';
  const CAMPAIGN_ID = 'c-1';

  function makeCampaignRow(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: CAMPAIGN_ID,
      workspaceId: WORKSPACE_ID,
      createdById: 'user-1',
      name: 'Launch week',
      description: null,
      type: 'bulk',
      status: 'draft',
      schedule: {
        type: 'bulk',
        startDate: '2020-01-01',
        endDate: '2099-01-01',
        defaultTime: '09:00',
        timezone: 'UTC',
        blackoutDates: [],
        skipWeekends: false,
      },
      contentSource: 'manual',
      aiConfig: null,
      libraryTemplateIds: [],
      channelIds: [],
      platforms: [],
      createdAt: new Date('2026-08-01T00:00:00Z'),
      updatedAt: new Date('2026-08-01T00:00:00Z'),
      ...overrides,
    };
  }

  function makeSlotRow(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: 'slot-1',
      campaignId: CAMPAIGN_ID,
      date: '2026-08-13',
      channelId: '1',
      content: content({ caption: 'Hello world' }),
      scheduledAt: null,
      slotStatus: 'pending',
      postId: null,
      jobId: null,
      publishedAt: null,
      lastError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }

  /**
   * Table-name-routed fake db. `campaignRow`/`dayRows`/`slotRows`/
   * `channelRows` back the respective `select` queries (matched via
   * `getTableName()` on the table passed to `.from()` — NOT reference
   * equality: `launch`'s service module is loaded through
   * `jest.isolateModules`, which gives the schema module (and therefore its
   * exported table objects) a distinct module instance from the one
   * imported at the top of this file, so `table === campaigns` never
   * matches even though it's "the same" table). Every `.update()` is
   * recorded into `updates` (keyed by which table) so tests can assert on
   * the written slot/campaign rows without modeling real persistence.
   */
  function buildFakeDb(fixture: {
    campaignRow: ReturnType<typeof makeCampaignRow> | undefined;
    dayRows?: Record<string, unknown>[];
    slotRows?: Record<string, unknown>[];
    channelRows?: { id: number; platform: string }[];
  }) {
    const updates: {
      slotUpdates: { id: string; set: Record<string, unknown> }[];
      campaignUpdates: Record<string, unknown>[];
    } = { slotUpdates: [], campaignUpdates: [] };

    const db = {
      select: () => ({
        from: (table: unknown) => ({
          where: () => {
            const name = getTableName(table as never);
            if (name === 'campaigns') {
              return Promise.resolve(fixture.campaignRow ? [fixture.campaignRow] : []);
            }
            if (name === 'campaign_days') {
              return Promise.resolve(fixture.dayRows ?? []);
            }
            if (name === 'campaign_slot_content') {
              return Promise.resolve(fixture.slotRows ?? []);
            }
            if (name === 'social_media_channels') {
              return Promise.resolve(fixture.channelRows ?? []);
            }
            return Promise.resolve([]);
          },
        }),
      }),
      update: (table: unknown) => ({
        set: (set: Record<string, unknown>) => ({
          where: (whereCond: unknown) => {
            const name = getTableName(table as never);
            if (name === 'campaign_slot_content') {
              const id = extractSlotIdFromWhere(whereCond);
              updates.slotUpdates.push({ id, set });
            } else if (name === 'campaigns') {
              updates.campaignUpdates.push(set);
              // Write through to the live fixture row so the final
              // `assembleCampaign` re-select (status/launchedAt) reflects
              // launch's own update, same as a real DB round-trip would.
              if (fixture.campaignRow) Object.assign(fixture.campaignRow, set);
            }
            return Promise.resolve();
          },
        }),
      }),
    };

    return { db, updates };
  }

  /** Pulls the `campaignSlotContent.id` value out of an `eq(campaignSlotContent.id, x)`
   *  drizzle condition tree so the fake `update` can attribute a write to a slot. */
  function extractSlotIdFromWhere(cond: unknown): string {
    const node = cond as { queryChunks?: unknown[] };
    const chunks = node?.queryChunks ?? [];
    for (const chunk of chunks) {
      const c = chunk as { value?: unknown };
      if (typeof c?.value === 'string') return c.value;
    }
    return '';
  }

  function makePublishingMock() {
    return {
      materializeAndEnqueue: jest.fn().mockResolvedValue({ postId: 'p1', jobId: 'j1' }),
      cancelSlotJob: jest.fn(),
      buildJobId: jest.fn(),
    };
  }

  it('rejects a campaign with no publishable slots', async () => {
    const publishing = makePublishingMock();
    const { db } = buildFakeDb({
      campaignRow: makeCampaignRow(),
      dayRows: [],
      slotRows: [],
    });
    const service = loadServiceWithFakeDb(db, publishing);

    await expect(service.launch(WORKSPACE_ID, CAMPAIGN_ID)).rejects.toThrow(/no publishable/i);
    expect(publishing.materializeAndEnqueue).not.toHaveBeenCalled();
  });

  it('materializes + enqueues each publishable slot and marks it scheduled', async () => {
    const publishing = makePublishingMock();
    const futureDate = '2099-06-15'; // far future -> always "due", never past-due
    const { db, updates } = buildFakeDb({
      campaignRow: makeCampaignRow(),
      dayRows: [],
      slotRows: [makeSlotRow({ date: futureDate, channelId: '1' })],
      channelRows: [{ id: 1, platform: 'twitter' }],
    });
    const service = loadServiceWithFakeDb(db, publishing);

    const result = await service.launch(WORKSPACE_ID, CAMPAIGN_ID);

    expect(publishing.materializeAndEnqueue).toHaveBeenCalledTimes(1);
    expect(publishing.materializeAndEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        createdById: 'user-1',
        campaignId: CAMPAIGN_ID,
        date: futureDate,
        channelId: '1',
        platform: 'twitter',
      }),
    );
    expect(result.status).toBe('active');

    const slotUpdate = updates.slotUpdates.find((u) => u.id === 'slot-1');
    expect(slotUpdate?.set).toMatchObject({
      postId: 'p1',
      jobId: 'j1',
      slotStatus: 'scheduled',
    });
    expect(updates.campaignUpdates[0]).toMatchObject({ status: 'active' });
    expect(updates.campaignUpdates[0].launchedAt).toBeInstanceOf(Date);
  });

  it('skips past-due slots (marks skipped, does not enqueue)', async () => {
    const publishing = makePublishingMock();
    const pastDate = '2020-01-02'; // within schedule window but already elapsed
    const { db, updates } = buildFakeDb({
      campaignRow: makeCampaignRow(),
      dayRows: [],
      slotRows: [makeSlotRow({ date: pastDate, channelId: '1' })],
      channelRows: [{ id: 1, platform: 'twitter' }],
    });
    const service = loadServiceWithFakeDb(db, publishing);

    const result = await service.launch(WORKSPACE_ID, CAMPAIGN_ID);

    expect(publishing.materializeAndEnqueue).not.toHaveBeenCalled();
    expect(result.status).toBe('active');

    const slotUpdate = updates.slotUpdates.find((u) => u.id === 'slot-1');
    expect(slotUpdate?.set).toMatchObject({ slotStatus: 'skipped' });
  });

  it('404s when the campaign does not belong to the workspace', async () => {
    const publishing = makePublishingMock();
    const { db } = buildFakeDb({ campaignRow: undefined });
    const service = loadServiceWithFakeDb(db, publishing);

    await expect(service.launch(WORKSPACE_ID, CAMPAIGN_ID)).rejects.toThrow('Campaign not found');
  });
  });
});

