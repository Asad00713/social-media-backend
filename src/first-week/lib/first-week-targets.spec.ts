import {
  chooseSourceChannel,
  cleanCaptions,
  IMAGE_CAPABLE_PLATFORMS,
  IMAGE_REQUIRED_PLATFORMS,
  MAX_CAPTIONS,
  selectTargets,
  type SourceCandidate,
} from './first-week-targets';

const cand = (over: Partial<SourceCandidate>): SourceCandidate => ({
  channelId: 1,
  platform: 'instagram',
  profilePictureUrl: null,
  backfilledAt: new Date('2026-10-14T10:00:00Z'),
  captions: ['a', 'b', 'c'],
  ...over,
});

describe('first-week targets', () => {
  it('lists exactly the spec platforms as image-capable', () => {
    expect([...IMAGE_CAPABLE_PLATFORMS].sort()).toEqual(
      [
        'bluesky',
        'facebook',
        'instagram',
        'linkedin',
        'mastodon',
        'pinterest',
        'threads',
        'twitter',
      ].sort(),
    );
    expect([...IMAGE_REQUIRED_PLATFORMS].sort()).toEqual([
      'instagram',
      'pinterest',
    ]);
  });

  describe('selectTargets', () => {
    it('keeps image-capable platforms and drops TikTok, YouTube and messaging', () => {
      const t = selectTargets([
        { id: 3, platform: 'tiktok' },
        { id: 1, platform: 'instagram' },
        { id: 2, platform: 'youtube' },
        { id: 5, platform: 'slack' },
        { id: 4, platform: 'facebook' },
      ]);
      expect(t.map((x) => x.platform)).toEqual(['instagram', 'facebook']);
    });

    it('produces composer-shaped targets with a string channel id', () => {
      expect(selectTargets([{ id: 9, platform: 'bluesky' }])).toEqual([
        {
          channelId: '9',
          platform: 'bluesky',
          publishStatus: 'queued',
          retryCount: 0,
        },
      ]);
    });

    it('returns no targets when nothing is image-capable', () => {
      expect(selectTargets([{ id: 1, platform: 'tiktok' }])).toEqual([]);
      expect(selectTargets([])).toEqual([]);
    });
  });

  describe('cleanCaptions', () => {
    it('trims, drops empties and nulls, and caps at 24', () => {
      const raw = ['  hello  ', '', '   ', null, undefined, 'world'];
      expect(cleanCaptions(raw)).toEqual(['hello', 'world']);
      const many = Array.from({ length: 40 }, (_, i) => `post ${i}`);
      expect(cleanCaptions(many)).toHaveLength(MAX_CAPTIONS);
    });

    it('clips very long captions', () => {
      expect(cleanCaptions(['x'.repeat(2000)])[0].length).toBeLessThanOrEqual(
        600,
      );
    });
  });

  describe('chooseSourceChannel', () => {
    it('prefers the most recently backfilled image-capable channel with enough posts', () => {
      const chosen = chooseSourceChannel([
        cand({
          channelId: 1,
          platform: 'instagram',
          backfilledAt: new Date('2026-10-14T09:00:00Z'),
        }),
        cand({
          channelId: 2,
          platform: 'facebook',
          backfilledAt: new Date('2026-10-14T11:00:00Z'),
        }),
        cand({
          channelId: 3,
          platform: 'tiktok',
          backfilledAt: new Date('2026-10-14T12:00:00Z'),
        }),
      ]);
      expect(chosen?.channelId).toBe(2);
    });

    it('uses a non-image channel when no image-capable channel has enough posts', () => {
      const chosen = chooseSourceChannel([
        cand({ channelId: 1, platform: 'instagram', captions: ['only one'] }),
        cand({
          channelId: 3,
          platform: 'tiktok',
          captions: ['a', 'b', 'c', 'd'],
        }),
      ]);
      expect(chosen?.channelId).toBe(3);
    });

    it('falls back to the channel with the most captions when none has 3', () => {
      const chosen = chooseSourceChannel([
        cand({ channelId: 1, captions: ['a'] }),
        cand({ channelId: 2, captions: ['a', 'b'] }),
      ]);
      expect(chosen?.channelId).toBe(2);
    });

    it('returns null when no channel has any caption', () => {
      expect(chooseSourceChannel([cand({ captions: [] })])).toBeNull();
      expect(chooseSourceChannel([])).toBeNull();
    });

    it('breaks ties deterministically by higher channel id', () => {
      const same = new Date('2026-10-14T10:00:00Z');
      const chosen = chooseSourceChannel([
        cand({ channelId: 4, backfilledAt: same }),
        cand({ channelId: 8, backfilledAt: same }),
      ]);
      expect(chosen?.channelId).toBe(8);
    });

    it('ranks a never-backfilled channel below a backfilled one', () => {
      const chosen = chooseSourceChannel([
        cand({ channelId: 9, backfilledAt: null }),
        cand({ channelId: 1, backfilledAt: new Date('2026-01-01T00:00:00Z') }),
      ]);
      expect(chosen?.channelId).toBe(1);
    });
  });
});
