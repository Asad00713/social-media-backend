import { roleCan, type WorkspaceRole } from '../workspace-members/role-capabilities';

/** What a controller hands a service: the caller's role, or undefined for internal callers. */
export type CallerRole = WorkspaceRole | 'SUPER_ADMIN' | undefined;

/**
 * A "viewer" is any caller whose role cannot publish (today: GUEST). They may
 * draft, but never schedule or publish, and may only touch their own drafts.
 *
 * Internal callers (queue processors, calendar sync) pass no role and are not
 * restricted; so is a platform super admin.
 */
export function isViewer(role: CallerRole): boolean {
  return (
    role !== undefined &&
    role !== 'SUPER_ADMIN' &&
    !roleCan(role, 'posts:publish')
  );
}
