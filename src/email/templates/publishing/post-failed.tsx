import { EmailButton } from '../../render/components/button';
import { Callout } from '../../render/components/callout';
import { PostCard } from '../../render/components/post-card';
import { Heading, Paragraph } from '../../render/components/text';
import { PREVIEW_THUMBNAIL_URL } from '../../preview/preview-assets';
import { defineTemplate } from '../define-template';

export interface PostFailedProps {
  platform: string;
  platformName: string;
  handle: string;
  when: string;
  caption: string;
  thumbnailUrl: string | null;
  /** The stored target errorMessage (spec §4.4 item 1). */
  reason: string;
  /** Display names of the networks the same post reached. */
  otherPublished: string[];
  editUrl: string;
}

const REASON_LIMIT = 200;

/** 'A', 'A and B', 'A, B and C'. */
export function listNames(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** A failure reason cut to 200 code points (199 plus `…`). */
export function failureReason(reason: string): string {
  const chars = Array.from(reason.trim());
  if (chars.length <= REASON_LIMIT) return chars.join('');
  return `${chars.slice(0, REASON_LIMIT - 1).join('')}…`;
}

const FIXTURE: PostFailedProps = {
  platform: 'instagram',
  platformName: 'Instagram',
  handle: '@lumierecafe',
  when: 'Today, 6:30 PM',
  caption:
    'Iced caramel latte, one more week. Come in before Sunday and try it with our new oat milk.',
  thumbnailUrl: null,
  reason: 'Instagram didn’t accept the video: it’s longer than 90 seconds.',
  otherPublished: ['Facebook', 'TikTok'],
  editUrl: 'http://localhost:3001/w/demo/planner?post=demo',
};

/** C1: one post did not publish. */
export const POST_FAILED = defineTemplate<PostFailedProps>({
  id: 'post-failed',
  category: 'publishing',
  event: 'post_failed',
  footer: 'notification',
  subject: (p) => `Your ${p.platformName} post didn’t publish`,
  preheader: (p) =>
    `${p.platformName} didn’t accept it. Edit it and we’ll try again.`,
  Body: (p) => (
    <>
      <Heading>{`Your ${p.platformName} post didn’t publish`}</Heading>
      <PostCard
        platform={p.platform}
        handle={p.handle}
        when={p.when}
        caption={p.caption}
        thumbnailUrl={p.thumbnailUrl}
      />
      <Callout tone="danger">{failureReason(p.reason)}</Callout>
      <Paragraph>
        {p.otherPublished.length > 0
          ? `The same post on ${listNames(p.otherPublished)} went out on time.`
          : 'Fix it and publish again.'}
      </Paragraph>
      <EmailButton href={p.editUrl} variant="primary">
        Edit post
      </EmailButton>
    </>
  ),
  fixture: FIXTURE,
  variants: {
    // Preview only: a loadable picture, so the thumbnail branch is seen.
    thumbnail: { ...FIXTURE, thumbnailUrl: PREVIEW_THUMBNAIL_URL },
    alone: {
      platform: 'linkedin',
      platformName: 'LinkedIn',
      handle: 'Lumière Café',
      when: 'Today, 12:15 PM',
      caption: '',
      thumbnailUrl: null,
      reason: 'Image is larger than LinkedIn allows',
      otherPublished: [],
      editUrl: 'http://localhost:3001/w/demo/planner?post=demo',
    },
    unsafe: {
      platform: 'twitter',
      platformName: 'X',
      handle: '@a&b "quoted"',
      when: 'Today, 9:00 AM',
      caption: `<script>alert("x")</script> & ${'long caption '.repeat(400)}`,
      thumbnailUrl: null,
      reason: `<b>raw</b> ${'error '.repeat(100)}`,
      otherPublished: ['Threads', 'Bluesky', 'Mastodon'],
      editUrl: 'http://localhost:3001/w/demo/planner?post=demo',
    },
  },
});
