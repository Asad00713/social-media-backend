import type { AnyTemplateDef } from '../types';
import { accountPaused } from './account-paused';
import { deletionWarning } from './deletion-warning';
import { inactiveReminder } from './inactive-reminder';
import { pausingSoon } from './pausing-soon';
import { welcome } from './welcome';

/** The lifecycle templates. Each template task appends its def here. */
export const LIFECYCLE_TEMPLATES: AnyTemplateDef[] = [
  welcome,
  inactiveReminder,
  pausingSoon,
  accountPaused,
  deletionWarning,
];
