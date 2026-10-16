import type { BrandProfileRow } from '../../drizzle/schema/workspace-brand-profile.schema';
import {
  blockedReasonOf,
  slotOf,
  toDraftView,
  toProfileView,
  type FirstWeekPostLike,
} from './first-week-view';

const NOW = new Date('2026-10-14T10:00:00Z');
const FUTURE = '2026-10-16T04:00:00.000Z';
const PAST = '2026-10-13T04:00:00.000Z';

const row = (over: Partial<FirstWeekPostLike> = {}): FirstWeekPostLike => ({
  id: 'p1',
  status: 'draft',
  content: 'Fresh beans today',
  mediaItems: [{ url: 'https://img/1.jpg', type: 'image' }],
  targets: [{ channelId: '7', platform: 'facebook' }],
  scheduledAt: null,
  metadata: { source: 'first_week', firstWeekSlot: 1, suggestedAt: FUTURE },
  ...over,
});

describe('slotOf', () => {
  it('reads metadata.firstWeekSlot', () => {
    expect(slotOf(row())).toBe(1);
  });
  it('is null when missing or not an integer', () => {
    expect(slotOf(row({ metadata: {} }))).toBeNull();
    expect(slotOf(row({ metadata: { firstWeekSlot: '1' } }))).toBeNull();
    expect(slotOf(row({ metadata: null }))).toBeNull();
  });
});

describe('blockedReasonOf', () => {
  const base = {
    status: 'draft',
    targets: [{}],
    hasMedia: true,
    platforms: ['facebook'],
    suggestedAt: new Date(FUTURE),
  };
  it('is null for a schedulable draft', () => {
    expect(blockedReasonOf(base, NOW)).toBeNull();
  });
  it('already_scheduled beats every other reason', () => {
    expect(
      blockedReasonOf(
        {
          ...base,
          status: 'scheduled',
          targets: [],
          suggestedAt: new Date(PAST),
        },
        NOW,
      ),
    ).toBe('already_scheduled');
  });
  it('no_targets', () => {
    expect(blockedReasonOf({ ...base, targets: [], platforms: [] }, NOW)).toBe(
      'no_targets',
    );
  });
  it('needs_image only for Instagram or Pinterest targets without media', () => {
    expect(
      blockedReasonOf(
        { ...base, hasMedia: false, platforms: ['instagram'] },
        NOW,
      ),
    ).toBe('needs_image');
    expect(
      blockedReasonOf(
        { ...base, hasMedia: false, platforms: ['facebook', 'pinterest'] },
        NOW,
      ),
    ).toBe('needs_image');
    expect(
      blockedReasonOf(
        { ...base, hasMedia: false, platforms: ['facebook'] },
        NOW,
      ),
    ).toBeNull();
  });
  it('past when the slot has gone', () => {
    expect(blockedReasonOf({ ...base, suggestedAt: new Date(PAST) }, NOW)).toBe(
      'past',
    );
  });
});

describe('toDraftView', () => {
  it('maps a ready draft', () => {
    expect(toDraftView(row(), NOW)).toEqual({
      id: 'p1',
      status: 'draft',
      slot: 1,
      suggestedAt: FUTURE,
      scheduledAt: null,
      caption: 'Fresh beans today',
      mediaUrl: 'https://img/1.jpg',
      targets: [{ platform: 'facebook', channelId: '7' }],
      schedulable: true,
      blockedReason: null,
    });
  });

  it('flags a draft with no image on Instagram as needs_image', () => {
    const v = toDraftView(
      row({
        mediaItems: [],
        targets: [{ channelId: '1', platform: 'instagram' }],
      }),
      NOW,
    );
    expect(v?.mediaUrl).toBeNull();
    expect(v?.schedulable).toBe(false);
    expect(v?.blockedReason).toBe('needs_image');
  });

  it('reports a non-draft row as scheduled, carrying its scheduledAt', () => {
    const when = new Date('2026-10-16T04:00:00Z');
    for (const status of ['scheduled', 'publishing', 'published', 'failed']) {
      const v = toDraftView(row({ status, scheduledAt: when }), NOW);
      expect(v?.status).toBe('scheduled');
      expect(v?.scheduledAt).toBe(when.toISOString());
      expect(v?.blockedReason).toBe('already_scheduled');
    }
  });

  it('survives garbage columns without throwing', () => {
    const v = toDraftView(
      row({ content: null, mediaItems: 'x', targets: null }),
      NOW,
    );
    expect(v?.caption).toBe('');
    expect(v?.mediaUrl).toBeNull();
    expect(v?.targets).toEqual([]);
    expect(v?.blockedReason).toBe('no_targets');
  });

  it('returns null for a row without a slot or a usable suggestedAt', () => {
    expect(
      toDraftView(row({ metadata: { source: 'first_week' } }), NOW),
    ).toBeNull();
    expect(
      toDraftView(
        row({ metadata: { firstWeekSlot: 0, suggestedAt: 'nope' } }),
        NOW,
      ),
    ).toBeNull();
  });
});

describe('toProfileView', () => {
  it('serialises dates and nulls for the API', () => {
    const profile: BrandProfileRow = {
      workspaceId: 'w',
      sells: 'Coffee',
      voice: ['Warm'],
      audience: 'Students',
      source: 'posts',
      sourceChannelId: 7,
      sourcePlatform: 'instagram',
      postsRead: 12,
      status: 'ready',
      draftedCount: 5,
      weekStartsOn: '2026-10-15',
      weekEndsAt: new Date('2026-10-19T04:00:00Z'),
      error: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    expect(toProfileView(profile)).toEqual({
      sells: 'Coffee',
      voice: ['Warm'],
      audience: 'Students',
      source: 'posts',
      sourceChannelId: 7,
      sourcePlatform: 'instagram',
      postsRead: 12,
      status: 'ready',
      draftedCount: 5,
      weekStartsOn: '2026-10-15',
      weekEndsAt: '2026-10-19T04:00:00.000Z',
      error: null,
    });
  });
});
