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
import {
  ACTIVATION_NEEDS_APPROVER_MESSAGE,
  approvalRequiredByPolicy,
} from '../../lib/draft-approval';

/**
 * Whether the workspace approval policy (`workspace.approval_policy`, 0089)
 * covers someone holding this role: `members` covers MEMBER and GUEST,
 * `everyone` covers ADMIN, MEMBER and GUEST, `none` nobody. The OWNER is
 * never covered (controller ruling: a workspace always keeps someone who can
 * publish without asking), nor are a platform super admin and a non-member.
 */
export function policyCovers(
  policy: ApprovalPolicy,
  role: WorkspaceRole | 'SUPER_ADMIN' | null,
): boolean {
  if (role === null || role === 'SUPER_ADMIN' || role === 'OWNER') {
    return false;
  }
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
 * policy still covers its author), by every path that schedules or publishes
 * a post (a covered author's post with no approval request is refused) and by
 * the campaign, evergreen and drip activation paths (a covered person cannot
 * set posts going out at all: those posts have no per-post approval).
 *
 * The file lives under composer/ for history; PostsModule provides and
 * exports it, so PostService, the composer and the campaign modules share it.
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

  /**
   * Refuses (403 `APPROVAL_REQUIRED_BY_POLICY`) a covered person's campaign,
   * evergreen or drip activation. Call before the first write.
   */
  async assertMayActivate(workspaceId: string, userId: string): Promise<void> {
    if (await this.coversAuthor(workspaceId, userId)) {
      throw approvalRequiredByPolicy(ACTIVATION_NEEDS_APPROVER_MESSAGE);
    }
  }
}
