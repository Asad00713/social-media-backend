import { Heading, Paragraph } from '../../render/components/text';
import { defineTemplate } from '../define-template';
import {
  NotMe,
  TWO_STEP_FIXTURE,
  TwoStepDetails,
  type TwoStepNoticeProps,
} from './two-step-shared';

export type BackupCodesRegeneratedProps = TwoStepNoticeProps;

/** New backup codes were made; the old ones no longer work. */
export const backupCodesRegeneratedTemplate =
  defineTemplate<BackupCodesRegeneratedProps>({
    id: 'backup-codes-regenerated',
    category: 'security',
    event: null,
    footer: 'security',
    subject: () => 'Your backup codes were replaced',
    preheader: () => 'Your old backup codes no longer work.',
    Body: (p) => (
      <>
        <Heading>Your backup codes were replaced</Heading>
        <Paragraph>
          New backup codes were made for your account. The old ones no longer
          work.
        </Paragraph>
        <TwoStepDetails p={p} />
        <NotMe p={p} />
      </>
    ),
    fixture: TWO_STEP_FIXTURE,
  });
