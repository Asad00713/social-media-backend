import { Heading, Paragraph } from '../../render/components/text';
import { defineTemplate } from '../define-template';
import {
  NotMe,
  TWO_STEP_FIXTURE,
  TwoStepDetails,
  type TwoStepNoticeProps,
} from './two-step-shared';

export interface TwoStepDisabledProps extends TwoStepNoticeProps {
  /** `you`: from Settings. `support`: an admin reset at the person's request. */
  by: 'you' | 'support';
}

const BODY: Record<TwoStepDisabledProps['by'], string> = {
  you: 'Signing in now needs only your password or Google. We signed you out everywhere else.',
  support:
    'Our support team turned off two-step sign-in at your request. We signed you out everywhere.',
};

/** Two-step sign-in was turned off, by the person or by support. */
export const twoStepDisabledTemplate = defineTemplate<TwoStepDisabledProps>({
  id: 'two-step-disabled',
  category: 'security',
  event: null,
  footer: 'security',
  subject: () => 'Two-step sign-in is off',
  preheader: () => 'Your account no longer asks for a code.',
  Body: (p) => (
    <>
      <Heading>Two-step sign-in is off</Heading>
      <Paragraph>{BODY[p.by]}</Paragraph>
      <TwoStepDetails p={p} />
      <NotMe p={p} />
    </>
  ),
  fixture: { ...TWO_STEP_FIXTURE, by: 'you' },
  variants: { support: { ...TWO_STEP_FIXTURE, by: 'support' } },
});
