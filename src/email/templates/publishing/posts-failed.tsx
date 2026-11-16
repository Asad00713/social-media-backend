import { EmailButton } from '../../render/components/button';
import { networkName } from '../../render/components/post-card';
import { PostRow } from '../../render/components/post-row';
import { Heading, Paragraph } from '../../render/components/text';
import { PREVIEW_THUMBNAIL_URL } from '../../preview/preview-assets';
import { defineTemplate } from '../define-template';
import { failureReason, listNames } from './post-failed';

export interface PostsFailedRow {
  platform: string;
  handle: string;
  when: string;
  title: string;
  reason: string;
  thumbnailUrl: string | null;
}

export interface PostsFailedProps {
  /** Distinct posts: one post failing on two networks counts once. */
  count: number;
  /** One per failure (a post on a network), at most 10; `more` counts the rest. */
  rows: PostsFailedRow[];
  more: number;
  /** Every network that turned one down, the hidden rows' included. */
  platforms: string[];
  /** Posts in the workspace that went out since local midnight. */
  otherOnTime: number;
  plannerUrl: string;
}

/**
 * 'Instagram, TikTok and LinkedIn each turned one down.' when every failure
 * is on its own network; otherwise 'Instagram turned them down.'
 */
function networksLine(p: PostsFailedProps): string {
  const names = [...new Set(p.platforms.map(networkName))];
  const eachOnce = names.length === p.rows.length + p.more;
  return eachOnce
    ? `${listNames(names)} each turned one down.`
    : `${listNames(names)} turned them down.`;
}

function headline(count: number): string {
  return `${count} ${count === 1 ? 'post' : 'posts'} didn’t publish today`;
}

function onTimeLine(n: number): string {
  if (n === 0) return '';
  return ` Your other ${n} ${n === 1 ? 'post' : 'posts'} went out on time.`;
}

/** One post that failed on several networks is "it", not "each one". */
function fixLine(count: number): string {
  return count === 1 ? 'It needs a quick fix.' : 'Each one needs a quick fix.';
}

const FIXTURE: PostsFailedProps = {
  count: 3,
  rows: [
    {
      platform: 'instagram',
      handle: '@lumierecafe',
      when: '6:30 PM',
      title: 'Iced caramel latte, one more week',
      reason: 'Video is longer than 90 seconds',
      thumbnailUrl: null,
    },
    {
      platform: 'tiktok',
      handle: '@lumierecafe',
      when: '8:00 AM',
      title: 'Behind the bar: morning prep',
      reason: 'TikTok needs you to sign in again',
      thumbnailUrl: null,
    },
    {
      platform: 'linkedin',
      handle: 'Lumière Café',
      when: '12:15 PM',
      title: 'We’re hiring baristas in DHA',
      reason: 'Image is larger than LinkedIn allows',
      thumbnailUrl: null,
    },
  ],
  more: 0,
  platforms: ['instagram', 'tiktok', 'linkedin'],
  otherOnTime: 9,
  plannerUrl: 'http://localhost:3001/w/demo/planner',
};

/** C1a: several failures from one 10-minute window. */
export const POSTS_FAILED = defineTemplate<PostsFailedProps>({
  id: 'posts-failed',
  category: 'publishing',
  event: 'post_failed',
  footer: 'notification',
  subject: (p) => headline(p.count),
  preheader: networksLine,
  Body: (p) => (
    <>
      <Heading>{headline(p.count)}</Heading>
      <Paragraph>{`${fixLine(p.count)}${onTimeLine(p.otherOnTime)}`}</Paragraph>
      {p.rows.map((r, i) => (
        <PostRow
          key={i}
          platform={r.platform}
          handle={r.handle}
          when={r.when}
          title={r.title}
          reason={failureReason(r.reason)}
          thumbnailUrl={r.thumbnailUrl}
        />
      ))}
      {p.more > 0 ? (
        <Paragraph tone="muted">{`and ${p.more} more`}</Paragraph>
      ) : null}
      <EmailButton href={p.plannerUrl} variant="primary">
        Open Planner
      </EmailButton>
    </>
  ),
  fixture: FIXTURE,
  variants: {
    // Preview only: a loadable picture, so the thumbnail branch is seen.
    thumbnail: {
      ...FIXTURE,
      rows: FIXTURE.rows.map((r) => ({
        ...r,
        thumbnailUrl: PREVIEW_THUMBNAIL_URL,
      })),
    },
    overflow: {
      count: 15,
      rows: Array.from({ length: 10 }, (_, i) => ({
        platform: 'instagram',
        handle: '@lumierecafe',
        when: `${i + 1}:00 PM`,
        title: i === 0 ? '' : `Post number ${i + 1}`,
        reason: 'Video is longer than 90 seconds',
        thumbnailUrl: null,
      })),
      more: 5,
      platforms: ['instagram'],
      otherOnTime: 0,
      plannerUrl: 'http://localhost:3001/w/demo/planner',
    },
  },
});
