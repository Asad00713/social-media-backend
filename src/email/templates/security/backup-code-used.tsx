import { Heading, Paragraph } from '../../render/components/text';
import { defineTemplate } from '../define-template';
import {
  NotMe,
  TWO_STEP_FIXTURE,
  TwoStepDetails,
  type TwoStepNoticeProps,
} from './two-step-shared';

export interface BackupCodeUsedProps extends TwoStepNoticeProps {
  /** Unused backup codes left after this one. */
  remaining: number;
}

/** A backup code was spent to sign in. */
export const backupCodeUsedTemplate = defineTemplate<BackupCodeUsedProps>({
  id: 'backup-code-used',
  category: 'security',
  event: null,
  footer: 'security',
  subject: () => 'A backup code was used to sign in',
  preheader: (p) =>
    `${p.remaining} backup code${p.remaining === 1 ? '' : 's'} left.`,
  Body: (p) => (
    <>
      <Heading>A backup code was used to sign in</Heading>
      <Paragraph>
        Someone signed in to your account with one of your backup codes. Each
        code works once.
      </Paragraph>
      <TwoStepDetails p={p} />
      <Paragraph>
        {p.remaining} backup code{p.remaining === 1 ? '' : 's'} left.
        {p.remaining <= 2 ? ' Make new ones in Settings → Security.' : ''}
      </Paragraph>
      <NotMe p={p} />
    </>
  ),
  fixture: { ...TWO_STEP_FIXTURE, remaining: 7 },
  variants: { low: { ...TWO_STEP_FIXTURE, remaining: 2 } },
});
