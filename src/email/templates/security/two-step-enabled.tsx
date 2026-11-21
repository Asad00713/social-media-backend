import { Heading, Paragraph } from '../../render/components/text';
import { defineTemplate } from '../define-template';
import {
  NotMe,
  TWO_STEP_FIXTURE,
  TwoStepDetails,
  type TwoStepNoticeProps,
} from './two-step-shared';

export type TwoStepEnabledProps = TwoStepNoticeProps;

/** Two-step sign-in was turned on from Settings → Security. */
export const twoStepEnabledTemplate = defineTemplate<TwoStepEnabledProps>({
  id: 'two-step-enabled',
  category: 'security',
  event: null,
  footer: 'security',
  subject: () => 'Two-step sign-in is on',
  preheader: () => 'New devices will now ask for a code from your phone.',
  Body: (p) => (
    <>
      <Heading>Two-step sign-in is on</Heading>
      <Paragraph>
        Signing in on a new device now asks for a code from your authenticator
        app. We signed you out everywhere else.
      </Paragraph>
      <TwoStepDetails p={p} />
      <NotMe p={p} />
    </>
  ),
  fixture: TWO_STEP_FIXTURE,
});
