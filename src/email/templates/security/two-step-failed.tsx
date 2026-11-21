import { Heading, Paragraph } from '../../render/components/text';
import { defineTemplate } from '../define-template';
import {
  NotMe,
  TWO_STEP_FIXTURE,
  TwoStepDetails,
  type TwoStepNoticeProps,
} from './two-step-shared';

export type TwoStepFailedProps = TwoStepNoticeProps;

/** The right password (or Google) followed by a wrong second factor. */
export const twoStepFailedTemplate = defineTemplate<TwoStepFailedProps>({
  id: 'two-step-failed',
  category: 'security',
  event: null,
  footer: 'security',
  subject: () => 'Someone entered your password but not your code',
  preheader: () => 'Your password is correct, so change it now.',
  Body: (p) => (
    <>
      <Heading>Someone entered your password but not your code</Heading>
      <Paragraph>
        A sign-in got past your password and then entered a wrong two-step code.
        Your password is correct, so change it now.
      </Paragraph>
      <TwoStepDetails p={p} />
      <NotMe p={p} />
    </>
  ),
  fixture: TWO_STEP_FIXTURE,
});
