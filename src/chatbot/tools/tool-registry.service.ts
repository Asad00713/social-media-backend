import { Injectable, Logger } from '@nestjs/common';
import { ChatbotTool, ToolContext, ToolResult, toToolDefinition } from './tool.interface';
import { LLMToolDefinition } from '../llm/llm-provider.interface';

/**
 * Tool Registry - manages all available chatbot tools.
 *
 * Tools are registered at module initialization and made available
 * to the agent loop for LLM function calling.
 */
@Injectable()
export class ToolRegistryService {
  private readonly logger = new Logger(ToolRegistryService.name);
  private readonly tools = new Map<string, ChatbotTool>();

  /**
   * Register a single tool.
   */
  register(tool: ChatbotTool): void {
    if (this.tools.has(tool.name)) {
      this.logger.warn(`Tool "${tool.name}" is already registered, overwriting`);
    }
    this.tools.set(tool.name, tool);
    this.logger.log(`Registered tool: ${tool.name}`);
  }

  /**
   * Register multiple tools at once.
   */
  registerMany(tools: ChatbotTool[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  /**
   * Get all tool definitions formatted for LLM consumption.
   */
  getToolDefinitions(): LLMToolDefinition[] {
    return Array.from(this.tools.values()).map(toToolDefinition);
  }

  /**
   * Execute a tool by name with the given parameters.
   */
  async execute(
    toolName: string,
    params: Record<string, any>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const tool = this.tools.get(toolName);

    if (!tool) {
      this.logger.warn(`Tool "${toolName}" not found`);
      return {
        success: false,
        error: `Tool "${toolName}" is not available`,
      };
    }

    // Confirmation gate: if tool requires confirmation and user hasn't confirmed, return prompt
    if (tool.requiresConfirmation && !params.confirmed) {
      const message = tool.confirmationMessage
        ? tool.confirmationMessage(params)
        : `Are you sure you want to ${toolName.replace(/_/g, ' ')}? This action cannot be undone.`;
      return {
        success: true,
        data: {
          requires_confirmation: true,
          confirmation_message: message,
          tool_name: toolName,
          params,
        },
      };
    }

    const startTime = Date.now();
    try {
      const result = await tool.execute(params, context);
      const durationMs = Date.now() - startTime;
      this.logger.log(
        JSON.stringify({
          event: 'tool_execution',
          tool: toolName,
          userId: context.userId,
          workspaceId: context.workspaceId,
          success: result.success,
          durationMs,
        }),
      );
      return result;
    } catch (error) {
      const durationMs = Date.now() - startTime;
      this.logger.error(
        JSON.stringify({
          event: 'tool_execution',
          tool: toolName,
          userId: context.userId,
          workspaceId: context.workspaceId,
          success: false,
          durationMs,
          error: error instanceof Error ? error.message : 'Unknown error',
        }),
      );
      return {
        success: false,
        error: `Failed to execute "${toolName}": ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }

  /**
   * Get a human-readable description of what a tool does.
   * Used for the "thinking step" display.
   */
  getToolDisplayName(toolName: string): string {
    const displayNames: Record<string, string> = {
      get_user_profile: 'Looking up your profile',
      get_workspace_info: 'Fetching workspace details',
      list_posts: 'Checking your posts',
      get_post: 'Fetching post details',
      create_post: 'Creating a new post',
      update_post: 'Updating the post',
      delete_post: 'Deleting the post',
      list_scheduled_posts: 'Checking scheduled posts',
      list_channels: 'Looking up connected channels',
      get_channel_details: 'Fetching channel details',
      navigate_to_page: 'Navigating to page',
      change_theme: 'Changing theme',
      web_search: 'Searching the web',
      search_unsplash: 'Searching Unsplash for images',
      search_pexels: 'Searching Pexels for media',
      search_google_drive: 'Searching Google Drive',
      search_onedrive: 'Searching OneDrive',
      search_dropbox: 'Searching Dropbox',
      search_google_photos: 'Browsing Google Photos',
      search_media_library: 'Searching media library',
      download_media: 'Preparing download',
    };

    return displayNames[toolName] || `Using ${toolName}`;
  }

  /**
   * Check if a tool is registered.
   */
  has(toolName: string): boolean {
    return this.tools.has(toolName);
  }

  /**
   * Get count of registered tools.
   */
  get count(): number {
    return this.tools.size;
  }
}
