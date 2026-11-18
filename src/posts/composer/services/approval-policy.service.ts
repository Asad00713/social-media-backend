import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { DbType } from '../../../drizzle/db';
import { DRIZZLE } from '../../../drizzle/drizzle.module';
import {
  workspace,
  type ApprovalPolicy,
} from '../../../drizzle/schema/workspace.schema';
import type { WorkspaceRole } from '../../../workspace-members/role-capabilities';
import { WorkspaceRoleService } from '../../../workspace-members/workspace-role.service';

/**
 * Whether the workspace approval policy (`workspace.approval_policy`, 0089)
 * covers someone holding this role: `members` covers MEMBER and GUEST,
 * `everyone` covers every workspace role, `none` nobody. A platform super
 * admin and a non-member are never covered.
 */
export function policyCovers(
  policy: ApprovalPolicy,
  role: WorkspaceRole | 'SUPER_ADMIN' | null,
): boolean {
  if (role === null || role === 'SUPER_ADMIN') return false;
  switch (policy) {
    case 'everyone':
      return true;
    case 'members':
      return role === 'MEMBER' || role === 'GUEST';
    default:
      return false;
  }
}

/**
 * Reads the workspace approval policy for a post's author. Used when a draft
 * is first saved (a covered author's draft starts out needing approval), by
 * the approval view (an approver cannot switch a policy request off while the
 * policy still covers its author) and by the schedule and publish paths (a
 * covered author's post with no approval request is refused).
 */
@Injectable()
export class ApprovalPolicyService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DbType,
    private readonly roles: WorkspaceRoleService,
  ) {}

  async coversAuthor(workspaceId: string, userId: string): Promise<boolean> {
    const [ws] = await this.db
      .select({ approvalPolicy: workspace.approvalPolicy })
      .from(workspace)
      .where(eq(workspace.id, workspaceId))
      .limit(1);
    if (!ws || ws.approvalPolicy === 'none') return false;
    const role = await this.roles.getRole(workspaceId, userId);
    return policyCovers(ws.approvalPolicy, role);
  }
}
