import type { TavilyService } from '../../ai/services/tavily.service';
import { ChatbotTool, ToolContext, ToolResult } from './tool.interface';

export function createWebSearchTools(tavilyService: TavilyService): ChatbotTool[] {
  return [
    {
      name: 'web_search',
      description:
        'Search the web for current, up-to-date information. Use this when the user asks about trending topics, news, social media best practices, competitor analysis, content ideas, or anything that requires live information beyond what\'s stored in the app.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query',
          },
          maxResults: {
            type: 'number',
            description: 'Maximum number of results to return (default: 5, max: 10)',
          },
        },
        required: ['query'],
      },
      execute: async (params: Record<string, any>, _context: ToolContext): Promise<ToolResult> => {
        try {
          if (!tavilyService.isConfigured()) {
            return {
              success: false,
              error: 'Web search is not configured. TAVILY_API_KEY is missing.',
            };
          }

          const maxResults = Math.min(params.maxResults || 5, 10);
          const response = await tavilyService.search(params.query, { maxResults });

          return {
            success: true,
            data: {
              query: response.query,
              results: response.results.map((r) => ({
                title: r.title,
                url: r.url,
                content: r.content,
              })),
              images: response.images.map((img) => ({
                url: img.url,
                description: img.description,
              })),
            },
          };
        } catch (error) {
          return {
            success: false,
            error: `Web search failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
          };
        }
      },
    },
  ];
}
