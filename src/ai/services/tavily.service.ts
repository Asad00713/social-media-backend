import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { tavily } from '@tavily/core';

export interface TavilySearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
  publishedDate?: string;
}

export interface TavilyImage {
  url: string;
  description?: string;
}

export interface TavilySearchResponse {
  query: string;
  results: TavilySearchResult[];
  images: TavilyImage[];
  searchedAt: string;
  responseTime: number;
}

@Injectable()
export class TavilyService {
  private readonly logger = new Logger(TavilyService.name);
  private client: ReturnType<typeof tavily>;

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.get<string>('TAVILY_API_KEY');
    if (!apiKey) {
      this.logger.warn('TAVILY_API_KEY not configured. Web search will not work.');
    } else {
      this.client = tavily({ apiKey });
    }
  }

  /**
   * Search the web for content related to a topic
   * @param query Search query
   * @param options Search options
   */
  async search(
    query: string,
    options?: {
      maxResults?: number;
      searchDepth?: 'basic' | 'advanced';
      includeImages?: boolean;
      includeDomains?: string[];
      excludeDomains?: string[];
      topic?: 'general' | 'news';
    },
  ): Promise<TavilySearchResponse> {
    if (!this.client) {
      throw new Error('Tavily API key not configured');
    }

    const startTime = Date.now();

    try {
      this.logger.log(`Searching Tavily: "${query}"`);

      const includeImages = options?.includeImages ?? true; // Default to true now

      const response = await this.client.search(query, {
        maxResults: options?.maxResults || 5,
        searchDepth: options?.searchDepth || 'basic',
        includeImages,
        includeImageDescriptions: includeImages, // Get descriptions when including images
        includeDomains: options?.includeDomains,
        excludeDomains: options?.excludeDomains,
        topic: options?.topic || 'general',
      });

      const results: TavilySearchResult[] = response.results.map((r) => ({
        title: r.title,
        url: r.url,
        content: r.content,
        score: r.score,
        publishedDate: r.publishedDate,
      }));

      // Extract images from response
      const images: TavilyImage[] = (response.images || []).map((img) => {
        // Handle both string URLs and object format
        if (typeof img === 'string') {
          return { url: img };
        }
        return {
          url: img.url,
          description: img.description,
        };
      });

      const responseTime = Date.now() - startTime;
      this.logger.log(
        `Tavily search completed in ${responseTime}ms, found ${results.length} results and ${images.length} images`,
      );

      return {
        query,
        results,
        images,
        searchedAt: new Date().toISOString(),
        responseTime,
      };
    } catch (error) {
      this.logger.error(`Tavily search failed: ${error}`);
      throw error;
    }
  }

  /**
   * Search for news related to a niche/topic
   * Optimized for finding fresh, trending content
   */
  async searchNews(
    niche: string,
    options?: {
      maxResults?: number;
      additionalKeywords?: string[];
    },
  ): Promise<TavilySearchResponse> {
    // Build a news-focused query
    const keywords = options?.additionalKeywords || [];
    const query = `${niche} latest news today ${keywords.join(' ')}`.trim();

    return this.search(query, {
      maxResults: options?.maxResults || 5,
      searchDepth: 'basic',
      topic: 'news',
      // Exclude social media to get original sources
      excludeDomains: ['twitter.com', 'facebook.com', 'instagram.com', 'reddit.com'],
    });
  }

  /**
   * Search for trending topics in a niche
   */
  async searchTrending(
    niche: string,
    options?: {
      maxResults?: number;
    },
  ): Promise<TavilySearchResponse> {
    const query = `${niche} trending topics ${new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}`;

    return this.search(query, {
      maxResults: options?.maxResults || 5,
      searchDepth: 'advanced',
      topic: 'general',
    });
  }

  /**
   * Search for content ideas in a niche
   */
  async searchContentIdeas(
    niche: string,
    platform: string,
    options?: {
      maxResults?: number;
    },
  ): Promise<TavilySearchResponse> {
    const query = `${niche} ${platform} content ideas tips best practices`;

    return this.search(query, {
      maxResults: options?.maxResults || 5,
      searchDepth: 'basic',
      topic: 'general',
    });
  }

  /**
   * Check if the service is properly configured
   */
  isConfigured(): boolean {
    return !!this.client;
  }
}
