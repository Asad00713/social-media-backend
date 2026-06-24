import type { UsersService } from '../../users/users.service';
import type { WorkspaceService } from '../../workspace/workspace.service';
import { ChatbotTool, ToolContext, ToolResult } from './tool.interface';

export function createUserTools(
  usersService: UsersService,
  workspaceService: WorkspaceService,
): ChatbotTool[] {
  return [
    {
      name: 'get_user_profile',
      description:
        "Get the current user's profile information including name, email, and role. Use this when the user asks about their account, name, email, or profile.",
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
      execute: async (
        _params: Record<string, any>,
        context: ToolContext,
      ): Promise<ToolResult> => {
        try {
          const user = await usersService.findOne(context.userId);
          return {
            success: true,
            data: {
              name: user.name,
              email: user.email,
              role: user.role,
              createdAt: user.createdAt,
            },
          };
        } catch (error) {
          return {
            success: false,
            error: `Failed to fetch user profile: ${error instanceof Error ? error.message : 'Unknown error'}`,
          };
        }
      },
    },
    {
      name: 'get_workspace_info',
      description:
        'Get the current workspace details including name, description, timezone, and creation date. Use this when the user asks about their workspace or team settings.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
      execute: async (
        _params: Record<string, any>,
        context: ToolContext,
      ): Promise<ToolResult> => {
        try {
          const workspace = await workspaceService.findOne(
            context.workspaceId,
            context.userId,
          );
          return {
            success: true,
            data: {
              name: workspace.name,
              slug: workspace.slug,
              description: workspace.description,
              timezone: workspace.timezone,
              createdAt: workspace.createdAt,
            },
          };
        } catch (error) {
          return {
            success: false,
            error: `Failed to fetch workspace info: ${error instanceof Error ? error.message : 'Unknown error'}`,
          };
        }
      },
    },
  ];
}
