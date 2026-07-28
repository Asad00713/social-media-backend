import type { Workspace } from '../drizzle/schema';

export type WorkspaceRoleLabel = 'OWNER' | 'ADMIN' | 'MEMBER' | 'GUEST';
export type WorkspaceWithRole = Workspace & { role: WorkspaceRoleLabel };

export function mergeWorkspacesWithRoles(
  owned: Workspace[],
  memberships: { workspace: Workspace; role: 'ADMIN' | 'MEMBER' | 'GUEST' }[],
): WorkspaceWithRole[] {
  const byId = new Map<string, WorkspaceWithRole>();
  for (const w of owned) byId.set(w.id, { ...w, role: 'OWNER' });
  for (const m of memberships) {
    if (byId.has(m.workspace.id)) continue; // owner wins
    byId.set(m.workspace.id, { ...m.workspace, role: m.role });
  }
  return [...byId.values()];
}
