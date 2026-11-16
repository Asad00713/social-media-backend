import { EmailButton } from '../../render/components/button';
import { DetailRows } from '../../render/components/detail-rows';
import { PostCard } from '../../render/components/post-card';
import { Heading, Paragraph } from '../../render/components/text';
import { PREVIEW_THUMBNAIL_URL } from '../../preview/preview-assets';
import { defineTemplate } from '../define-template';

export interface ApprovalNeededProps {
  requesterName: string;
  platform: string;
  /** Display name of the post's first network ('twitter' -> 'X'). */
  platformName: string;
  handle: string;
  /** The scheduled time, or `Not scheduled yet`. */
  when: string;
  caption: string;
  thumbnailUrl: string | null;
  /** Only when the post belongs to a campaign that still exists. */
  campaignName: string | null;
  /** The scheduled time, or `Not scheduled yet`. */
  goesOut: string;
  reviewUrl: string;
  workspaceName: string;
}

const FIXTURE: ApprovalNeededProps = {
  requesterName: 'M Rehman',
  platform: 'instagram',
  platformName: 'Instagram',
  handle: '@lumierecafe',
  when: 'Oct 26, 2026 at 6:30 PM GMT+5',
  caption:
    'Summer menu is here: iced caramel latte for Rs 600, all week. Tag a friend who needs one.',
  thumbnailUrl: null,
  // Figma C3: the preheader reads … · Summer menu campaign.
  campaignName: 'Summer menu campaign',
  goesOut: 'Oct 26, 2026 at 6:30 PM GMT+5',
  reviewUrl: 'https://app.schedura.ai/w/ws-1/planner?post=post-1',
  workspaceName: 'Rehman Workspace',
};

/**
 * C3: sent to each person who can approve. The Figma "Note from ..." quote is
 * left out on purpose: an approval request carries no note (spec 4.4 item 2).
 */
export const APPROVAL_NEEDED = defineTemplate<ApprovalNeededProps>({
  id: 'approval-needed',
  category: 'publishing',
  event: 'approval_request',
  footer: 'notification',
  subject: (p) => `${p.requesterName} asked you to approve a post`,
  preheader: (p) =>
    `${p.platformName} · ${p.when}${p.campaignName ? ` · ${p.campaignName}` : ''}`,
  footerReason: (p) =>
    `You get this because you approve posts in ${p.workspaceName}.`,
  Body: (p) => (
    <>
      <Heading>{`${p.requesterName} asked you to approve a post`}</Heading>
      <PostCard
        platform={p.platform}
        handle={p.handle}
        when={p.when}
        caption={p.caption}
        thumbnailUrl={p.thumbnailUrl}
      />
      <DetailRows
        rows={[
          ...(p.campaignName
            ? [{ label: 'Campaign', value: p.campaignName }]
            : []),
          { label: 'Goes out', value: p.goesOut },
        ]}
      />
      <EmailButton href={p.reviewUrl} variant="primary">
        Review post
      </EmailButton>
      <Paragraph tone="muted">
        Review and approve it in Schedura. It won’t publish until someone
        approves it.
      </Paragraph>
    </>
  ),
  fixture: FIXTURE,
  variants: {
    // Preview only: a loadable picture, so the thumbnail branch is seen.
    thumbnail: { ...FIXTURE, thumbnailUrl: PREVIEW_THUMBNAIL_URL },
    'not-scheduled': {
      requesterName: 'M Rehman',
      platform: 'instagram',
      platformName: 'Instagram',
      handle: '@lumierecafe',
      when: 'Not scheduled yet',
      caption: 'Summer menu is here.',
      thumbnailUrl: null,
      campaignName: null,
      goesOut: 'Not scheduled yet',
      reviewUrl: 'https://app.schedura.ai/w/ws-1/planner?post=post-1',
      workspaceName: 'Rehman Workspace',
    },
  },
});
