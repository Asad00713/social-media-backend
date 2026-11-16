import { EmailButton } from '../../render/components/button';
import { displayCaption } from '../../render/components/post-card';
import { Quote } from '../../render/components/quote';
import { Heading, Paragraph } from '../../render/components/text';
import { defineTemplate } from '../define-template';
import { listNames } from './post-failed';

export interface DripReviewProps {
  campaignName: string;
  /** When it publishes, in the workspace's time zone. */
  when: string;
  caption: string;
  /** Display names of the networks the post is drafted for. */
  platforms: string[];
  reviewUrl: string;
}

const FIXTURE: DripReviewProps = {
  campaignName: 'Weekly coffee tips',
  when: 'Nov 20, 2026 at 9:00 AM GMT+5',
  caption:
    'Cold brew is just patience in a jar. Steep it overnight and thank yourself tomorrow.',
  platforms: ['Instagram', 'Facebook', 'LinkedIn'],
  reviewUrl: 'http://localhost:3001/w/demo/planner',
};

/** A drip post is drafted and waits for a look before it publishes itself. */
export const dripReview = defineTemplate<DripReviewProps>({
  id: 'drip-review',
  category: 'publishing',
  event: 'drip_review',
  footer: 'notification',
  subject: (p) => `Review your post for "${p.campaignName}"`,
  preheader: (p) =>
    `It publishes ${p.when}. Change it before then if you like.`,
  Body: (p) => (
    <>
      <Heading>{`Review your post for "${p.campaignName}"`}</Heading>
      <Paragraph>
        {`Your next post is ready. It publishes on ${p.when}, and goes out as it is if you change nothing.`}
      </Paragraph>
      <Quote
        meta={
          p.platforms.length > 0
            ? `Drafted for ${listNames(p.platforms)}`
            : 'Drafted post'
        }
      >
        {displayCaption(p.caption)}
      </Quote>
      <EmailButton href={p.reviewUrl} variant="primary">
        Review post
      </EmailButton>
    </>
  ),
  fixture: FIXTURE,
  variants: {
    unsafe: {
      ...FIXTURE,
      campaignName: 'A & B "Launch" <b>',
      caption: `<script>alert("x")</script> & ${'long caption '.repeat(400)}`,
    },
    empty: { ...FIXTURE, caption: '', platforms: [] },
  },
});
