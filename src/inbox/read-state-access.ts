import {
  roleCan,
  type WorkspaceRole,
} from '../workspace-members/role-capabilities';

/**
 * Read state is shared across the workspace: there is no per-user read row, so
 * "read" flips the unread badge for everyone. A role that cannot reply may open
 * a conversation (the route stays on inbox:view) but must not clear it for the
 * team, so the read routes skip the write for it and still answer 200.
 */
export function mayChangeReadState(
  role: WorkspaceRole | 'SUPER_ADMIN' | undefined,
): boolean {
  return role === 'SUPER_ADMIN' || (!!role && roleCan(role, 'inbox:reply'));
}
