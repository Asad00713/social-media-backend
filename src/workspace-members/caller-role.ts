import type { WorkspaceRole } from './role-capabilities';

/** What a controller hands a service: the caller's role, or undefined for internal callers. */
export type CallerRole = WorkspaceRole | 'SUPER_ADMIN' | undefined;
