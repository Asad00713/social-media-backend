import type { AnyTemplateDef } from '../types';
import { channelConnectLink } from './channel-connect-link';
import { invitationAccepted } from './invitation-accepted';
import { removedFromWorkspace } from './removed-from-workspace';
import { workspaceInvitation } from './workspace-invitation';

/** The team templates. Each template task appends its def here. */
export const TEAM_TEMPLATES: AnyTemplateDef[] = [
  workspaceInvitation,
  invitationAccepted,
  removedFromWorkspace,
  channelConnectLink,
];
