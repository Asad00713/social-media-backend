import { EmailButton } from '../../render/components/button';
import { PostCard } from '../../render/components/post-card';
import { Heading, Paragraph } from '../../render/components/text';
import { defineTemplate } from '../define-template';

export interface PostApprovedProps {
  approverName: string;
  platform: string;
  /** Display name of the post's first network ('twitter' -> 'X'). */
  platformName: string;
  handle: string;
  /** The scheduled time, or `Not scheduled yet`. */
  when: string;
  caption: string;
  thumbnailUrl: string | null;
  /** `It goes out on ... Nothing else to do.` or `It's ready to schedule.` */
  goesOutSentence: string;
  plannerUrl: string;
}

/** What a draft with no time reads as in an email. */
export const NOT_SCHEDULED = 'Not scheduled yet';

/** The first word of a name; an email address gives its local part. */
export function firstName(name: string): string {
  const first = name.trim().split(/\s+/)[0] ?? '';
  return first.split('@')[0] || first;
}

/** C4: sent to the author when someone approves their draft. */
export const POST_APPROVED = defineTemplate<PostApprovedProps>({
  id: 'post-approved',
  category: 'publishing',
  event: 'post_approved',
  footer: 'notification',
  subject: (p) => `${firstName(p.approverName)} approved your post`,
  // Built from the parts, so it is the sentence without "Nothing else to do."
  preheader: (p) =>
    p.when === NOT_SCHEDULED
      ? "It's ready to schedule."
      : `It goes out on ${p.platformName} ${p.when}.`,
  Body: (p) => (
    <>
      <Heading>{`${firstName(p.approverName)} approved your post`}</Heading>
      <PostCard
        platform={p.platform}
        handle={p.handle}
        when={p.when}
        caption={p.caption}
        thumbnailUrl={p.thumbnailUrl}
      />
      <Paragraph>{p.goesOutSentence}</Paragraph>
      <EmailButton href={p.plannerUrl} variant="secondary">
        View in Planner
      </EmailButton>
    </>
  ),
  fixture: {
    approverName: 'Sana Noor',
    platform: 'instagram',
    platformName: 'Instagram',
    handle: '@lumierecafe',
    when: 'Oct 26, 2026 at 6:30 PM GMT+5',
    caption:
      'Summer menu is here: iced caramel latte for Rs 650, all week. Tag a friend who needs one.',
    thumbnailUrl: null,
    goesOutSentence:
      'It goes out on Instagram Oct 26, 2026 at 6:30 PM GMT+5. Nothing else to do.',
    plannerUrl: 'https://app.schedura.ai/w/ws-1/planner?post=post-1',
  },
  variants: {
    'not-scheduled': {
      approverName: 'Sana Noor',
      platform: 'instagram',
      platformName: 'Instagram',
      handle: '@lumierecafe',
      when: 'Not scheduled yet',
      caption: 'Summer menu is here.',
      thumbnailUrl: null,
      goesOutSentence: "It's ready to schedule.",
      plannerUrl: 'https://app.schedura.ai/w/ws-1/planner?post=post-1',
    },
  },
});
