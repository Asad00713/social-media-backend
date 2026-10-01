import { z } from 'zod';
import type { TavilyService } from '../../ai/services/tavily.service';
import type { AgentToolDefinition } from '../maestro.types';

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function createWebTools(
  tavily: TavilyService,
): AgentToolDefinition[] {
  return [
    {
      name: 'web_search',
      description:
        `Search the live web. USE IT WHENEVER: the user says to search / google / look something up (always, even if you think you know); the answer could have changed since your training cutoff (news, prices, releases, "latest", "current", "today", this year, "did X happen yet"); a platform fact that moves (character limits, aspect ratios, API or policy changes); a person, product, company, tool or term you cannot confidently place; or the user wants a picture of a real-world subject (type: "images"). DO NOT use it for the user's own workspace data (other tools cover posts, channels, campaigns, inbox, library, schedule), for writing captions or hashtags, or for stable general knowledge. Search before answering, never after. Returns source results (and optionally web images). Summarise in your own words and cite with [1], [2] — the UI shows the sources. IMPORTANT: web images are NOT licensed for publishing; for post images use search_media (Unsplash/Pexels) instead, and tell the user so.`,
      inputSchema: {
        query: z.string().describe('The web search query.'),
        type: z
          .enum(['info', 'images', 'any'])
          .optional()
          .describe(
            '"info" for answers (default), "images" to show web images, "any" for both.',
          ),
        maxResults: z
          .number()
          .optional()
          .describe('Max text results (1-8). Default 5.'),
      },
      handler: async (args) => {
        const query = String(args.query || '').trim();
        const type = (['info', 'images', 'any'] as const).includes(
          args.type as 'info' | 'images' | 'any',
        )
          ? (args.type as 'info' | 'images' | 'any')
          : 'info';
        const maxResults = Math.min(Math.max(Number(args.maxResults) || 5, 1), 8);
        const includeImages = type === 'images' || type === 'any';

        const resp = await tavily.search(query, {
          maxResults,
          includeImages,
          searchDepth: 'basic',
        });

        const results = resp.results.slice(0, maxResults).map((r) => ({
          title: r.title,
          url: r.url,
          content: (r.content || '').slice(0, 300),
        }));

        const images = includeImages
          ? resp.images
              .filter((im) => im.url)
              .slice(0, 6)
              .map((im, i) => ({
                id: `web-img-${i}`,
                type: 'image' as const,
                source: 'web' as const,
                thumbnailUrl: im.url,
                fullUrl: im.url,
                width: 0,
                height: 0,
                alt: im.description || '',
                photographer: domainOf(im.url),
                sourceUrl: im.url,
              }))
          : [];

        return { kind: 'web' as const, query, results, images };
      },
    },
  ];
}
