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
  const service = new CampaignsService();

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
  const service = new CampaignsService();

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
  const service = new CampaignsService();

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
