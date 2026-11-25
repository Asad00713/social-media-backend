import { NotFoundException } from '@nestjs/common';
import type { Capability } from '../../workspace-members/role-capabilities';
import type { WorkspaceAccessService } from '../../workspace-members/workspace-access.service';
import type { CallerRole } from '../../workspace-members/caller-role';
import type { ToolContext } from './tool.interface';

/**
 * Run a WRITE tool's workspace check and hand back the caller's role.
 *
 * The role is handed on to the service, which no longer branches on it: the
 * capability check here is the whole gate (a Viewer has no posts:draft, so
 * they never get this far).
 *
 * Throws a plain Error with a readable message: every chatbot tool wraps its
 * body in try/catch and returns `{ success: false, error }`, so the model sees
 * the refusal as a normal tool result and can explain it, rather than the
 * stream ending.
 */
export async function assertToolAccess(
  access: Pick<WorkspaceAccessService, 'assertCan'>,
  context: ToolContext,
  capability: Capability,
): Promise<CallerRole> {
  try {
    return await access.assertCan(
      context.workspaceId,
      context.userId,
      capability,
    );
  } catch (err) {
    if (err instanceof NotFoundException) {
      throw new Error(
        'Your role in this workspace does not allow this action. Ask a workspace admin to change your role.',
      );
    }
    throw err;
  }
}
