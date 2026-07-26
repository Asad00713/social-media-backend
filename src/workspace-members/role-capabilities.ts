export type WorkspaceRole = 'OWNER' | 'ADMIN' | 'MEMBER' | 'GUEST';
export type Capability =
  | 'billing:manage'
  | 'workspace:delete'
  | 'team:manage'
  | 'channels:manage'
  | 'posts:publish'
  | 'inbox:reply'
  | 'posts:draft'
  | 'inbox:view'
  | 'analytics:view';

export const ROLE_RANK: Record<WorkspaceRole, number> = {
  OWNER: 4,
  ADMIN: 3,
  MEMBER: 2,
  GUEST: 1,
};

export const CAPABILITY_MIN_ROLE: Record<Capability, WorkspaceRole> = {
  'billing:manage': 'OWNER',
  'workspace:delete': 'OWNER',
  'team:manage': 'ADMIN',
  'channels:manage': 'MEMBER',
  'posts:publish': 'MEMBER',
  'inbox:reply': 'MEMBER',
  'posts:draft': 'GUEST',
  'inbox:view': 'GUEST',
  'analytics:view': 'GUEST',
};

export function roleCan(role: WorkspaceRole, capability: Capability): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[CAPABILITY_MIN_ROLE[capability]];
}
