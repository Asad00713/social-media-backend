/**
 * Next steps (spec S7.2): up to three rule-based cards from the last 90 days
 * of the selected channels, no LLM. N1 a format gap, N2 a quiet channel, N3 an
 * old hit worth posting again, in that order. Pure: the service reads, this
 * decides and words.
 */

import { isMeasured } from '../../post-performance/engagement-stats';
import type { FollowerRow } from '../../post-performance/followers';
import {
  addDays,
  DAY_MS,
  isoDate,
  utcToday,
} from '../../post-performance/period';
import type { PublishedPost } from '../../post-performance/post-performance';
import type { NextStep } from '../dto/insights.dto';
import { MIN_SIGNAL_POSTS } from './best-time';
import { proseName, quietFollowers } from './brief-inputs';
import type { InsightFormat, InsightPost, PostFormat } from './insight-post';
import {
  followerLineOf,
  formatGapCopy,
  platformsLine,
  quietChannelCopy,
  repostHitCopy,
} from './next-steps-format';
import { QUIET_LOOKBACK_DAYS, quietChannel } from './quiet-channel';
import { formatBars } from './what-works';

/** The card list never grows past this. */
export const MAX_NEXT_STEPS = 3;
/** N1: the best format's median over the worst's, at least. */
export const FORMAT_GAP_RATIO = 1.5;
/** N1: a best-format post scheduled within this many days is "planned". */
export const FORMAT_LOOKAHEAD_DAYS = 7;
/** N1: bars drawn on the card. */
export const FORMAT_GAP_BARS = 3;
/** N3: the post is at least this many days old ... */
export const REPOST_MIN_AGE_DAYS = 42;
/** ... and at most this many (the sample is 90 days). */
export const REPOST_MAX_AGE_DAYS = 90;
/** N3: engagements over the channel's usual, at least. */
export const REPOST_MIN_MULTIPLIER = 2;
/** N2: followers must have grown at least this many a day before the last post. */
export const QUIET_FOLLOWERS_MIN_PER_DAY = 1;

/** How long each choice hides a step, in days. */
export const HIDE_DAYS = { not_useful: 180, later: 30 } as const;
/**
 * Hidden steps kept per person per workspace. The ids the rules emit are few
 * (one format card, one per channel, one per hit), so this is far above real
 * use; it only stops a member from filling the table with made-up ids.
 */
export const MAX_HIDDEN_STEPS = 500;

/**
 * N3 compares captions on their first this many characters (read the same
 * way from the database and from the candidate), so a huge caption never has
 * to cross the wire whole.
 */
export const REPOST_CAPTION_CHARS = 2000;
/** N3 reads at most this many later posts, newest first. */
export const LATER_POSTS_LIMIT = 5000;

const UUID =
  '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
/** Every id `nextSteps` can emit; anything else is not a step to hide. */
export const STEP_ID_PATTERN = new RegExp(
  `^(?:format_gap|quiet_channel:[0-9]{1,18}|repost_hit:${UUID}:[0-9]{1,18})$`,
);

/** A published post as read, with the Insights shape the rules use. */
export interface StepPost {
  raw: PublishedPost;
  post: InsightPost;
}

/** The channel facts the rules and the words need. */
export interface StepChannel {
  id: number;
  /** Display name of the platform, `Instagram`. */
  platformName: string;
  isActive: boolean;
  /** Connected and syncing. */
  healthy: boolean;
}

/** A post made after a repost candidate, as far as sameness goes. */
export interface LaterPost {
  postId: string;
  /** When it went, or goes, out: ISO 8601. */
  at: string;
  content: string;
  mediaUrls: string[];
}

export interface RepostCandidatesInput {
  now: Date;
  /** Every published post on the selected channels in the last 90 days. */
  posts: StepPost[];
  channels: StepChannel[];
  /** Step ids this person has hidden right now. */
  hidden: ReadonlySet<string>;
}

export interface NextStepsInput extends RepostCandidatesInput {
  /** Rollup rows for the selected channels over the 90 days. */
  followers: FollowerRow[];
  /** Formats of the posts scheduled in the next FORMAT_LOOKAHEAD_DAYS. */
  scheduledFormats: InsightFormat[];
  /** Workspace posts made after the oldest repost candidate. */
  later: LaterPost[];
}

/** Whole UTC days from `iso` (a `YYYY-MM-DD`) to `todayIso`. */
const ageInDays = (iso: string, todayIso: string): number =>
  Math.round((Date.parse(todayIso) - Date.parse(iso)) / DAY_MS);

/** Caption equality ignores case and spacing. */
export const normalizeCaption = (s: string): string =>
  s.toLowerCase().replace(/\s+/g, ' ').trim();

/** What two captions are compared on: the first REPOST_CAPTION_CHARS. */
const captionKey = (s: string): string =>
  normalizeCaption(s.slice(0, REPOST_CAPTION_CHARS));

const repostId = (p: Pick<InsightPost, 'postId' | 'channelId'>): string =>
  `repost_hit:${p.postId}:${p.channelId}`;

/** The measured, settled posts: the only ones a rule may count. */
const settled = (posts: StepPost[]): StepPost[] =>
  posts.filter((p) => isMeasured(p.post) && !p.post.isSettling);

/**
 * N3's candidates, best first: composed, settled, measured posts on an active
 * channel, 42 to 90 days old, at least twice their usual, not hidden. The
 * service reads the later posts only when there is one.
 */
export function repostCandidates(input: RepostCandidatesInput): StepPost[] {
  const today = isoDate(utcToday(input.now));
  const active = new Set(
    input.channels.filter((c) => c.isActive).map((c) => c.id),
  );
  return settled(input.posts)
    .filter(({ post, raw }) => {
      const age = ageInDays(raw.publishedOn, today);
      return (
        !post.imported &&
        active.has(post.channelId) &&
        age >= REPOST_MIN_AGE_DAYS &&
        age <= REPOST_MAX_AGE_DAYS &&
        post.usualMultiplier !== null &&
        post.usualMultiplier >= REPOST_MIN_MULTIPLIER &&
        !input.hidden.has(repostId(post))
      );
    })
    .sort(
      (a, b) =>
        b.post.usualMultiplier! - a.post.usualMultiplier! ||
        Date.parse(b.post.publishedAt) - Date.parse(a.post.publishedAt) ||
        a.post.postId.localeCompare(b.post.postId) ||
        a.post.channelId - b.post.channelId,
    );
}

/** Whether a later post repeats the candidate's caption or media. */
function isReposted(c: PublishedPost, later: LaterPost[]): boolean {
  const at = Date.parse(c.publishedAt);
  const caption = captionKey(c.content);
  const media = new Set(c.mediaItems.map((m) => m.url));
  return later.some(
    (l) =>
      l.postId !== c.postId &&
      Date.parse(l.at) > at &&
      ((caption !== '' && captionKey(l.content) === caption) ||
        l.mediaUrls.some((u) => media.has(u))),
  );
}

/** N1: the best format out-engages the worst and none is planned. */
function formatGap(
  input: NextStepsInput,
  measured: StepPost[],
): NextStep | null {
  if (input.hidden.has('format_gap')) return null;
  const bars = formatBars(measured.map((p) => p.post));
  if (bars.length < 2) return null;
  const best = bars[0];
  const worst = bars[bars.length - 1];
  if (!worst.median || best.median! < FORMAT_GAP_RATIO * worst.median) {
    return null;
  }
  if (input.scheduledFormats.includes(best.key as InsightFormat)) return null;

  const withPosts = new Set(measured.map((p) => p.post.channelId));
  const copy = formatGapCopy({
    best: best.key as PostFormat,
    worst: worst.key as PostFormat,
    ratio: best.median! / worst.median,
    platforms: platformsLine(
      input.channels
        .filter((c) => withPosts.has(c.id))
        .map((c) => proseName(c.platformName)),
    ),
  });
  return {
    id: 'format_gap',
    rule: 'format_gap',
    title: copy.title,
    body: copy.body,
    why: copy.why,
    bars: bars.slice(0, FORMAT_GAP_BARS).map((b) => ({
      format: b.key as InsightFormat,
      median: b.median!,
    })),
    cta: { label: copy.cta },
  };
}

/** N2: the most overdue active, healthy channel that stopped posting. */
function quiet(input: NextStepsInput): NextStep | null {
  const today = isoDate(utcToday(input.now));
  const yesterday = addDays(today, -1);
  const q = quietChannel(
    input.channels
      .filter((c) => !input.hidden.has(`quiet_channel:${c.id}`))
      .map((c) => ({
        channelId: c.id,
        // Settling and unmeasured posts count here: they are posts, and a
        // channel that posted yesterday is not quiet.
        posts: input.posts
          .filter((p) => p.raw.channelId === c.id)
          .map((p) => p.raw),
        isActive: c.isActive,
        healthy: c.healthy,
        today: input.now,
      })),
  );
  if (!q) return null;

  const f = quietFollowers(
    input.followers,
    q.channelId,
    q.lastPostOn,
    yesterday,
    yesterday,
  );
  const growing =
    f !== null &&
    f.priorPerDay >= QUIET_FOLLOWERS_MIN_PER_DAY &&
    f.gainedSince <= 0;
  const channel = input.channels.find((c) => c.id === q.channelId)!;
  const copy = quietChannelCopy({
    platform: proseName(channel.platformName),
    daysQuiet: q.daysQuiet,
    cadence: q.cadence,
    lastPostOn: q.lastPostOn,
    followers: growing ? { perDay: f.priorPerDay, count: f.count } : null,
  });
  return {
    id: `quiet_channel:${q.channelId}`,
    rule: 'quiet_channel',
    title: copy.title,
    body: copy.body,
    why: copy.why,
    channelId: q.channelId,
    lastPostOn: q.lastPostOn,
    followerLine: growing
      ? followerLineOf(
          input.followers,
          q.channelId,
          addDays(today, -QUIET_LOOKBACK_DAYS),
        )
      : null,
    cta: { label: copy.cta },
  };
}

/** N3: the best old hit nobody has posted again. */
function repostHit(input: NextStepsInput): NextStep | null {
  const hit = repostCandidates(input).find(
    ({ raw }) => !isReposted(raw, input.later),
  );
  if (!hit) return null;
  const { post, raw } = hit;
  const today = isoDate(utcToday(input.now));
  const channel = input.channels.find((c) => c.id === post.channelId);
  const copy = repostHitCopy({
    publishedOn: raw.publishedOn,
    title: post.title,
    platform: proseName(channel?.platformName ?? ''),
    engagements: post.engagements,
    multiplier: post.usualMultiplier!,
    ageDays: ageInDays(raw.publishedOn, today),
  });
  return {
    id: repostId(post),
    rule: 'repost_hit',
    title: copy.title,
    body: copy.body,
    why: copy.why,
    postId: post.postId,
    channelId: post.channelId,
    thumbnailUrl: post.thumbnailUrl,
    postTitle: post.title,
    meta: copy.meta,
    cta: { label: 'Repost' },
  };
}

/**
 * The cards, N1 then N2 then N3, at most MAX_NEXT_STEPS. None under
 * MIN_SIGNAL_POSTS measured, settled posts: too little to say anything.
 * Hidden subjects are skipped, so hiding the most overdue channel lets the
 * next one show.
 */
export function nextSteps(input: NextStepsInput): NextStep[] {
  const measured = settled(input.posts);
  if (measured.length < MIN_SIGNAL_POSTS) return [];
  return [formatGap(input, measured), quiet(input), repostHit(input)]
    .filter((s): s is NextStep => s !== null)
    .slice(0, MAX_NEXT_STEPS);
}
