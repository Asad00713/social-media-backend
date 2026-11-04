import { isMeasured, median } from '../../post-performance/engagement-stats';
import { POST_FORMATS, type InsightPost } from './insight-post';

/** A format or a tag needs this many measured posts for a bar. */
export const MIN_FORMAT_POSTS = 3;
/** Topic bars shown before Untagged. */
export const MAX_TOPIC_BARS = 4;

export interface WorkBar {
  /** A format bucket (`video`…) or a Library tag as written. */
  key: string;
  posts: number;
  /** Median engagements per post. */
  median: number | null;
}

export interface TopicBars {
  /** Tags with at least MIN_FORMAT_POSTS posts, best first, at most 4. */
  bars: WorkBar[];
  /** Measured posts with no Library tag: the page's Untagged row. */
  untaggedPosts: number;
  /** Whether any measured post has a tag at all (else the empty state). */
  hasAnyTag: boolean;
}

/**
 * Bars from groups of engagements: only groups with MIN_FORMAT_POSTS posts,
 * by median, highest first; a tie goes to more posts, then to `order`.
 */
function barsOf(groups: Map<string, number[]>, order: string[]): WorkBar[] {
  return [...groups]
    .filter(([, vs]) => vs.length >= MIN_FORMAT_POSTS)
    .map(
      ([key, vs]): WorkBar => ({ key, posts: vs.length, median: median(vs) }),
    )
    .sort(
      (a, b) =>
        b.median! - a.median! ||
        b.posts - a.posts ||
        order.indexOf(a.key) - order.indexOf(b.key),
    );
}

/**
 * Median engagements per measured post, per format. The median, so one viral
 * post can't move a bar. `unknown` (an imported post its platform didn't
 * describe) is never a bar.
 */
export function formatBars(posts: InsightPost[]): WorkBar[] {
  const groups = new Map<string, number[]>();
  for (const p of posts) {
    if (p.format === 'unknown' || !isMeasured(p)) continue;
    const list = groups.get(p.format) ?? [];
    list.push(p.engagements);
    groups.set(p.format, list);
  }
  return barsOf(groups, [...POST_FORMATS]);
}

/** A post's tags, trimmed, blanks and repeats dropped. */
function cleanTags(tags: string[] | undefined): string[] {
  const seen = new Set<string>();
  for (const t of tags ?? []) {
    const tag = typeof t === 'string' ? t.trim() : '';
    if (tag) seen.add(tag);
  }
  return [...seen];
}

/**
 * Median engagements per measured post, per Library tag of the media the post
 * used (`tagsByPost`, keyed by post id). A post with two tags counts under
 * both. A post on two channels counts once per channel, as everywhere else.
 */
export function topicBars(
  posts: InsightPost[],
  tagsByPost: Map<string, string[]>,
): TopicBars {
  const groups = new Map<string, number[]>();
  let untaggedPosts = 0;
  for (const p of posts) {
    if (!isMeasured(p)) continue;
    const tags = cleanTags(tagsByPost.get(p.postId));
    if (!tags.length) {
      untaggedPosts += 1;
      continue;
    }
    for (const tag of tags) {
      const list = groups.get(tag) ?? [];
      list.push(p.engagements);
      groups.set(tag, list);
    }
  }
  const byName = [...groups.keys()].sort();
  return {
    bars: barsOf(groups, byName).slice(0, MAX_TOPIC_BARS),
    untaggedPosts,
    hasAnyTag: groups.size > 0,
  };
}
