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
      time: '09:00',
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

  it('reflects real slot statuses (published/failed/skipped) written by the sync listener', () => {
    const days = [day('2026-08-10', false)];
    const slots = [
      { ...slot('2026-08-10', 'ch-1', { caption: 'Hello' }), slotStatus: 'published' as const },
      { ...slot('2026-08-10', 'ch-2', { caption: 'World' }), slotStatus: 'failed' as const },
      { ...slot('2026-08-10', 'ch-3', { caption: 'Skip me' }), slotStatus: 'skipped' as const },
      { ...slot('2026-08-10', 'ch-4', { caption: 'Still pending' }), slotStatus: 'scheduled' as const },
    ];

    const metrics = service.computeMetrics(days, slots);

    expect(metrics.postsPlanned).toBe(4);
    expect(metrics.postsPublished).toBe(1);
    expect(metrics.postsFailed).toBe(1);
    expect(metrics.postsSkipped).toBe(1);
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

  it('exposes per-slot runtime status + launchedAt in the assembled DTO', async () => {
    const campaignRow = makeCampaignRow({
      launchedAt: new Date('2026-09-01T09:00:00Z'),
    });
    const dayRows = [{ id: 'day-1', campaignId: CAMPAIGN_ID, date: '2026-09-02', skip: false }];
    const slotRows = [
      {
        id: 'slot-1',
        campaignId: CAMPAIGN_ID,
        date: '2026-09-02',
        channelId: '42',
        time: '09:00',
        content: content({ caption: 'Hello world' }),
        scheduledAt: new Date('2026-09-02T09:00:00Z'),
        slotStatus: 'published',
        postId: 'post-1',
        jobId: 'job-1',
        publishedAt: new Date('2026-09-02T09:05:00Z'),
        lastError: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    // getOne() issues: 1) campaigns lookup, then assembleFromRow's
    // 2) campaignDays + 3) campaignSlotContent selects.
    const selectResults = [[campaignRow], dayRows, slotRows];
    let selectCall = 0;

    const service = loadServiceWithFakeDb({
      select: () => ({
        from: () => ({
          where: () => Promise.resolve(selectResults[selectCall++] ?? []),
        }),
      }),
    });

    const dto = await service.getOne(WORKSPACE_ID, CAMPAIGN_ID);

    expect(dto.launchedAt).toBeTruthy();
    const slot = dto.slotContent['2026-09-02'].channelContent['42@09:00'];
    expect(slot.runtime?.slotStatus).toBe('published');
    expect(slot.runtime?.publishedAt).toBeTruthy();
  });

  // BUG C1 regression: two slots on the SAME date+channel at different times
  // must both survive in channelContent. With the old channelId-only key the
  // 17:00 slot overwrote the 09:00 one and this assertion (2 entries) failed.
  it('keeps BOTH multi-time slots on the same date+channel (drip) distinct in the DTO', async () => {
    const campaignRow = makeCampaignRow({ type: 'drip' });
    const dayRows = [{ id: 'day-1', campaignId: CAMPAIGN_ID, date: '2026-09-02', skip: false }];
    const slotRows = [
      {
        id: 'slot-am',
        campaignId: CAMPAIGN_ID,
        date: '2026-09-02',
        channelId: '42',
        time: '09:00',
        content: content({ caption: 'Morning post' }),
        scheduledAt: null,
        slotStatus: 'pending',
        postId: null,
        jobId: null,
        publishedAt: null,
        lastError: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 'slot-pm',
        campaignId: CAMPAIGN_ID,
        date: '2026-09-02',
        channelId: '42',
        time: '17:00',
        content: content({ caption: 'Evening post' }),
        scheduledAt: null,
        slotStatus: 'pending',
        postId: null,
        jobId: null,
        publishedAt: null,
        lastError: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    const selectResults = [[campaignRow], dayRows, slotRows];
    let selectCall = 0;
    const service = loadServiceWithFakeDb({
      select: () => ({
        from: () => ({
          where: () => Promise.resolve(selectResults[selectCall++] ?? []),
        }),
      }),
    });

    const dto = await service.getOne(WORKSPACE_ID, CAMPAIGN_ID);

    const channelContent = dto.slotContent['2026-09-02'].channelContent;
    // Two distinct composite keys, not one collapsed channelId key.
    expect(Object.keys(channelContent).sort()).toEqual(['42@09:00', '42@17:00']);
    expect(channelContent['42@09:00'].caption).toBe('Morning post');
    expect(channelContent['42@09:00'].time).toBe('09:00');
    expect(channelContent['42@17:00'].caption).toBe('Evening post');
    expect(channelContent['42@17:00'].time).toBe('17:00');
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
  // createDrip() — materialization tests. A table-name-routed fake db records
  // every `insert(...).values(...)` so we can assert the exact `campaign_days`
  // rows materialized from the weekday/blackout/maxPostCount rules, and that a
  // drip campaign is inserted with `type:'drip'`. `createSimple` is the
  // control: still `type:'bulk'`, zero days materialized.
  // ==========================================================================

  describe('createDrip / createSimple materialization', () => {
    const WORKSPACE_ID = 'ws-1';

    function makeDripRow(overrides: Partial<Record<string, unknown>> = {}) {
      return makeCampaignRow({
        id: 'drip-1',
        type: 'drip',
        ...overrides,
      });
    }

    /**
     * Fake db that records the values passed to each `insert(table).values(x)`
     * into `inserts` (keyed by table name), returns the campaign row from the
     * campaigns insert's `.returning()`, and serves the trailing
     * `assembleCampaign` selects (campaigns row + empty days/slots).
     */
    function buildInsertRecordingDb(campaignRow: Record<string, unknown>) {
      const inserts: {
        campaigns: unknown[];
        campaignDays: unknown[];
        campaignSlotContent: unknown[];
      } = { campaigns: [], campaignDays: [], campaignSlotContent: [] };

      const db = {
        insert: (table: unknown) => ({
          values: (vals: unknown) => {
            const name = getTableName(table as never);
            if (name === 'campaigns') {
              inserts.campaigns.push(vals);
              return { returning: () => Promise.resolve([campaignRow]) };
            }
            if (name === 'campaign_days') inserts.campaignDays.push(vals);
            if (name === 'campaign_slot_content') inserts.campaignSlotContent.push(vals);
            return { returning: () => Promise.resolve([]) };
          },
        }),
        select: () => ({
          from: (table: unknown) => ({
            where: () => {
              const name = getTableName(table as never);
              if (name === 'campaigns') return Promise.resolve([campaignRow]);
              return Promise.resolve([]);
            },
          }),
        }),
      };

      return { db, inserts };
    }

    it('inserts a drip campaign (type:drip) with a drip schedule built from the DTO', async () => {
      const { db, inserts } = buildInsertRecordingDb(makeDripRow());
      const service = loadServiceWithFakeDb(db);

      await service.createDrip(WORKSPACE_ID, 'user-1', {
        name: 'Drip A',
        startDate: '2026-08-01',
        endDate: '2026-08-31',
        timezone: 'UTC',
        weekdays: [1, 3, 5],
        times: ['09:00', '17:00'],
      });

      expect(inserts.campaigns).toHaveLength(1);
      const campaignInsert = inserts.campaigns[0] as {
        type: string;
        schedule: { type: string; weekdays: number[]; times: string[] };
      };
      expect(campaignInsert.type).toBe('drip');
      expect(campaignInsert.schedule.type).toBe('drip');
      expect(campaignInsert.schedule.weekdays).toEqual([1, 3, 5]);
      expect(campaignInsert.schedule.times).toEqual(['09:00', '17:00']);
    });

    it('materializes campaign_days only for weekdays in range, excluding blackout dates', async () => {
      const { db, inserts } = buildInsertRecordingDb(makeDripRow());
      const service = loadServiceWithFakeDb(db);

      // 2026-08-03 is a Monday. Range Mon 2026-08-03 .. Sun 2026-08-09.
      // weekdays [1,3] = Mon/Wed -> 2026-08-03 (Mon), 2026-08-05 (Wed).
      // Blackout 2026-08-05 -> only 2026-08-03 survives.
      await service.createDrip(WORKSPACE_ID, 'user-1', {
        name: 'Drip B',
        startDate: '2026-08-03',
        endDate: '2026-08-09',
        timezone: 'UTC',
        weekdays: [1, 3],
        times: ['09:00'],
        blackoutDates: ['2026-08-05'],
      });

      expect(inserts.campaignDays).toHaveLength(1);
      const dayRows = inserts.campaignDays[0] as { campaignId: string; date: string }[];
      expect(dayRows.map((d) => d.date)).toEqual(['2026-08-03']);
    });

    it('caps materialized days at ceil(maxPostCount / times.length) SLOTS worth', async () => {
      const { db, inserts } = buildInsertRecordingDb(makeDripRow());
      const service = loadServiceWithFakeDb(db);

      // Every weekday in a long window; 2 times/day; maxPostCount=5 -> ceil(5/2)=3 days.
      await service.createDrip(WORKSPACE_ID, 'user-1', {
        name: 'Drip C',
        startDate: '2026-08-01',
        endDate: '2026-12-31',
        timezone: 'UTC',
        weekdays: [0, 1, 2, 3, 4, 5, 6],
        times: ['09:00', '17:00'],
        maxPostCount: 5,
      });

      const dayRows = inserts.campaignDays[0] as { date: string }[];
      expect(dayRows).toHaveLength(3); // ceil(5 / 2)
    });

    it('materializes no campaign_days when no in-range date matches a weekday', async () => {
      const { db, inserts } = buildInsertRecordingDb(makeDripRow());
      const service = loadServiceWithFakeDb(db);

      // 2026-08-01 is a Saturday, 2026-08-02 a Sunday. weekdays [1] (Mon) -> none.
      await service.createDrip(WORKSPACE_ID, 'user-1', {
        name: 'Drip D',
        startDate: '2026-08-01',
        endDate: '2026-08-02',
        timezone: 'UTC',
        weekdays: [1],
        times: ['09:00'],
      });

      expect(inserts.campaignDays).toHaveLength(0);
    });

    it('createSimple still inserts type:bulk and materializes zero days (control)', async () => {
      const bulkRow = makeCampaignRow({ id: 'bulk-1', type: 'bulk' });
      const { db, inserts } = buildInsertRecordingDb(bulkRow);
      const service = loadServiceWithFakeDb(db);

      await service.createSimple(WORKSPACE_ID, 'user-1', {
        name: 'Bulk A',
        startDate: '2026-08-01',
        endDate: '2026-08-31',
        timezone: 'UTC',
        defaultTime: '09:00',
        skipWeekends: false,
      });

      expect(inserts.campaigns).toHaveLength(1);
      expect((inserts.campaigns[0] as { type: string }).type).toBe('bulk');
      expect(inserts.campaignDays).toHaveLength(0);
    });
  });

  // ==========================================================================
  // addEvent bulk single-slot-per-(date,channel) invariant — regression for the
  // defaultTime-edit duplicate-slot bug. Uses a STATEFUL table-name-routed fake
  // db so slots inserted by the first addEvent are visible to the second one's
  // lookup, and so `update(campaigns).set({schedule})` mutates the live row that
  // getOne re-reads. Proves that after a defaultTime edit (which does NOT
  // backfill existing slots' `time`), re-adding the same (date,channel) updates
  // the single existing slot rather than inserting a duplicate.
  // ==========================================================================

  describe('addEvent bulk single-slot invariant (defaultTime-edit regression)', () => {
    const WORKSPACE_ID = 'ws-1';
    const CAMPAIGN_ID = 'c-1';

    /** Walk an `and(eq(col, v), ...)` tree → `{ colDbName: value }`. */
    function eqValues(cond: unknown): Record<string, unknown> {
      const result: Record<string, unknown> = {};
      let pendingColumn: string | undefined;
      function walk(node: unknown): void {
        if (node == null || typeof node !== 'object') return;
        const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
        if (Array.isArray(chunks)) {
          for (const c of chunks) walk(c);
          return;
        }
        const named = node as { name?: string; columnType?: string; value?: unknown };
        if (typeof named.name === 'string' && typeof named.columnType === 'string') {
          pendingColumn = named.name;
        } else if (
          pendingColumn &&
          named.value !== undefined &&
          typeof named.value !== 'object'
        ) {
          result[pendingColumn] = named.value;
          pendingColumn = undefined;
        }
      }
      walk(cond);
      return result;
    }

    function buildStatefulDb(campaignRow: Record<string, unknown>) {
      const slotRows: Record<string, unknown>[] = [];
      const dayRows: Record<string, unknown>[] = [];
      let slotSeq = 0;

      const matches = (row: Record<string, unknown>, pairs: Record<string, unknown>) => {
        const map: Record<string, string> = {
          campaign_id: 'campaignId',
          channel_id: 'channelId',
          date: 'date',
          time: 'time',
        };
        return Object.entries(pairs).every(([dbName, v]) => {
          const key = map[dbName] ?? dbName;
          return row[key] === v;
        });
      };

      const db = {
        select: () => ({
          from: (table: unknown) => ({
            where: (cond: unknown) => {
              const name = getTableName(table as never);
              const pairs = eqValues(cond);
              if (name === 'campaigns') return Promise.resolve([campaignRow]);
              if (name === 'campaign_days')
                return Promise.resolve(dayRows.filter((r) => matches(r, pairs)));
              if (name === 'campaign_slot_content')
                return Promise.resolve(slotRows.filter((r) => matches(r, pairs)));
              return Promise.resolve([]);
            },
          }),
        }),
        insert: (table: unknown) => ({
          values: (vals: Record<string, unknown> | Record<string, unknown>[]) => {
            const name = getTableName(table as never);
            const rows = Array.isArray(vals) ? vals : [vals];
            if (name === 'campaign_days') dayRows.push(...rows);
            if (name === 'campaign_slot_content') {
              for (const r of rows) slotRows.push({ id: `slot-${++slotSeq}`, ...r });
            }
            return { returning: () => Promise.resolve([]) };
          },
        }),
        update: (table: unknown) => ({
          set: (set: Record<string, unknown>) => ({
            where: () => {
              const name = getTableName(table as never);
              if (name === 'campaigns') Object.assign(campaignRow, set);
              if (name === 'campaign_slot_content') {
                // updateEvent/addEvent slot content update: apply to all (test
                // uses a single slot, so no id disambiguation needed here).
                for (const r of slotRows) Object.assign(r, set);
              }
              return Promise.resolve();
            },
          }),
        }),
      };

      return { db, slotRows };
    }

    it('re-adding the same (date,channel) after a defaultTime edit updates the one slot, does not duplicate', async () => {
      const campaignRow = makeCampaignRow({
        type: 'bulk',
        schedule: {
          type: 'bulk',
          startDate: '2026-08-01',
          endDate: '2026-08-31',
          defaultTime: '09:00',
          timezone: 'UTC',
          blackoutDates: [],
          skipWeekends: false,
        },
      });
      const { db, slotRows } = buildStatefulDb(campaignRow);
      const service = loadServiceWithFakeDb(db);

      // 1) First addEvent → inserts one slot at time '09:00'.
      await service.addEvent(WORKSPACE_ID, CAMPAIGN_ID, {
        date: '2026-08-10',
        channelId: '1',
      });
      expect(slotRows).toHaveLength(1);
      expect(slotRows[0].time).toBe('09:00');

      // 2) Edit the schedule's defaultTime (does NOT backfill the slot's time).
      await service.update(WORKSPACE_ID, CAMPAIGN_ID, { scheduleDefaultTime: '10:00' });

      // 3) Re-add the SAME (date,channel). Must find + update the existing
      //    '09:00' slot — NOT insert a second slot keyed on the new '10:00'.
      await service.addEvent(WORKSPACE_ID, CAMPAIGN_ID, {
        date: '2026-08-10',
        channelId: '1',
      });

      expect(slotRows).toHaveLength(1);
    });
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
      time: '09:00',
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
    postRows?: { id: string; status: string }[];
  }) {
    const updates: {
      slotUpdates: { id: string; set: Record<string, unknown> }[];
      campaignUpdates: Record<string, unknown>[];
    } = { slotUpdates: [], campaignUpdates: [] };
    const deletes: { postIds: string[] } = { postIds: [] };

    const db = {
      select: () => ({
        from: (table: unknown) => ({
          where: (whereCond: unknown) => {
            const name = getTableName(table as never);
            if (name === 'campaigns') {
              return Promise.resolve(fixture.campaignRow ? [fixture.campaignRow] : []);
            }
            if (name === 'campaign_days') {
              return Promise.resolve(fixture.dayRows ?? []);
            }
            if (name === 'campaign_slot_content') {
              const rows = fixture.slotRows ?? [];
              const eqValues = extractEqValues(whereCond);
              const wantedStatus = eqValues['slot_status'];
              const filtered =
                typeof wantedStatus === 'string'
                  ? rows.filter((r) => (r as { slotStatus?: string }).slotStatus === wantedStatus)
                  : rows;
              return Promise.resolve(filtered);
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
              // Write through so a subsequent select in the same call (e.g.
              // resume's re-derived DTO) sees the post-update slot state.
              const row = (fixture.slotRows ?? []).find((r) => (r as { id: string }).id === id);
              if (row) Object.assign(row, set);
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
      delete: (table: unknown) => ({
        where: (whereCond: unknown) => {
          const name = getTableName(table as never);
          if (name === 'posts') {
            // Mirror the real `and(eq(posts.id, x), eq(posts.status, 'scheduled'))`
            // guard: only "delete" (record it) when the fixture's post row
            // actually has status 'scheduled' — an in-flight ('publishing')
            // post must survive, same as the real WHERE clause would leave
            // it untouched.
            const eqValues = extractEqValues(whereCond);
            const postId = eqValues['id'] as string | undefined;
            const requiredStatus = eqValues['status'] as string | undefined;
            const postRow = (fixture.postRows ?? []).find((p) => p.id === postId);
            const statusMatches =
              requiredStatus === undefined || (postRow && postRow.status === requiredStatus);
            if (postId && statusMatches) {
              deletes.postIds.push(postId);
            }
          }
          return Promise.resolve();
        },
      }),
    };

    return { db, updates, deletes };
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

  /**
   * Walks a drizzle `and(eq(colA, v1), eq(colB, v2), ...)` condition tree and
   * returns `{ colA: v1, colB: v2 }`. Used by the fake db's `select` so
   * `pause`/`resume`'s `slotStatus:'scheduled'` / `slotStatus:'pending'`
   * filters actually narrow the in-memory `slotRows` fixture instead of
   * ignoring the `where()` clause outright (which would make pause cancel
   * every slot regardless of status).
   */
  function extractEqValues(cond: unknown): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    let pendingColumn: string | undefined;
    function walk(node: unknown): void {
      if (node == null || typeof node !== 'object') return;
      const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
      if (Array.isArray(chunks)) {
        for (const c of chunks) walk(c);
        return;
      }
      const named = node as { name?: string; columnType?: string; value?: unknown };
      if (typeof named.name === 'string' && typeof named.columnType === 'string') {
        pendingColumn = named.name;
      } else if (pendingColumn && named.value !== undefined && typeof named.value !== 'object') {
        result[pendingColumn] = named.value;
        pendingColumn = undefined;
      }
    }
    walk(cond);
    return result;
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

  it('rejects relaunching an already-active campaign (idempotency guard)', async () => {
    const publishing = makePublishingMock();
    const futureDate = '2099-06-15';
    const { db } = buildFakeDb({
      campaignRow: makeCampaignRow({ status: 'active' }),
      dayRows: [],
      slotRows: [makeSlotRow({ date: futureDate, channelId: '1' })],
      channelRows: [{ id: 1, platform: 'twitter' }],
    });
    const service = loadServiceWithFakeDb(db, publishing);

    await expect(service.launch(WORKSPACE_ID, CAMPAIGN_ID)).rejects.toThrow(
      'Campaign is already launched.',
    );
    expect(publishing.materializeAndEnqueue).not.toHaveBeenCalled();
  });

  it('does not re-process a slot that is already scheduled (belt-and-suspenders on collectPublishableSlots)', async () => {
    const publishing = makePublishingMock();
    const futureDate = '2099-06-15';
    // Campaign is draft (so it passes the top-level guard), but the slot
    // itself is already `scheduled` from a prior launch — e.g. the campaign
    // was paused and directly re-driven back to draft by some other path, or
    // this is defense-in-depth for the guard above. Either way `launch` must
    // not re-materialize a non-pending slot.
    const { db, updates } = buildFakeDb({
      campaignRow: makeCampaignRow({ status: 'draft' }),
      dayRows: [],
      slotRows: [
        makeSlotRow({
          id: 'slot-already-scheduled',
          date: futureDate,
          channelId: '1',
          slotStatus: 'scheduled',
          postId: 'existing-post',
          jobId: 'existing-job',
        }),
      ],
      channelRows: [{ id: 1, platform: 'twitter' }],
    });
    const service = loadServiceWithFakeDb(db, publishing);

    await expect(service.launch(WORKSPACE_ID, CAMPAIGN_ID)).rejects.toThrow(/no publishable/i);
    expect(publishing.materializeAndEnqueue).not.toHaveBeenCalled();
    expect(updates.slotUpdates.find((u) => u.id === 'slot-already-scheduled')).toBeUndefined();
  });

  // ==========================================================================
  // pause() / resume() — reuse launch's table-routed `buildFakeDb` fixture
  // (declared above in this `describe('launch')` closure) since pause/resume
  // share the same slot/campaign shapes and the same fake-db plumbing.
  // ==========================================================================

  describe('pause', () => {
    const WORKSPACE_ID = 'ws-1';
    const CAMPAIGN_ID = 'c-1';

    it('cancels only the scheduled slot job and resets it to pending; published slot untouched', async () => {
      const publishing = makePublishingMock();
      const scheduledSlot = makeSlotRow({
        id: 'slot-scheduled',
        slotStatus: 'scheduled',
        postId: 'post-1',
        jobId: 'job-1',
        scheduledAt: new Date('2026-08-13T09:00:00Z'),
      });
      const publishedSlot = makeSlotRow({
        id: 'slot-published',
        slotStatus: 'published',
        postId: 'post-2',
        jobId: 'job-2',
      });
      const { db, updates, deletes } = buildFakeDb({
        campaignRow: makeCampaignRow({ status: 'active' }),
        dayRows: [],
        slotRows: [scheduledSlot, publishedSlot],
        // post-1 is still genuinely 'scheduled' (not yet picked up by a
        // worker) so pause's status-guarded delete applies to it.
        postRows: [{ id: 'post-1', status: 'scheduled' }],
      });
      const service = loadServiceWithFakeDb(db, publishing);

      const result = await service.pause(WORKSPACE_ID, CAMPAIGN_ID);

      expect(publishing.cancelSlotJob).toHaveBeenCalledTimes(1);
      expect(publishing.cancelSlotJob).toHaveBeenCalledWith('job-1');
      expect(deletes.postIds).toEqual(['post-1']);
      expect(result.status).toBe('paused');

      const scheduledUpdate = updates.slotUpdates.find((u) => u.id === 'slot-scheduled');
      expect(scheduledUpdate?.set).toMatchObject({
        slotStatus: 'pending',
        postId: null,
        jobId: null,
        scheduledAt: null,
      });
      // The published slot was selected out by the `slotStatus:'scheduled'`
      // filter in the real query — the fake db doesn't filter, so assert no
      // update was ever recorded against it.
      expect(updates.slotUpdates.find((u) => u.id === 'slot-published')).toBeUndefined();
      expect(updates.campaignUpdates[0]).toMatchObject({ status: 'paused' });
    });

    it('404s when the campaign does not belong to the workspace', async () => {
      const publishing = makePublishingMock();
      const { db } = buildFakeDb({ campaignRow: undefined });
      const service = loadServiceWithFakeDb(db, publishing);

      await expect(service.pause(WORKSPACE_ID, CAMPAIGN_ID)).rejects.toThrow('Campaign not found');
    });

    it('does not delete a post that is mid-publish (slot scheduled, post.status = publishing)', async () => {
      const publishing = makePublishingMock();
      // The slot is still `scheduled` — the live path never flips a slot to
      // a distinct 'publishing' slotStatus — but the underlying post has
      // already moved to 'publishing' because a worker picked it up. Pause
      // must leave this post alone: deleting it mid-flight would make the
      // finalizer's `returning()` come back empty after the content already
      // went live on the real platform.
      const inFlightSlot = makeSlotRow({
        id: 'slot-inflight',
        slotStatus: 'scheduled',
        postId: 'post-inflight',
        jobId: 'job-inflight',
        scheduledAt: new Date('2026-08-13T09:00:00Z'),
      });
      const { db, updates, deletes } = buildFakeDb({
        campaignRow: makeCampaignRow({ status: 'active' }),
        dayRows: [],
        slotRows: [inFlightSlot],
        postRows: [{ id: 'post-inflight', status: 'publishing' }],
      });
      const service = loadServiceWithFakeDb(db, publishing);

      const result = await service.pause(WORKSPACE_ID, CAMPAIGN_ID);

      // The job is still cancelled (BullMQ job cancellation is independent
      // of the post's DB status), but the in-flight post itself survives.
      expect(publishing.cancelSlotJob).toHaveBeenCalledWith('job-inflight');
      expect(deletes.postIds).toEqual([]);
      expect(result.status).toBe('paused');

      // The slot is still reset to pending per the documented "keep it
      // simple" behaviour — resume/sync reconciles it later.
      const slotUpdate = updates.slotUpdates.find((u) => u.id === 'slot-inflight');
      expect(slotUpdate?.set).toMatchObject({ slotStatus: 'pending', postId: null });
    });

    it('does delete a post that is genuinely still scheduled (not yet picked up)', async () => {
      const publishing = makePublishingMock();
      const scheduledSlot = makeSlotRow({
        id: 'slot-not-yet-fired',
        slotStatus: 'scheduled',
        postId: 'post-not-yet-fired',
        jobId: 'job-not-yet-fired',
        scheduledAt: new Date('2026-08-13T09:00:00Z'),
      });
      const { db, deletes } = buildFakeDb({
        campaignRow: makeCampaignRow({ status: 'active' }),
        dayRows: [],
        slotRows: [scheduledSlot],
        postRows: [{ id: 'post-not-yet-fired', status: 'scheduled' }],
      });
      const service = loadServiceWithFakeDb(db, publishing);

      await service.pause(WORKSPACE_ID, CAMPAIGN_ID);

      expect(deletes.postIds).toEqual(['post-not-yet-fired']);
    });
  });

  describe('resume', () => {
    const WORKSPACE_ID = 'ws-1';
    const CAMPAIGN_ID = 'c-1';

    it('re-enqueues pending future slots and sets the campaign active', async () => {
      const publishing = makePublishingMock();
      const futureDate = '2099-06-15'; // far future -> always "due", never past-due
      const { db, updates } = buildFakeDb({
        campaignRow: makeCampaignRow({ status: 'paused' }),
        dayRows: [],
        slotRows: [makeSlotRow({ date: futureDate, channelId: '1', slotStatus: 'pending' })],
        channelRows: [{ id: 1, platform: 'twitter' }],
      });
      const service = loadServiceWithFakeDb(db, publishing);

      const result = await service.resume(WORKSPACE_ID, CAMPAIGN_ID);

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
    });

    it('leaves a past-due pending slot untouched (still pending, not enqueued)', async () => {
      const publishing = makePublishingMock();
      const pastDate = '2020-01-02'; // within schedule window but already elapsed
      const { db, updates } = buildFakeDb({
        campaignRow: makeCampaignRow({ status: 'paused' }),
        dayRows: [],
        slotRows: [makeSlotRow({ date: pastDate, channelId: '1', slotStatus: 'pending' })],
        channelRows: [{ id: 1, platform: 'twitter' }],
      });
      const service = loadServiceWithFakeDb(db, publishing);

      const result = await service.resume(WORKSPACE_ID, CAMPAIGN_ID);

      expect(publishing.materializeAndEnqueue).not.toHaveBeenCalled();
      expect(result.status).toBe('active');
      expect(updates.slotUpdates.find((u) => u.id === 'slot-1')).toBeUndefined();
    });

    it('does not re-enqueue a pending slot whose day is skipped (campaignDays.skip=true)', async () => {
      const publishing = makePublishingMock();
      const skippedDate = '2099-06-15'; // far future -> would otherwise be due
      const { db, updates } = buildFakeDb({
        campaignRow: makeCampaignRow({ status: 'paused' }),
        dayRows: [{ id: 'day-1', campaignId: CAMPAIGN_ID, date: skippedDate, skip: true }],
        slotRows: [makeSlotRow({ date: skippedDate, channelId: '1', slotStatus: 'pending' })],
        channelRows: [{ id: 1, platform: 'twitter' }],
      });
      const service = loadServiceWithFakeDb(db, publishing);

      const result = await service.resume(WORKSPACE_ID, CAMPAIGN_ID);

      expect(publishing.materializeAndEnqueue).not.toHaveBeenCalled();
      expect(result.status).toBe('active');
      expect(updates.slotUpdates.find((u) => u.id === 'slot-1')).toBeUndefined();
    });

    it('404s when the campaign does not belong to the workspace', async () => {
      const publishing = makePublishingMock();
      const { db } = buildFakeDb({ campaignRow: undefined });
      const service = loadServiceWithFakeDb(db, publishing);

      await expect(service.resume(WORKSPACE_ID, CAMPAIGN_ID)).rejects.toThrow('Campaign not found');
    });
  });
  });
});

