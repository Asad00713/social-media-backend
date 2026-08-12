import type { Workspace } from '../drizzle/schema';

export type WorkspaceRoleLabel = 'OWNER' | 'ADMIN' | 'MEMBER' | 'GUEST';

// Workspace shape safe to return to clients: excludes admin-only internal
// columns (`suspensionNote`, `suspendedById`) that must never leak via
// /auth/me. Keep in sync with the `columns` projection used in
// AuthService#whoAmI.
export type PublicWorkspace = Omit<
  Workspace,
  'suspensionNote' | 'suspendedById'
>;

export type WorkspaceWithRole = PublicWorkspace & { role: WorkspaceRoleLabel };

export function mergeWorkspacesWithRoles(
  owned: PublicWorkspace[],
  memberships: {
    workspace: PublicWorkspace;
    role: 'ADMIN' | 'MEMBER' | 'GUEST';
  }[],
): WorkspaceWithRole[] {
  const byId = new Map<string, WorkspaceWithRole>();
  for (const w of owned) byId.set(w.id, { ...w, role: 'OWNER' });
  for (const m of memberships) {
    if (byId.has(m.workspace.id)) continue; // owner wins
    byId.set(m.workspace.id, { ...m.workspace, role: m.role });
  }
  return [...byId.values()];
}
