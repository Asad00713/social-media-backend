import type { UsersService } from '../../users/users.service';
import type { WorkspaceService } from '../../workspace/workspace.service';
import type { AgentToolDefinition } from '../maestro.types';

/**
 * Phase 1 read-only tools. Each handler closes over the injected services and
 * receives the per-request `ctx` (userId/workspaceId) from the MCP factory.
 */
export function createUserTools(
  usersService: UsersService,
  workspaceService: WorkspaceService,
): AgentToolDefinition[] {
  return [
    {
      name: 'get_user_profile',
      description:
        "Get the current user's profile: name, email, role and join date. Use when the user asks about their account, name, email, or role.",
      inputSchema: {},
      handler: async (_args, ctx) => {
        const user = await usersService.findOne(ctx.userId);
        return {
          name: user.name,
          email: user.email,
          role: user.role,
          createdAt: user.createdAt,
        };
      },
    },
    {
      name: 'get_workspace_info',
      description:
        "Get the current workspace: name, description, timezone and creation date. Use when the user asks about their workspace or team.",
      inputSchema: {},
      handler: async (_args, ctx) => {
        const ws = await workspaceService.findOne(ctx.workspaceId, ctx.userId);
        return {
          name: ws.name,
          slug: ws.slug,
          description: ws.description,
          timezone: ws.timezone,
          createdAt: ws.createdAt,
        };
      },
    },
  ];
}
