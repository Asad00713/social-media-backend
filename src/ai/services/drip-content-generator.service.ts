import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Groq from 'groq-sdk';
import { TavilyService, TavilySearchResponse, TavilyImage } from './tavily.service';
import { SupportedPlatform } from '../../drizzle/schema/channels.schema';

export interface GeneratedDripContent {
  // Main content (generic)
  mainContent: string;

  // Platform-specific content
  platformContent: Record<
    string,
    {
      text: string;
      hashtags: string[];
      characterCount: number;
    }
  >;

  // Search results used
  searchResults: TavilySearchResponse;

  // Images from web search (related to the niche/news)
  images: TavilyImage[];

  // Metadata
  generatedAt: string;
  niche: string;
  tone: string;
}

export interface DripContentOptions {
  niche: string;
  targetPlatforms: SupportedPlatform[];
  tone?: string;
  language?: string;
  additionalPrompt?: string;
  date?: Date; // For date-specific content like "today's news"
}

// Platform-specific character limits and best practices
const PLATFORM_CONFIG: Record<
  string,
  {
    maxLength: number;
    hashtagCount: number;
    style: string;
  }
> = {
  twitter: {
    maxLength: 280,
    hashtagCount: 3,
    style: 'concise, punchy, conversational with emojis',
  },
  facebook: {
    maxLength: 500,
    hashtagCount: 3,
    style: 'engaging, storytelling, can be longer form',
  },
  instagram: {
    maxLength: 2200,
    hashtagCount: 10,
    style: 'visual-focused, lifestyle, use emojis and line breaks',
  },
  linkedin: {
    maxLength: 1300,
    hashtagCount: 5,
    style: 'professional, insightful, thought leadership',
  },
  pinterest: {
    maxLength: 500,
    hashtagCount: 5,
    style: 'inspirational, actionable tips, lifestyle focused',
  },
  tiktok: {
    maxLength: 150,
    hashtagCount: 5,
    style: 'trendy, casual, Gen-Z friendly with emojis',
  },
  youtube: {
    maxLength: 500,
    hashtagCount: 3,
    style: 'descriptive for video content, SEO-friendly',
  },
  threads: {
    maxLength: 500,
    hashtagCount: 3,
    style: 'conversational, authentic, Twitter-like',
  },
};

@Injectable()
export class DripContentGeneratorService {
  private readonly logger = new Logger(DripContentGeneratorService.name);
  private groqClient: Groq | null = null;
  private readonly defaultModel = 'llama-3.3-70b-versatile';

  constructor(
    private readonly configService: ConfigService,
    private readonly tavilyService: TavilyService,
  ) {
    const apiKey = this.configService.get<string>('GROQ_API_KEY');
    if (apiKey) {
      this.groqClient = new Groq({ apiKey });
      this.logger.log('DripContentGenerator initialized with Groq');
    } else {
      this.logger.warn('GROQ_API_KEY not configured');
    }
  }

  /**
   * Generate content for a drip post using web search + AI
   * This is the main method called by the drip processor
   */
  async generateDripContent(options: DripContentOptions): Promise<GeneratedDripContent> {
    const { niche, targetPlatforms, tone = 'professional', language = 'en', additionalPrompt, date } = options;

    this.logger.log(`Generating drip content for niche: ${niche}, platforms: ${targetPlatforms.join(', ')}`);

    // Step 1: Search for fresh content
    const searchResults = await this.searchForContent(niche, date);

    // Step 2: Generate platform-specific content
    const platformContent: GeneratedDripContent['platformContent'] = {};

    for (const platform of targetPlatforms) {
      const content = await this.generatePlatformContent({
        niche,
        platform,
        searchResults,
        tone,
        language,
        additionalPrompt,
      });

      platformContent[platform] = content;
    }

    // Step 3: Generate main content (summary)
    const mainContent = this.extractMainContent(platformContent, targetPlatforms[0]);

    return {
      mainContent,
      platformContent,
      searchResults,
      images: searchResults.images || [],
      generatedAt: new Date().toISOString(),
      niche,
      tone,
    };
  }

  /**
   * Search for fresh content related to the niche
   */
  private async searchForContent(niche: string, date?: Date): Promise<TavilySearchResponse> {
    if (!this.tavilyService.isConfigured()) {
      this.logger.warn('Tavily not configured, using fallback');
      return {
        query: niche,
        results: [],
        images: [],
        searchedAt: new Date().toISOString(),
        responseTime: 0,
      };
    }

    try {
      // Search for today's news in this niche
      const dateStr = date ? date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : 'today';

      return await this.tavilyService.searchNews(niche, {
        maxResults: 5,
        additionalKeywords: [dateStr, 'trending', 'latest'],
      });
    } catch (error) {
      this.logger.error(`Search failed: ${error}`);
      return {
        query: niche,
        results: [],
        images: [],
        searchedAt: new Date().toISOString(),
        responseTime: 0,
      };
    }
  }

  /**
   * Generate content for a specific platform
   */
  private async generatePlatformContent(options: {
    niche: string;
    platform: SupportedPlatform;
    searchResults: TavilySearchResponse;
    tone: string;
    language: string;
    additionalPrompt?: string;
  }): Promise<{ text: string; hashtags: string[]; characterCount: number }> {
    const { niche, platform, searchResults, tone, language, additionalPrompt } = options;

    if (!this.groqClient) {
      throw new Error('Groq API not configured');
    }

    const config = PLATFORM_CONFIG[platform] || PLATFORM_CONFIG.twitter;

    // Build context from search results
    const searchContext = searchResults.results.length > 0
      ? searchResults.results
          .slice(0, 3)
          .map((r, i) => `${i + 1}. ${r.title}: ${r.content.substring(0, 200)}...`)
          .join('\n')
      : `General ${niche} content`;

    const systemPrompt = `You are an expert social media content creator specializing in ${niche}.
You create engaging, authentic content that drives engagement.
You always write in ${language}.
Your tone is ${tone}.
You understand platform-specific best practices.`;

    const userPrompt = `Create a ${platform} post about ${niche} based on the latest news/trends.

TODAY'S CONTEXT (use this for fresh, relevant content):
${searchContext}

PLATFORM REQUIREMENTS for ${platform.toUpperCase()}:
- Maximum ${config.maxLength} characters
- Style: ${config.style}
- Include ${config.hashtagCount} relevant hashtags

${additionalPrompt ? `ADDITIONAL INSTRUCTIONS: ${additionalPrompt}` : ''}

IMPORTANT:
- Make it feel authentic and timely, referencing current events/trends
- Don't copy directly, create original content inspired by the news
- Include relevant hashtags at the end
- Stay within the character limit

Respond with ONLY the post content (including hashtags). No explanations or meta-text.`;

    try {
      const completion = await this.groqClient.chat.completions.create({
        model: this.defaultModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.8,
        max_tokens: 500,
      });

      let text = completion.choices[0]?.message?.content?.trim() || '';

      // Extract hashtags
      const hashtagMatches = text.match(/#\w+/g) || [];
      const hashtags = hashtagMatches.slice(0, config.hashtagCount);

      // Ensure within character limit
      if (text.length > config.maxLength) {
        text = this.truncateToLimit(text, config.maxLength);
      }

      return {
        text,
        hashtags,
        characterCount: text.length,
      };
    } catch (error) {
      this.logger.error(`Failed to generate content for ${platform}: ${error}`);
      throw error;
    }
  }

  /**
   * Truncate text to fit within character limit while preserving hashtags
   */
  private truncateToLimit(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;

    // Extract hashtags
    const hashtagMatches = text.match(/#\w+/g) || [];
    const hashtags = hashtagMatches.slice(0, 3).join(' ');

    // Remove hashtags from text to calculate available space
    let mainText = text.replace(/#\w+/g, '').trim();

    // Calculate available space for main text
    const availableSpace = maxLength - hashtags.length - 4; // 4 for spacing

    if (mainText.length > availableSpace) {
      mainText = mainText.substring(0, availableSpace - 3) + '...';
    }

    return `${mainText}\n\n${hashtags}`.trim();
  }

  /**
   * Extract main content from platform content
   */
  private extractMainContent(
    platformContent: GeneratedDripContent['platformContent'],
    primaryPlatform: SupportedPlatform,
  ): string {
    // Use the primary platform's content as main content
    const primary = platformContent[primaryPlatform];
    if (primary) {
      return primary.text;
    }

    // Fallback to first available
    const firstPlatform = Object.keys(platformContent)[0];
    return platformContent[firstPlatform]?.text || '';
  }

  /**
   * Regenerate content for a specific platform (for user retries)
   */
  async regeneratePlatformContent(
    options: DripContentOptions & { platform: SupportedPlatform },
    existingSearchResults?: TavilySearchResponse,
  ): Promise<{ text: string; hashtags: string[]; characterCount: number }> {
    const searchResults = existingSearchResults || (await this.searchForContent(options.niche, options.date));

    return this.generatePlatformContent({
      niche: options.niche,
      platform: options.platform,
      searchResults,
      tone: options.tone || 'professional',
      language: options.language || 'en',
      additionalPrompt: options.additionalPrompt,
    });
  }

  /**
   * Check if the service is ready
   */
  isReady(): boolean {
    return this.groqClient !== null && this.tavilyService.isConfigured();
  }

  /**
   * Check if minimal service is available (AI without search)
   */
  isMinimallyReady(): boolean {
    return this.groqClient !== null;
  }
}
