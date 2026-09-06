import {
  resolveWorkspaceLimits,
  PlanLimits,
  AddonQuantities,
} from './limit-resolver.util';

export interface WorkspaceRef {
  id: string;
  createdAt: Date;
}

export interface WorkspaceLimitWrite {
  workspaceId: string;
  channelsLimit: number;
  membersLimit: number;
  aiTokensLimit: number;
}

/**
 * The account's primary workspace is its oldest one. Purchased channels and
 * member seats land here; every other workspace the account owns arrives empty
 * (see resolveWorkspaceLimits for why).
 *
 * Oldest-wins is stable: it does not move when a workspace is added or renamed,
 * so a user's channels do not silently migrate between workspaces.
 */
export function pickPrimaryWorkspaceId(
  workspaces: WorkspaceRef[],
): string | null {
  if (workspaces.length === 0) return null;
  return workspaces.reduce((oldest, ws) =>
    ws.createdAt.getTime() < oldest.createdAt.getTime() ? ws : oldest,
  ).id;
}

/**
 * Build the workspace_usage limit writes for EVERY workspace the account owns.
 *
 * Before account-scoped billing a subscription mapped to exactly one workspace,
 * so limit changes wrote a single row. One subscription now covers many
 * workspaces: writing one row would leave the others on their previous plan's
 * limits — silently, with no error. Every caller that changes a plan or an
 * add-on must write all of these.
 */
export function buildUsageFanout(
  workspaces: WorkspaceRef[],
  plan: PlanLimits,
  addons: AddonQuantities,
): WorkspaceLimitWrite[] {
  const primaryId = pickPrimaryWorkspaceId(workspaces);

  return workspaces.map((ws) => {
    const limits = resolveWorkspaceLimits(plan, addons, ws.id === primaryId);
    return {
      workspaceId: ws.id,
      channelsLimit: limits.channelsLimit,
      membersLimit: limits.membersLimit,
      aiTokensLimit: limits.aiTokensLimit,
    };
  });
}
