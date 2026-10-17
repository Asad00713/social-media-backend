import type {
  Campaign,
  CampaignScheduleJson,
  CampaignSlotContent,
} from '../../drizzle/schema/campaigns.schema';
import { cadenceOf, computeSpan } from './campaign-span';

const NOW = new Date('2026-06-15T00:00:00.000Z');

const bulk = (over: Partial<CampaignScheduleJson> = {}): CampaignScheduleJson =>
  ({
    type: 'bulk',
    startDate: '2026-07-01',
    endDate: '2026-07-03',
    defaultTime: '23:30',
    timezone: 'Asia/Karachi',
    blackoutDates: [],
    skipWeekends: false,
    ...over,
  }) as CampaignScheduleJson;

const campaign = (schedule: CampaignScheduleJson): Campaign =>
  ({ id: 'c1', schedule, type: schedule.type }) as unknown as Campaign;

type Slot = Pick<
  CampaignSlotContent,
  'date' | 'time' | 'scheduledAt' | 'slotStatus'
>;
const slot = (
  date: string,
  time = '23:30',
  over: Partial<Slot> = {},
): Slot => ({
  date,
  time,
  scheduledAt: null,
  slotStatus: 'pending',
  ...over,
});

const span = (
  schedule: CampaignScheduleJson,
  slots: Slot[],
  workspaceTz = 'UTC',
  skippedDates: string[] = [],
) =>
  computeSpan({
    campaign: campaign(schedule),
    slots,
    skippedDates: new Set(skippedDates),
    workspaceTz,
    now: NOW,
  });

describe('computeSpan', () => {
  // 23:30 Karachi (UTC+5) is 18:30 UTC, and 06:30 the next day in Auckland (UTC+12).
  const slots = [slot('2026-07-01'), slot('2026-07-03')];

  it('uses the workspace-local date of the first and last slot instants', () => {
    expect(span(bulk(), slots, 'UTC')).toMatchObject({
      startDate: '2026-07-01',
      endDate: '2026-07-03',
    });
  });

  it('moves to the next local date for a workspace ahead of the campaign zone', () => {
    expect(span(bulk(), slots, 'Pacific/Auckland')).toMatchObject({
      startDate: '2026-07-02',
      endDate: '2026-07-04',
    });
  });

  it('prefers scheduledAt over the wall clock', () => {
    const s = slot('2026-07-01', '23:30', {
      scheduledAt: new Date('2026-07-05T10:00:00.000Z'),
    });
    expect(span(bulk(), [s], 'UTC')).toMatchObject({
      startDate: '2026-07-05',
      endDate: '2026-07-05',
    });
  });

  it('ignores slots on skipped days and slots with status skipped', () => {
    const result = span(
      bulk(),
      [
        slot('2026-07-01'),
        slot('2026-07-02'),
        slot('2026-07-03', '23:30', { slotStatus: 'skipped' }),
      ],
      'UTC',
      ['2026-07-01'],
    );
    expect(result).toMatchObject({
      startDate: '2026-07-02',
      endDate: '2026-07-02',
    });
  });

  it('leaves an open-ended drip and an evergreen with endDate null', () => {
    const drip = {
      type: 'drip',
      startDate: '2026-07-01',
      endDate: null,
      weekdays: [1, 3, 5],
      times: ['09:00'],
      timezone: 'UTC',
      blackoutDates: [],
    } as CampaignScheduleJson;
    expect(span(drip, [slot('2026-07-01', '09:00')]).endDate).toBeNull();
    expect(span(drip, []).endDate).toBeNull();
    const evergreen = {
      type: 'evergreen',
      startDate: '2026-07-01',
      weekdays: [1],
      times: ['09:00'],
      timezone: 'UTC',
      blackoutDates: [],
      loop: true,
    } as CampaignScheduleJson;
    expect(span(evergreen, [slot('2026-07-01', '09:00')]).endDate).toBeNull();
  });

  it('falls back to the schedule dates when there are no slots', () => {
    expect(span(bulk(), [], 'UTC')).toEqual({
      startDate: '2026-07-01',
      endDate: '2026-07-03',
      nextPostAt: null,
    });
  });

  it('nextPostAt is the earliest future scheduled slot only', () => {
    const at = (iso: string, slotStatus: Slot['slotStatus'] = 'scheduled') =>
      slot('2026-07-01', '09:00', { scheduledAt: new Date(iso), slotStatus });
    const result = span(
      bulk(),
      [
        at('2026-06-10T09:00:00.000Z'), // past
        at('2026-06-20T09:00:00.000Z', 'pending'), // not scheduled
        at('2026-06-21T09:00:00.000Z', 'published'),
        at('2026-06-25T09:00:00.000Z'),
        at('2026-06-22T09:00:00.000Z'),
      ],
      'UTC',
    );
    expect(result.nextPostAt).toBe('2026-06-22T09:00:00.000Z');
    expect(
      span(bulk(), [at('2026-06-10T09:00:00.000Z')]).nextPostAt,
    ).toBeNull();
  });
});

describe('cadenceOf', () => {
  const recurring = (weekdays: number[], times = ['09:00', '17:00']) =>
    ({
      type: 'drip',
      startDate: '2026-07-01',
      endDate: null,
      weekdays,
      times,
      timezone: 'UTC',
      blackoutDates: [],
    }) as CampaignScheduleJson;

  it('bulk: skipWeekends is weekdays, otherwise daily, one time', () => {
    expect(cadenceOf(bulk({ skipWeekends: true }))).toEqual({
      kind: 'weekdays',
      weekdays: [1, 2, 3, 4, 5],
      times: ['23:30'],
    });
    expect(cadenceOf(bulk())).toEqual({
      kind: 'daily',
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      times: ['23:30'],
    });
  });

  it('drip: all seven days is daily', () => {
    expect(cadenceOf(recurring([6, 5, 4, 3, 2, 1, 0]))).toEqual({
      kind: 'daily',
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      times: ['09:00', '17:00'],
    });
  });

  it('drip: exactly Mon-Fri is weekdays', () => {
    expect(cadenceOf(recurring([5, 4, 3, 2, 1])).kind).toBe('weekdays');
  });

  it('drip: Mon/Wed/Fri is custom', () => {
    expect(cadenceOf(recurring([1, 3, 5]))).toEqual({
      kind: 'custom',
      weekdays: [1, 3, 5],
      times: ['09:00', '17:00'],
    });
  });
});
