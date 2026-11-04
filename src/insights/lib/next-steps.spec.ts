import type { FollowerRow } from '../../post-performance/followers';
import { addDays } from '../../post-performance/period';
import type { PublishedPost } from '../../post-performance/post-performance';
import type { NextStep } from '../dto/insights.dto';
import { toInsightPost } from './insight-post';
import {
  nextSteps,
  normalizeCaption,
  repostCandidates,
  STEP_ID_PATTERN,
  type LaterPost,
  type NextStepsInput,
  type StepChannel,
  type StepPost,
} from './next-steps';

const NOW = new Date('2026-11-04T09:00:00.000Z');
const TODAY = '2026-11-04';

let seq = 0;

interface Spec {
  channel?: number;
  /** Whole UTC days before TODAY. */
  ago: number;
  eng?: number;
  format?: 'text' | 'image' | 'video' | 'carousel';
  mult?: number | null;
  imported?: boolean;
  content?: string;
  media?: string[];
  /** false: the platform has reported nothing yet. */
  measured?: boolean;
  id?: string;
}

/** One published post, read the way the service reads it. */
function sp(o: Spec): StepPost {
  const n = ++seq;
  const publishedOn = addDays(TODAY, -o.ago);
  const eng = o.eng ?? 10;
  const urls = o.media ?? (o.format && o.format !== 'text' ? [`cdn/${n}`] : []);
  const items =
    o.format === 'carousel'
      ? [...urls, `cdn/${n}-b`].map((url) => ({ type: 'image', url }))
      : urls.map((url) => ({ type: o.format ?? 'image', url }));
  const measured = o.measured !== false;
  const raw: PublishedPost = {
    postId: o.id ?? `p${n}`,
    channelId: o.channel ?? 1,
    publishedOn,
    likes: measured ? eng : null,
    comments: measured ? 0 : null,
    shares: measured ? 0 : null,
    impressions: null,
    reach: null,
    saved: null,
    follows: null,
    syncedAt: null,
    publishedAt: `${publishedOn}T10:00:00.000Z`,
    content: o.content ?? '',
    mediaItems: items,
    imported: o.imported ?? false,
    permalink: null,
    mediaType: null,
  };
  const post = toInsightPost(raw, 'twitter', { now: NOW });
  return { raw, post: { ...post, usualMultiplier: o.mult ?? null } };
}

const many = (n: number, from: number, o: Omit<Spec, 'ago'>): StepPost[] =>
  Array.from({ length: n }, (_, i) => sp({ ...o, ago: from + i }));

const ch = (
  id: number,
  platformName = 'Instagram',
  over: Partial<StepChannel> = {},
): StepChannel => ({
  id,
  platformName,
  isActive: true,
  healthy: true,
  ...over,
});

/** Ten text posts on channel 1, 3 to 12 days old: enough, and no format gap. */
const quietBase = (): StepPost[] => many(10, 3, { format: 'text' });

/** 5 videos at 30 and 5 images at 10: a 3.0x gap. */
const gapBase = (): StepPost[] => [
  ...many(5, 3, { format: 'video', eng: 30 }),
  ...many(5, 8, { format: 'image', eng: 10 }),
];

const input = (over: Partial<NextStepsInput> = {}): NextStepsInput => ({
  now: NOW,
  posts: gapBase(),
  channels: [ch(1)],
  hidden: new Set(),
  followers: [],
  scheduledFormats: [],
  later: [],
  ...over,
});

const ids = (steps: NextStep[]) => steps.map((s) => s.id);

describe('N1 format gap', () => {
  it('fires at ratio 1.5, not 1.49', () => {
    const at = (video: number) =>
      nextSteps(
        input({
          posts: [
            ...many(5, 3, { format: 'video', eng: video }),
            ...many(5, 8, { format: 'image', eng: 100 }),
          ],
        }),
      );
    expect(ids(at(150))).toEqual(['format_gap']);
    expect(at(149)).toEqual([]);
  });

  it('words it from S7.2, best first, with the bars', () => {
    const [step] = nextSteps(input());
    expect(step).toEqual({
      id: 'format_gap',
      rule: 'format_gap',
      title: 'Videos get 3.0× more engagement than images',
      body: 'Median engagement per post on Instagram. No video is planned this week.',
      why: 'Your videos get the most engagement on your own posts, and none is scheduled in the next 7 days.',
      bars: [
        { format: 'video', median: 30 },
        { format: 'image', median: 10 },
      ],
      cta: { label: 'Plan a video' },
    });
  });

  it('says text posts and an image, and shows the top 3 bars', () => {
    const [step] = nextSteps(
      input({
        posts: [
          ...many(3, 3, { format: 'image', eng: 40 }),
          ...many(3, 6, { format: 'video', eng: 30 }),
          ...many(3, 9, { format: 'carousel', eng: 20 }),
          ...many(3, 12, { format: 'text', eng: 10 }),
        ],
      }),
    );
    expect(step.title).toBe('Images get 4.0× more engagement than text posts');
    expect(step.rule === 'format_gap' && step.cta.label).toBe('Plan an image');
    expect(
      step.rule === 'format_gap' && step.bars.map((b) => b.format),
    ).toEqual(['image', 'video', 'carousel']);
  });

  it('names one or two platforms, otherwise your channels', () => {
    const body = (channels: StepChannel[], channelOf: (i: number) => number) =>
      nextSteps(
        input({
          channels,
          posts: gapBase().map((p, i) => {
            const channelId = channelOf(i);
            return {
              raw: { ...p.raw, channelId },
              post: { ...p.post, channelId },
            };
          }),
        }),
      )[0].body;
    const two = [ch(1, 'Instagram'), ch(2, 'Facebook')];
    expect(body(two, (i) => (i % 2 ? 2 : 1))).toBe(
      'Median engagement per post on Instagram and Facebook. No video is planned this week.',
    );
    expect(body([...two, ch(3, 'X (Twitter)')], (i) => (i % 3) + 1)).toBe(
      'Median engagement per post on your channels. No video is planned this week.',
    );
    // A channel with no measured post is not named.
    expect(body(two, () => 1)).toBe(
      'Median engagement per post on Instagram. No video is planned this week.',
    );
  });

  it('does not fire with a video scheduled in the next 7 days', () => {
    expect(nextSteps(input({ scheduledFormats: ['video'] }))).toEqual([]);
    // Another format scheduled does not stand in for the best one.
    expect(ids(nextSteps(input({ scheduledFormats: ['image'] })))).toEqual([
      'format_gap',
    ]);
  });

  it('ignores unknown and a format with 2 posts', () => {
    // Unknown (imported, undescribed) and a 2-post carousel would be the best
    // by far; neither is a bar, so the video/image gap speaks.
    const posts = [
      ...many(5, 3, { imported: true, eng: 5000 }),
      ...many(2, 8, { format: 'carousel', eng: 9000 }),
      ...many(3, 10, { format: 'video', eng: 30 }),
      ...many(3, 14, { format: 'image', eng: 10 }),
    ];
    expect(posts[0].post.format).toBe('unknown');
    const [step] = nextSteps(input({ posts }));
    expect(step.title).toBe('Videos get 3.0× more engagement than images');
  });

  it('needs two formats and a worst median above 0', () => {
    expect(
      nextSteps(input({ posts: many(10, 3, { format: 'video', eng: 30 }) })),
    ).toEqual([]);
    expect(
      nextSteps(
        input({
          posts: [
            ...many(5, 3, { format: 'video', eng: 30 }),
            ...many(5, 8, { format: 'image', eng: 0 }),
          ],
        }),
      ),
    ).toEqual([]);
  });
});

/** Channel 2 posted weekly, the newest `lastAgo` days ago, on text. */
const weekly = (lastAgo: number, channel = 2, n = 5): StepPost[] =>
  Array.from({ length: n }, (_, i) =>
    sp({ channel, ago: lastAgo + i * 7, format: 'text' }),
  );

/** Followers: +`perDay` a day up to `lastPostOn`, then `after` a day. */
function followerRows(
  channelId: number,
  lastPostOn: string,
  perDay: number,
  after: number,
): FollowerRow[] {
  const rows: FollowerRow[] = [];
  let count = 400;
  for (let d = addDays(lastPostOn, -28); d <= addDays(TODAY, -1); ) {
    const gained = d > lastPostOn ? after : perDay;
    if (d > addDays(lastPostOn, -28)) count += gained;
    rows.push({
      channelId,
      date: d,
      followersAtEndOfDay: count,
      followersGained: gained,
    });
    d = addDays(d, 1);
  }
  return rows;
}

describe('N2 quiet channel', () => {
  const quiet = (over: Partial<NextStepsInput> = {}) =>
    input({
      posts: [...quietBase(), ...weekly(20)],
      channels: [ch(1), ch(2, 'LinkedIn')],
      ...over,
    });

  it('body A with followers: grew while posting, flat since', () => {
    const followers = followerRows(2, '2026-10-15', 2, 0);
    const [step] = nextSteps(quiet({ followers }));
    expect(step).toMatchObject({
      id: 'quiet_channel:2',
      rule: 'quiet_channel',
      title: 'LinkedIn has been quiet for 20 days',
      body: 'Followers grew about 2 a day while you posted weekly. Since Oct 15 they have stayed at 456.',
      why: 'You used to post here weekly, and it has been longer than usual since the last one.',
      channelId: 2,
      lastPostOn: '2026-10-15',
      cta: { label: 'Write a LinkedIn post' },
    });
    const line = (step as Extract<NextStep, { rule: 'quiet_channel' }>)
      .followerLine!;
    expect(line[0]).toEqual({ date: '2026-09-17', followers: 400 });
    expect(line[line.length - 1]).toEqual({
      date: '2026-11-03',
      followers: 456,
    });
    expect(line).toHaveLength(48);
  });

  it('body B for LinkedIn with followerLine null', () => {
    const [step] = nextSteps(quiet());
    expect(step).toMatchObject({
      id: 'quiet_channel:2',
      title: 'LinkedIn has been quiet for 20 days',
      body: 'You posted weekly until Oct 15. Nothing has gone out since.',
      followerLine: null,
    });
  });

  it('body B when followers kept growing, or were not growing before', () => {
    const grew = nextSteps(
      quiet({ followers: followerRows(2, '2026-10-15', 2, 1) }),
    )[0];
    expect(grew.body).toBe(
      'You posted weekly until Oct 15. Nothing has gone out since.',
    );
    const slow = nextSteps(
      quiet({ followers: followerRows(2, '2026-10-15', 0, 0) }),
    )[0];
    expect(slow.body).toBe(
      'You posted weekly until Oct 15. Nothing has gone out since.',
    );
  });

  it('does not fire for a paused channel, or a channel with 2 posts', () => {
    expect(
      nextSteps(
        quiet({ channels: [ch(1), ch(2, 'LinkedIn', { isActive: false })] }),
      ),
    ).toEqual([]);
    expect(
      nextSteps(
        quiet({ channels: [ch(1), ch(2, 'LinkedIn', { healthy: false })] }),
      ),
    ).toEqual([]);
    expect(
      nextSteps(quiet({ posts: [...quietBase(), ...weekly(20, 2, 2)] })),
    ).toEqual([]);
  });

  it('threshold is max(14, 2 × median gap)', () => {
    const at = (gap: number, lastAgo: number) =>
      nextSteps(
        input({
          posts: [
            ...quietBase(),
            ...[0, 1, 2].map((i) =>
              sp({ channel: 2, ago: lastAgo + i * gap, format: 'text' }),
            ),
          ],
          channels: [ch(1), ch(2, 'LinkedIn')],
        }),
      );
    // Gap 5: threshold is the 14-day floor.
    expect(at(5, 14)).toHaveLength(1);
    expect(at(5, 13)).toEqual([]);
    // Gap 20: 2 × 20 = 40 days, so 25 quiet days is not quiet yet ...
    expect(at(20, 25)).toEqual([]);
    expect(at(20, 39)).toEqual([]);
    // ... and 40 is.
    expect(at(20, 40)).toHaveLength(1);
  });

  it('the most overdue wins; hiding it lets the next one show', () => {
    const posts = [...quietBase(), ...weekly(20, 2), ...weekly(30, 3)];
    const channels = [ch(1), ch(2, 'LinkedIn'), ch(3, 'Facebook')];
    expect(ids(nextSteps(input({ posts, channels })))).toEqual([
      'quiet_channel:3',
    ]);
    expect(
      ids(
        nextSteps(
          input({ posts, channels, hidden: new Set(['quiet_channel:3']) }),
        ),
      ),
    ).toEqual(['quiet_channel:2']);
  });

  it('a settling post is a post: the channel that posted yesterday is not quiet', () => {
    expect(
      nextSteps(
        quiet({
          posts: [
            ...quietBase(),
            ...weekly(20),
            sp({ channel: 2, ago: 1, format: 'text' }),
          ],
        }),
      ),
    ).toEqual([]);
  });
});

describe('N3 repost hit', () => {
  const hit = (o: Partial<Spec> = {}): StepPost =>
    sp({
      ago: 45,
      eng: 402,
      mult: 2.4,
      content: 'Behind the scenes\nof our studio',
      format: 'text',
      id: 'hit',
      ...o,
    });
  const withHit = (o: Partial<Spec> = {}, over: Partial<NextStepsInput> = {}) =>
    input({ posts: [...quietBase(), hit(o)], ...over });

  it('words it from S7.2', () => {
    const [step] = nextSteps(withHit());
    expect(step).toEqual({
      id: 'repost_hit:hit:1',
      rule: 'repost_hit',
      title: 'Your September hit is ready to post again',
      body: 'Behind the scenes got 402 engagements, 2.4× your usual. It is 6 weeks old.',
      why: 'This did at least twice your usual, it is over 6 weeks old, and you haven’t posted it again.',
      postId: 'hit',
      channelId: 1,
      thumbnailUrl: null,
      postTitle: 'Behind the scenes',
      meta: 'Instagram · Sep 20 · 402 engagements',
      cta: { label: 'Repost' },
    });
  });

  it('needs age 42 to 90, multiplier ≥ 2, composed', () => {
    const fires = (o: Partial<Spec>) => nextSteps(withHit(o)).length === 1;
    expect(fires({ ago: 42 })).toBe(true);
    expect(fires({ ago: 90 })).toBe(true);
    expect(fires({ ago: 41 })).toBe(false);
    expect(fires({ ago: 91 })).toBe(false);
    expect(fires({ mult: 2 })).toBe(true);
    expect(fires({ mult: 1.99 })).toBe(false);
    expect(fires({ mult: null })).toBe(false);
  });

  it('skips an imported post', () => {
    expect(nextSteps(withHit({ imported: true }))).toEqual([]);
  });

  it('skips a post on a paused channel', () => {
    expect(
      nextSteps(
        withHit({}, { channels: [ch(1, 'Instagram', { isActive: false })] }),
      ),
    ).toEqual([]);
  });

  describe('already reposted', () => {
    const later = (o: Partial<LaterPost>): LaterPost => ({
      postId: 'later',
      at: '2026-10-30T10:00:00.000Z',
      content: '',
      mediaUrls: [],
      ...o,
    });
    const steps = (l: LaterPost[], o: Partial<Spec> = {}) =>
      nextSteps(withHit(o, { later: l }));

    it('skips a post already reposted with the same caption (case and spacing aside)', () => {
      expect(
        steps([later({ content: '  behind the SCENES  of our   studio ' })]),
      ).toEqual([]);
      // A different caption is a different post.
      expect(steps([later({ content: 'Behind the scenes' })])).toHaveLength(1);
    });

    it('skips a post already reposted with the same media', () => {
      expect(
        steps([later({ mediaUrls: ['cdn/other', 'cdn/shared'] })], {
          media: ['cdn/shared'],
          format: 'image',
        }),
      ).toEqual([]);
      expect(
        steps([later({ mediaUrls: ['cdn/other'] })], {
          media: ['cdn/shared'],
          format: 'image',
        }),
      ).toHaveLength(1);
    });

    it('only a LATER post counts, and never the post itself', () => {
      const same = 'Behind the scenes\nof our studio';
      expect(
        steps([later({ content: same, at: '2026-09-01T10:00:00.000Z' })]),
      ).toHaveLength(1);
      expect(steps([later({ content: same, postId: 'hit' })])).toHaveLength(1);
    });

    it('a media-only post is not the same as every other media-only post', () => {
      expect(steps([later({ content: '' })], { content: '' })).toHaveLength(1);
    });
  });

  it('the highest multiplier wins; a hidden one gives way to the next', () => {
    const posts = [
      ...quietBase(),
      hit({ id: 'a', mult: 2.5 }),
      hit({ id: 'b', mult: 3.1, ago: 50 }),
    ];
    expect(ids(nextSteps(input({ posts })))).toEqual(['repost_hit:b:1']);
    expect(
      ids(nextSteps(input({ posts, hidden: new Set(['repost_hit:b:1']) }))),
    ).toEqual(['repost_hit:a:1']);
  });

  it('a candidate that was reposted gives way to the next', () => {
    const posts = [
      ...quietBase(),
      hit({ id: 'a', mult: 2.5, content: 'A' }),
      hit({ id: 'b', mult: 3.1, ago: 50, content: 'B' }),
    ];
    const later: LaterPost[] = [
      {
        postId: 'x',
        at: '2026-10-30T10:00:00.000Z',
        content: 'b',
        mediaUrls: [],
      },
    ];
    expect(ids(nextSteps(input({ posts, later })))).toEqual(['repost_hit:a:1']);
  });

  it('repostCandidates lists them best first', () => {
    const posts = [
      ...quietBase(),
      hit({ id: 'a', mult: 2.5 }),
      hit({ id: 'b', mult: 3.1, ago: 50 }),
    ];
    expect(
      repostCandidates({
        now: NOW,
        posts,
        channels: [ch(1)],
        hidden: new Set(),
      }).map((c) => c.post.postId),
    ).toEqual(['b', 'a']);
  });
});

describe('all rules', () => {
  it('no rules under 10 measured posts', () => {
    expect(nextSteps(input({ posts: gapBase().slice(0, 9) }))).toEqual([]);
    expect(ids(nextSteps(input()))).toEqual(['format_gap']);
    // Posts the platform has not reported on do not count towards the 10.
    const unmeasured = many(3, 13, { format: 'text', measured: false });
    expect(
      nextSteps(input({ posts: [...gapBase().slice(0, 9), ...unmeasured] })),
    ).toEqual([]);
  });

  it('settling posts feed no rule', () => {
    // Three settling carousels with 1000 each would be the best format ...
    const settling = many(3, 0, { format: 'carousel', eng: 1000 });
    expect(settling.every((p) => p.post.isSettling)).toBe(true);
    const [step] = nextSteps(input({ posts: [...gapBase(), ...settling] }));
    expect(step.title).toBe('Videos get 3.0× more engagement than images');
    // ... and 9 settled posts plus 3 settling make no 10.
    expect(
      nextSteps(input({ posts: [...gapBase().slice(0, 9), ...settling] })),
    ).toEqual([]);
    // A settling post is no repost hit either.
    expect(
      repostCandidates({
        now: NOW,
        posts: [...quietBase(), sp({ ago: 1, mult: 5, eng: 900 })],
        channels: [ch(1)],
        hidden: new Set(),
      }),
    ).toEqual([]);
  });

  it('a hidden step is not shown', () => {
    expect(nextSteps(input({ hidden: new Set(['format_gap']) }))).toEqual([]);
    // Only the hidden subject: another channel's id does not hide it.
    expect(
      ids(nextSteps(input({ hidden: new Set(['quiet_channel:1']) }))),
    ).toEqual(['format_gap']);
  });

  it('order is N1, N2, N3, at most 3', () => {
    const posts = [
      ...gapBase(),
      ...weekly(20),
      sp({ ago: 45, eng: 402, mult: 2.4, content: 'Hit', id: 'hit' }),
    ];
    const steps = nextSteps(
      input({ posts, channels: [ch(1), ch(2, 'LinkedIn')] }),
    );
    expect(ids(steps)).toEqual([
      'format_gap',
      'quiet_channel:2',
      'repost_hit:hit:1',
    ]);
    expect(steps.map((s) => s.rule)).toEqual([
      'format_gap',
      'quiet_channel',
      'repost_hit',
    ]);
    expect(steps.length).toBeLessThanOrEqual(3);
  });
});

describe('step ids', () => {
  const POST = '3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b';
  it.each([
    'format_gap',
    'quiet_channel:12',
    `repost_hit:${POST}:7`,
    `repost_hit:${POST.toUpperCase()}:7`,
  ])('accepts %s', (id) => expect(STEP_ID_PATTERN.test(id)).toBe(true));

  it.each([
    '',
    'format_gap ',
    'format_gap:1',
    'quiet_channel',
    'quiet_channel:',
    'quiet_channel:abc',
    'quiet_channel:1:2',
    `repost_hit:${POST}`,
    'repost_hit:nope:7',
    `repost_hit:${POST}:x`,
    `repost_hit:${POST}:7\n`,
    'other:1',
    `x${'a'.repeat(200)}`,
  ])('rejects %j', (id) => expect(STEP_ID_PATTERN.test(id)).toBe(false));
});

describe('normalizeCaption', () => {
  it('lowercases and collapses whitespace', () => {
    expect(normalizeCaption('  Hello\n\tWORLD  ')).toBe('hello world');
  });
});
